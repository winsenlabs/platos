import { Injectable, Inject, Logger } from "@nestjs/common";
import { PRISMA_TOKEN } from "../shared/database.provider";
import { ScopedEnvService } from "../providers/scoped-env.service";
import type { RequestScope } from "../auth/scope.guard";
import type { ParsedSkill, SkillManifest, SkillProvidedTool } from "./skill-manifest.types";
import { parseSkill } from "./skill-manifest.parser";

export type ScopeTuple = Pick<RequestScope, "organizationId" | "projectId" | "environmentId">;

export interface SkillRecord {
  id: string;
  skillId: string;
  name: string;
  description: string;
  version: string;
  author: string | null;
  origin: string;
  isOfficial: boolean;
  tags: string[];
  promptBlock: string;
  providesTools: SkillProvidedTool[];
  requiredEnv: string[];
  optionalEnv: string[];
  importedFrom: string | null;
  /** All required_env set in the provided scope? (null when scope not supplied.) */
  envReady: boolean | null;
  /** Per-var set map — for the install UI. */
  envSetMap: Record<string, boolean>;
  /**
   * TL.1 — resolved display category. Populated from the manifest's
   * `category` frontmatter field when present; otherwise derived from the
   * skill slug (the portion after the namespace dot, split on `-`) so
   * `platos.web-search` → `web`. Used by the Tools tab + TL.2 display modes.
   */
  category: string;
  createdAt: string;
  updatedAt: string;
}

export interface AgentSkillRecord extends SkillRecord {
  /** PlatosAgentSkill row id. */
  agentSkillId: string;
  enabled: boolean;
  enabledAt: string;
}

/**
 * Theme S — Skill registry.
 *
 * - Official skills live at organization scope (projectId/environmentId NULL)
 *   and are visible to every project/env in the org.
 * - Custom/community skills are always registered at the full scope tuple.
 *
 * Enablement path (invariant per THEME_S §5):
 *   1. Caller supplies the target agent's scope.
 *   2. We look up the PlatosSkill row using scope-aware fallback (official OR
 *      exact scope match).
 *   3. We verify every `requiredEnv` var is set in the target env.
 *   4. Only on success do we insert the PlatosAgentSkill row.
 *
 * The runtime merge (prompt-block + tool catalog) is in
 * `SkillRuntimeService` to keep this service focused on CRUD + validation.
 */
@Injectable()
export class SkillRegistryService {
  private readonly logger = new Logger(SkillRegistryService.name);

  constructor(
    @Inject(PRISMA_TOKEN) private readonly prisma: any,
    private readonly scopedEnv: ScopedEnvService,
  ) {}

  // ──────────────────────────────────────────────────────────────────────────
  // Registry CRUD
  // ──────────────────────────────────────────────────────────────────────────

  /**
   * List all skills visible in a scope — official org-level rows + rows with
   * matching (projectId, environmentId). Returns envReady per-scope so the UI
   * can show "Set" vs "Not set" badges.
   */
  async list(scope: ScopeTuple): Promise<SkillRecord[]> {
    const rows = await this.prisma.platosSkill.findMany({
      where: {
        organizationId: scope.organizationId,
        OR: [
          { isOfficial: true, projectId: null, environmentId: null },
          { projectId: scope.projectId, environmentId: scope.environmentId },
        ],
      },
      orderBy: [{ isOfficial: "desc" }, { skillId: "asc" }],
    });
    return Promise.all(rows.map((r: any) => this.hydrate(scope, r)));
  }

  /** Fetch a single skill visible in the scope by its database row id. */
  async get(scope: ScopeTuple, id: string): Promise<SkillRecord | null> {
    const row = await this.prisma.platosSkill.findFirst({
      where: {
        id,
        organizationId: scope.organizationId,
        OR: [
          { isOfficial: true, projectId: null, environmentId: null },
          { projectId: scope.projectId, environmentId: scope.environmentId },
        ],
      },
    });
    if (!row) return null;
    return this.hydrate(scope, row);
  }

  /**
   * MCPF-followup — fetch a skill by its row id OR its manifest slug
   * (e.g. `platos.code_execution`). Used by the MCP `skills.get` tool
   * because `skills.list` exposes the slug as the `skillId` field, so
   * callers naturally feed the slug back in. The id-only path was a
   * silent footgun.
   */
  async getBySlugOrId(scope: ScopeTuple, idOrSlug: string): Promise<SkillRecord | null> {
    // Try the id-keyed lookup first to keep the common path fast.
    const byId = await this.get(scope, idOrSlug);
    if (byId) return byId;
    const row = await this.prisma.platosSkill.findFirst({
      where: {
        skillId: idOrSlug,
        organizationId: scope.organizationId,
        OR: [
          { isOfficial: true, projectId: null, environmentId: null },
          { projectId: scope.projectId, environmentId: scope.environmentId },
        ],
      },
    });
    if (!row) return null;
    return this.hydrate(scope, row);
  }

  /**
   * Register a skill in the given scope from its parsed manifest.
   *
   * - Official skills (`isOfficial: true`) are stored with projectId +
   *   environmentId NULL. Call sites supply the org only.
   * - Custom/community skills use the full scope tuple from `scope`.
   *
   * Upsert semantics: re-registering the same skillId in the same scope
   * overwrites `source`, `manifest`, `promptBlock`, and related fields so
   * the library UI can hot-patch a skill.
   */
  async register(
    scope: ScopeTuple,
    parsed: ParsedSkill,
    opts?: { origin?: "official" | "community" | "custom"; isOfficial?: boolean },
  ): Promise<SkillRecord> {
    const origin = opts?.origin ?? (parsed.manifest.origin as any) ?? "custom";
    const isOfficial = opts?.isOfficial ?? origin === "official";

    const data = {
      organizationId: scope.organizationId,
      projectId: isOfficial ? null : scope.projectId,
      environmentId: isOfficial ? null : scope.environmentId,
      skillId: parsed.manifest.id,
      name: parsed.manifest.name,
      description: parsed.manifest.description,
      version: parsed.manifest.version,
      author: parsed.manifest.author ?? null,
      origin,
      isOfficial,
      tags: parsed.manifest.tags ?? [],
      source: parsed.source,
      manifest: parsed.manifest as any,
      promptBlock: parsed.promptBlock,
      providesTools: (parsed.manifest.provides_tools ?? []) as any,
      requiredEnv: parsed.manifest.required_env ?? [],
      optionalEnv: parsed.manifest.optional_env ?? [],
      importedFrom: parsed.manifest.importedFrom ?? null,
    };

    // Can't use upsert-by-composite-unique when any field is NULL (Prisma's
    // generated index treats NULLs as distinct even under NULLS NOT DISTINCT).
    // Do a manual findFirst + create/update to keep the semantics portable.
    const existing = await this.prisma.platosSkill.findFirst({
      where: {
        organizationId: data.organizationId,
        projectId: data.projectId,
        environmentId: data.environmentId,
        skillId: data.skillId,
      },
    });
    const row = existing
      ? await this.prisma.platosSkill.update({
          where: { id: existing.id },
          data: {
            name: data.name,
            description: data.description,
            version: data.version,
            author: data.author,
            origin: data.origin,
            tags: data.tags,
            source: data.source,
            manifest: data.manifest,
            promptBlock: data.promptBlock,
            providesTools: data.providesTools,
            requiredEnv: data.requiredEnv,
            optionalEnv: data.optionalEnv,
            importedFrom: data.importedFrom,
          },
        })
      : await this.prisma.platosSkill.create({ data });
    return this.hydrate(scope, row);
  }

  /** Delete a skill from a scope (also cascades PlatosAgentSkill rows). */
  async remove(scope: ScopeTuple, id: string): Promise<void> {
    // Only allow removing skills the scope owns — refuse to delete official
    // org-level rows from a project-scoped caller.
    await this.prisma.platosSkill.deleteMany({
      where: {
        id,
        organizationId: scope.organizationId,
        projectId: scope.projectId,
        environmentId: scope.environmentId,
      },
    });
  }

  // ──────────────────────────────────────────────────────────────────────────
  // Per-agent enablement
  // ──────────────────────────────────────────────────────────────────────────

  /** Enable a skill on an agent. Fails fast if required_env isn't set. */
  async enableForAgent(
    scope: ScopeTuple,
    agentId: string,
    skillRowId: string,
  ): Promise<AgentSkillRecord> {
    const agent = await this.prisma.platosAgent.findFirst({
      where: {
        id: agentId,
        organizationId: scope.organizationId,
        projectId: scope.projectId,
        environmentId: scope.environmentId,
      },
    });
    if (!agent) {
      throw new SkillEnableError(
        "Agent not found in this scope.",
        "agent_not_found",
      );
    }

    const skill = await this.get(scope, skillRowId);
    if (!skill) {
      throw new SkillEnableError(
        "Skill not registered in this scope.",
        "skill_not_found",
      );
    }

    // Invariant: required_env must be set in the target agent's env — never
    // short-circuit at runtime.
    const envSet = await this.scopedEnv.setMap(scope, skill.requiredEnv);
    const missing = skill.requiredEnv.filter((k) => !envSet[k]);
    if (missing.length > 0) {
      throw new SkillEnableError(
        `Cannot enable skill "${skill.skillId}" — missing env vars: ${missing.join(", ")}`,
        "missing_env",
        { missing },
      );
    }

    const row = await this.prisma.platosAgentSkill.upsert({
      where: { agentId_skillId: { agentId, skillId: skillRowId } },
      create: {
        agentId,
        skillId: skillRowId,
        organizationId: scope.organizationId,
        projectId: scope.projectId,
        environmentId: scope.environmentId,
        enabled: true,
      },
      update: { enabled: true },
    });

    return {
      ...skill,
      agentSkillId: row.id,
      enabled: row.enabled,
      enabledAt: row.enabledAt.toISOString(),
    };
  }

  /** Turn off an enabled skill on an agent (soft — row retained). */
  async disableForAgent(scope: ScopeTuple, agentId: string, skillRowId: string): Promise<void> {
    await this.prisma.platosAgentSkill.updateMany({
      where: {
        agentId,
        skillId: skillRowId,
        organizationId: scope.organizationId,
        projectId: scope.projectId,
        environmentId: scope.environmentId,
      },
      data: { enabled: false },
    });
  }

  /** Fully remove a skill from an agent. */
  async removeFromAgent(scope: ScopeTuple, agentId: string, skillRowId: string): Promise<void> {
    await this.prisma.platosAgentSkill.deleteMany({
      where: {
        agentId,
        skillId: skillRowId,
        organizationId: scope.organizationId,
        projectId: scope.projectId,
        environmentId: scope.environmentId,
      },
    });
  }

  /** List skills enabled on an agent (for the builder/editor UI). */
  async listForAgent(scope: ScopeTuple, agentId: string): Promise<AgentSkillRecord[]> {
    const rows = await this.prisma.platosAgentSkill.findMany({
      where: {
        agentId,
        organizationId: scope.organizationId,
        projectId: scope.projectId,
        environmentId: scope.environmentId,
      },
      include: { skill: true },
      // PROMPT-CACHE DETERMINISM (audit finding 9). This list drives both the
      // order skill tools are appended to the `tools` object and the order of
      // skill prompt blocks inside "## Enabled Skills". Without an explicit
      // orderBy, Postgres returns heap order, which CHANGES when any row is
      // updated (e.g. toggling `enabled`). Two consecutive turns then emit the
      // same tools in a different byte order, which invalidates the whole
      // Anthropic cache prefix (tools -> system -> messages) for no reason.
      orderBy: [{ skillId: "asc" }],
    });
    const out: AgentSkillRecord[] = [];
    for (const r of rows) {
      const hydrated = await this.hydrate(scope, r.skill);
      out.push({
        ...hydrated,
        agentSkillId: r.id,
        enabled: r.enabled,
        enabledAt: r.enabledAt.toISOString(),
      });
    }
    return out;
  }

  /** Runtime load — ONLY enabled skills whose env is still ready. */
  async loadActiveForAgent(scope: ScopeTuple, agentId: string): Promise<AgentSkillRecord[]> {
    const enabled = await this.listForAgent(scope, agentId);
    const active: AgentSkillRecord[] = [];
    for (const s of enabled) {
      if (!s.enabled) continue;
      // Re-check env at load-time — env vars can be removed after enable.
      // If anything is missing we skip the skill (and log) rather than fail
      // the whole turn: the agent can still function without it.
      if (s.requiredEnv.length > 0) {
        const set = await this.scopedEnv.setMap(scope, s.requiredEnv);
        if (s.requiredEnv.some((k) => !set[k])) {
          this.logger.warn(
            `Skill ${s.skillId} enabled on agent ${agentId} but env is no longer ready — skipping.`,
          );
          continue;
        }
      }
      active.push(s);
    }
    return active;
  }

  // ──────────────────────────────────────────────────────────────────────────
  // Helpers
  // ──────────────────────────────────────────────────────────────────────────

  /** Parse a raw skill source string and register it in the scope. */
  async registerFromSource(
    scope: ScopeTuple,
    source: string,
    opts?: { importedFrom?: string; origin?: "official" | "community" | "custom"; isOfficial?: boolean },
  ): Promise<SkillRecord> {
    const parseOpts = opts?.importedFrom ? { importedFrom: opts.importedFrom } : {};
    const parsed = parseSkill(source, parseOpts);
    const regOpts: { origin?: "official" | "community" | "custom"; isOfficial?: boolean } = {};
    if (opts?.origin !== undefined) regOpts.origin = opts.origin;
    if (opts?.isOfficial !== undefined) regOpts.isOfficial = opts.isOfficial;
    return this.register(scope, parsed, regOpts);
  }

  // ──────────────────────────────────────────────────────────────────────────
  // MCPF-W5 — partial update, global disable, usage stats.
  // ──────────────────────────────────────────────────────────────────────────

  /**
   * Partial-patch update of a skill row. Only safe metadata fields can be
   * patched here — `name`, `description`, `tags`. `source` / `promptBlock` /
   * `manifest` / `providesTools` / `requiredEnv` / `version` are NOT
   * patchable, because re-registering with new prompt content + provided
   * tools is a different operation that callers should reach via
   * `register` / `registerFromSource`.
   *
   * Scope-filter: the row must be either an official skill in the same org
   * (`projectId IS NULL AND environmentId IS NULL`) or a project/env-scoped
   * skill in the caller's exact scope. Cross-scope id probes return `null`.
   */
  async updateSkill(
    scope: ScopeTuple,
    id: string,
    patch: { name?: string; description?: string; tags?: string[] },
  ): Promise<SkillRecord | null> {
    const data: Record<string, unknown> = {};
    if (patch.name !== undefined) data.name = patch.name;
    if (patch.description !== undefined) data.description = patch.description;
    if (patch.tags !== undefined) data.tags = patch.tags ?? [];

    if (Object.keys(data).length === 0) {
      // Nothing to patch — fast-path: just refetch + return.
      return this.get(scope, id);
    }

    const result = await this.prisma.platosSkill.updateMany({
      where: {
        id,
        organizationId: scope.organizationId,
        OR: [
          { isOfficial: true, projectId: null, environmentId: null },
          { projectId: scope.projectId, environmentId: scope.environmentId },
        ],
      },
      data,
    });
    if (result.count === 0) return null;

    return this.get(scope, id);
  }

  /**
   * Set `enabled=false` on every `PlatosAgentSkill` row in the scope that
   * links the given skill. Returns the count of rows flipped (= number of
   * agents that had this skill active immediately before the call).
   *
   * Used by the operator workflow "this skill is broken / leaking PII —
   * turn it off everywhere immediately" without removing the per-agent
   * row (so re-enable later restores prior config). Idempotent: re-running
   * after every agent is already disabled returns `affectedAgentCount: 0`.
   */
  async disableSkillGlobally(
    scope: ScopeTuple,
    skillId: string,
  ): Promise<{ affectedAgentCount: number }> {
    const result = await this.prisma.platosAgentSkill.updateMany({
      where: {
        skillId,
        organizationId: scope.organizationId,
        projectId: scope.projectId,
        environmentId: scope.environmentId,
        enabled: true,
      },
      data: { enabled: false },
    });
    return { affectedAgentCount: result.count };
  }

  /**
   * Fetch the (currently always-null) per-agent skill config row plus
   * the underlying skill record. Returns `null` if either the agent
   * isn't in scope or the skill isn't installed on it.
   *
   * `config` is a `Json?` column reserved for future per-agent knobs
   * (e.g. override default model, set max_results); v1 is always null.
   * Callers should treat it as opaque metadata — it's surfaced so the
   * dashboard / future config UI can show whatever the agent stored.
   */
  async getInstalledConfig(
    scope: ScopeTuple,
    agentId: string,
    skillRowId: string,
  ): Promise<{
    agentSkillId: string;
    enabled: boolean;
    enabledAt: string;
    config: unknown;
    skill: SkillRecord;
  } | null> {
    const row = await this.prisma.platosAgentSkill.findFirst({
      where: {
        agentId,
        skillId: skillRowId,
        organizationId: scope.organizationId,
        projectId: scope.projectId,
        environmentId: scope.environmentId,
      },
      include: { skill: true },
    });
    if (!row) return null;
    const skill = await this.hydrate(scope, row.skill);
    return {
      agentSkillId: row.id,
      enabled: row.enabled,
      enabledAt: row.enabledAt instanceof Date
        ? row.enabledAt.toISOString()
        : new Date(row.enabledAt).toISOString(),
      config: row.config ?? null,
      skill,
    };
  }

  /**
   * Inspect which agents have a given skill installed in the scope.
   * Used as a pre-check by the `skills.uninstall` MCP tool: if any agent
   * still has the skill installed (enabled or not), the uninstall path
   * refuses with `skill_in_use` so the operator can disable it on each
   * agent first.
   */
  async getSkillUsage(
    scope: ScopeTuple,
    skillId: string,
  ): Promise<{ agentCount: number; agents: Array<{ agentId: string; enabled: boolean }> }> {
    const rows = await this.prisma.platosAgentSkill.findMany({
      where: {
        skillId,
        organizationId: scope.organizationId,
        projectId: scope.projectId,
        environmentId: scope.environmentId,
      },
      select: { agentId: true, enabled: true },
    });
    return { agentCount: rows.length, agents: rows };
  }

  private async hydrate(scope: ScopeTuple, row: any): Promise<SkillRecord> {
    const requiredEnv: string[] = row.requiredEnv ?? [];
    const envSetMap =
      requiredEnv.length > 0 ? await this.scopedEnv.setMap(scope, requiredEnv) : {};
    const envReady =
      requiredEnv.length === 0 ? true : requiredEnv.every((k) => !!envSetMap[k]);
    const manifest: SkillManifest = row.manifest;
    return {
      id: row.id,
      skillId: row.skillId,
      name: row.name,
      description: row.description,
      version: row.version,
      author: row.author,
      origin: row.origin,
      isOfficial: row.isOfficial,
      tags: row.tags ?? [],
      promptBlock: row.promptBlock,
      providesTools: (row.providesTools as SkillProvidedTool[]) ?? manifest.provides_tools ?? [],
      requiredEnv,
      optionalEnv: row.optionalEnv ?? [],
      importedFrom: row.importedFrom,
      envReady,
      envSetMap,
      category: deriveSkillCategory(row.skillId, manifest),
      createdAt: row.createdAt.toISOString(),
      updatedAt: row.updatedAt.toISOString(),
    };
  }
}

/**
 * TL.1 — resolve a skill's display category. Precedence:
 *   1. `manifest.category` (author-declared frontmatter field).
 *   2. `slug.split("-")[0]` where slug is the portion after the last
 *      namespace dot — e.g. `platos.web-search` → `web`,
 *      `platos.code_exec` → `code`.
 *   3. Literal `"uncategorized"` when neither yields a value.
 * Exported so Tools tab loaders + TL.2 display-mode resolvers share the
 * derivation instead of re-implementing it client-side.
 */
export function deriveSkillCategory(
  skillId: string,
  manifest: SkillManifest | null | undefined,
): string {
  const declared = manifest?.category?.trim();
  if (declared) return declared;
  const slug = (skillId || "").split(".").pop() ?? "";
  const head = slug.split(/[-_]/)[0]?.trim();
  if (head) return head;
  return "uncategorized";
}

export class SkillEnableError extends Error {
  constructor(
    message: string,
    public readonly reason: string,
    public readonly details?: Record<string, unknown>,
  ) {
    super(message);
    this.name = "SkillEnableError";
  }
}
