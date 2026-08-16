import { Injectable, Inject, Logger } from "@nestjs/common";
import { PRISMA_TOKEN, type ControlDatabaseClient } from "../shared/database.provider";
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
  envReady: boolean | null;
  envSetMap: Record<string, boolean>;
  category: string;
  createdAt: string;
  updatedAt: string;
}

export interface AgentSkillRecord extends SkillRecord {
  agentSkillId: string;
  enabled: boolean;
  enabledAt: string;
}

/** Skill catalog and normalized project/environment/agent-version installs. */
@Injectable()
export class SkillRegistryService {
  private readonly logger = new Logger(SkillRegistryService.name);

  constructor(
    @Inject(PRISMA_TOKEN) private readonly prisma: ControlDatabaseClient,
    private readonly scopedEnv: ScopedEnvService,
  ) {}

  private async resolveScope(scope: ScopeTuple): Promise<ScopeTuple | null> {
    const environment = await this.prisma.environment.findUnique({
      where: { id: scope.environmentId },
      select: {
        id: true,
        project: { select: { id: true, organizationId: true } },
      },
    });
    if (
      !environment ||
      environment.project.id !== scope.projectId ||
      environment.project.organizationId !== scope.organizationId
    ) {
      return null;
    }
    return {
      organizationId: environment.project.organizationId,
      projectId: environment.project.id,
      environmentId: environment.id,
    };
  }

  private visibleWhere(scope: ScopeTuple) {
    return {
      organizationId: scope.organizationId,
      OR: [
        { isOfficial: true },
        {
          projects: {
            some: {
              projectId: scope.projectId,
              environments: { some: { environmentId: scope.environmentId } },
            },
          },
        },
      ],
    };
  }

  async list(scope: ScopeTuple): Promise<SkillRecord[]> {
    const canonical = await this.resolveScope(scope);
    if (!canonical) return [];
    const rows = await this.prisma.skill.findMany({
      where: this.visibleWhere(canonical),
      orderBy: [{ isOfficial: "desc" }, { slug: "asc" }, { version: "desc" }],
    });
    return Promise.all(rows.map((row: any) => this.hydrate(canonical, row)));
  }

  async get(scope: ScopeTuple, id: string): Promise<SkillRecord | null> {
    const canonical = await this.resolveScope(scope);
    if (!canonical) return null;
    const row = await this.prisma.skill.findFirst({
      where: { id, ...this.visibleWhere(canonical) },
    });
    return row ? this.hydrate(canonical, row) : null;
  }

  async getBySlugOrId(scope: ScopeTuple, idOrSlug: string): Promise<SkillRecord | null> {
    const canonical = await this.resolveScope(scope);
    if (!canonical) return null;
    const row = await this.prisma.skill.findFirst({
      where: {
        AND: [
          this.visibleWhere(canonical),
          { OR: [{ id: idOrSlug }, { slug: idOrSlug }] },
        ],
      },
      orderBy: { version: "desc" },
    });
    return row ? this.hydrate(canonical, row) : null;
  }

  async register(
    scope: ScopeTuple,
    parsed: ParsedSkill,
    opts?: { origin?: "official" | "community" | "custom"; isOfficial?: boolean },
  ): Promise<SkillRecord> {
    const origin = opts?.origin ?? (parsed.manifest.origin as any) ?? "custom";
    const isOfficial = opts?.isOfficial ?? origin === "official";
    const canonical = await this.resolveScope(scope);
    if (!canonical) throw new Error("Environment not found in scope");

    const row = await this.upsertSkill(canonical.organizationId, parsed, origin, isOfficial);
    if (!isOfficial) await this.ensureEnvironmentInstall(canonical, row.id);
    return this.hydrate(canonical, row);
  }

  /** Seeder entry point: official catalog rows have Organization ownership only. */
  async registerOfficial(organizationId: string, parsed: ParsedSkill): Promise<SkillRecord> {
    const organization = await this.prisma.organization.findUnique({
      where: { id: organizationId },
      select: { id: true },
    });
    if (!organization) throw new Error("Organization not found");
    const row = await this.upsertSkill(organization.id, parsed, "official", true);
    return this.hydrate(null, row);
  }

  private async upsertSkill(
    organizationId: string,
    parsed: ParsedSkill,
    origin: string,
    isOfficial: boolean,
  ): Promise<any> {
    const manifest = parsed.manifest;
    return this.prisma.skill.upsert({
      where: {
        organizationId_slug_version: {
          organizationId,
          slug: manifest.id,
          version: manifest.version,
        },
      },
      create: {
        organizationId,
        slug: manifest.id,
        name: manifest.name,
        description: manifest.description,
        version: manifest.version,
        author: manifest.author ?? null,
        origin,
        isOfficial,
        tags: manifest.tags ?? [],
        source: parsed.source,
        manifest: manifest as any,
        promptBlock: parsed.promptBlock,
        providesTools: (manifest.provides_tools ?? []) as any,
        requiredEnvironmentKeys: manifest.required_env ?? [],
        optionalEnvironmentKeys: manifest.optional_env ?? [],
      },
      update: {
        name: manifest.name,
        description: manifest.description,
        author: manifest.author ?? null,
        origin,
        isOfficial,
        tags: manifest.tags ?? [],
        source: parsed.source,
        manifest: manifest as any,
        promptBlock: parsed.promptBlock,
        providesTools: (manifest.provides_tools ?? []) as any,
        requiredEnvironmentKeys: manifest.required_env ?? [],
        optionalEnvironmentKeys: manifest.optional_env ?? [],
      },
    });
  }

  private async ensureEnvironmentInstall(scope: ScopeTuple, skillId: string): Promise<any> {
    const projectSkill = await this.prisma.projectSkill.upsert({
      where: { projectId_skillId: { projectId: scope.projectId, skillId } },
      create: { projectId: scope.projectId, skillId, enabled: true },
      update: { enabled: true },
    });
    return this.prisma.environmentSkill.upsert({
      where: {
        environmentId_projectSkillId: {
          environmentId: scope.environmentId,
          projectSkillId: projectSkill.id,
        },
      },
      create: {
        environmentId: scope.environmentId,
        projectSkillId: projectSkill.id,
        enabled: true,
      },
      update: { enabled: true },
    });
  }

  /** Uninstall a custom skill from this Environment without deleting the catalog row. */
  async remove(scope: ScopeTuple, id: string): Promise<void> {
    const canonical = await this.resolveScope(scope);
    if (!canonical) return;
    const skill = await this.prisma.skill.findFirst({
      where: { id, organizationId: canonical.organizationId, isOfficial: false },
      select: { id: true },
    });
    if (!skill) return;
    await this.prisma.environmentSkill.deleteMany({
      where: {
        environmentId: canonical.environmentId,
        projectSkill: { projectId: canonical.projectId, skillId: skill.id },
      },
    });
  }

  private async activeAgentVersion(scope: ScopeTuple, agentId: string): Promise<string | null> {
    const binding = await this.prisma.agentBinding.findFirst({
      where: {
        environmentId: scope.environmentId,
        agentId,
        agent: { projectId: scope.projectId },
      },
      select: { activeAgentVersionId: true },
    });
    return binding?.activeAgentVersionId ?? null;
  }

  private async environmentSkillFor(
    scope: ScopeTuple,
    skillId: string,
    createOfficialLinks: boolean,
  ): Promise<any | null> {
    const skill = await this.prisma.skill.findFirst({
      where: { id: skillId, ...this.visibleWhere(scope) },
      select: { id: true, isOfficial: true },
    });
    if (!skill) return null;
    if (skill.isOfficial && createOfficialLinks) {
      return this.ensureEnvironmentInstall(scope, skill.id);
    }
    return this.prisma.environmentSkill.findFirst({
      where: {
        environmentId: scope.environmentId,
        projectSkill: { projectId: scope.projectId, skillId: skill.id },
      },
    });
  }

  async enableForAgent(
    scope: ScopeTuple,
    agentId: string,
    skillRowId: string,
  ): Promise<AgentSkillRecord> {
    const canonical = await this.resolveScope(scope);
    if (!canonical) {
      throw new SkillEnableError("Agent not found in this scope.", "agent_not_found");
    }
    const agentVersionId = await this.activeAgentVersion(canonical, agentId);
    if (!agentVersionId) {
      throw new SkillEnableError("Agent not found in this scope.", "agent_not_found");
    }

    const skill = await this.get(canonical, skillRowId);
    if (!skill) {
      throw new SkillEnableError("Skill not registered in this scope.", "skill_not_found");
    }
    const envSet = await this.scopedEnv.setMap(canonical, skill.requiredEnv);
    const missing = skill.requiredEnv.filter((key) => !envSet[key]);
    if (missing.length > 0) {
      throw new SkillEnableError(
        `Cannot enable skill "${skill.skillId}" — missing env vars: ${missing.join(", ")}`,
        "missing_env",
        { missing },
      );
    }

    const environmentSkill = await this.environmentSkillFor(canonical, skillRowId, true);
    if (!environmentSkill) {
      throw new SkillEnableError("Skill not registered in this scope.", "skill_not_found");
    }
    const row = await this.prisma.agentSkill.upsert({
      where: {
        agentVersionId_environmentSkillId: {
          agentVersionId,
          environmentSkillId: environmentSkill.id,
        },
      },
      create: { agentVersionId, environmentSkillId: environmentSkill.id, enabled: true },
      update: { enabled: true },
    });
    return {
      ...skill,
      agentSkillId: row.id,
      enabled: row.enabled,
      enabledAt: toIso(row.createdAt),
    };
  }

  async disableForAgent(scope: ScopeTuple, agentId: string, skillRowId: string): Promise<void> {
    const canonical = await this.resolveScope(scope);
    if (!canonical) return;
    const agentVersionId = await this.activeAgentVersion(canonical, agentId);
    const environmentSkill = await this.environmentSkillFor(canonical, skillRowId, false);
    if (!agentVersionId || !environmentSkill) return;
    await this.prisma.agentSkill.updateMany({
      where: { agentVersionId, environmentSkillId: environmentSkill.id },
      data: { enabled: false },
    });
  }

  async removeFromAgent(scope: ScopeTuple, agentId: string, skillRowId: string): Promise<void> {
    const canonical = await this.resolveScope(scope);
    if (!canonical) return;
    const agentVersionId = await this.activeAgentVersion(canonical, agentId);
    const environmentSkill = await this.environmentSkillFor(canonical, skillRowId, false);
    if (!agentVersionId || !environmentSkill) return;
    await this.prisma.agentSkill.deleteMany({
      where: { agentVersionId, environmentSkillId: environmentSkill.id },
    });
  }

  async listForAgent(scope: ScopeTuple, agentId: string): Promise<AgentSkillRecord[]> {
    const canonical = await this.resolveScope(scope);
    if (!canonical) return [];
    const agentVersionId = await this.activeAgentVersion(canonical, agentId);
    if (!agentVersionId) return [];
    const rows = await this.prisma.agentSkill.findMany({
      where: {
        agentVersionId,
        environmentSkill: { environmentId: canonical.environmentId },
      },
      include: {
        environmentSkill: {
          include: { projectSkill: { include: { skill: true } } },
        },
      },
      orderBy: { environmentSkill: { projectSkill: { skillId: "asc" } } },
    });
    return Promise.all(
      rows.map(async (row: any) => ({
        ...(await this.hydrate(canonical, row.environmentSkill.projectSkill.skill)),
        agentSkillId: row.id,
        enabled: row.enabled,
        enabledAt: toIso(row.createdAt),
      })),
    );
  }

  async loadActiveForAgent(scope: ScopeTuple, agentId: string): Promise<AgentSkillRecord[]> {
    const enabled = await this.listForAgent(scope, agentId);
    const active: AgentSkillRecord[] = [];
    for (const skill of enabled) {
      if (!skill.enabled) continue;
      if (skill.requiredEnv.length > 0) {
        const set = await this.scopedEnv.setMap(scope, skill.requiredEnv);
        if (skill.requiredEnv.some((key) => !set[key])) {
          this.logger.warn(
            `Skill ${skill.skillId} enabled on agent ${agentId} but env is no longer ready — skipping.`,
          );
          continue;
        }
      }
      active.push(skill);
    }
    return active;
  }

  async registerFromSource(
    scope: ScopeTuple,
    source: string,
    opts?: { importedFrom?: string; origin?: "official" | "community" | "custom"; isOfficial?: boolean },
  ): Promise<SkillRecord> {
    const parsed = parseSkill(source, opts?.importedFrom ? { importedFrom: opts.importedFrom } : {});
    const regOpts: { origin?: "official" | "community" | "custom"; isOfficial?: boolean } = {};
    if (opts?.origin !== undefined) regOpts.origin = opts.origin;
    if (opts?.isOfficial !== undefined) regOpts.isOfficial = opts.isOfficial;
    return this.register(scope, parsed, regOpts);
  }

  async updateSkill(
    scope: ScopeTuple,
    id: string,
    patch: { name?: string; description?: string; tags?: string[] },
  ): Promise<SkillRecord | null> {
    const canonical = await this.resolveScope(scope);
    if (!canonical) return null;
    const existing = await this.prisma.skill.findFirst({
      where: { id, ...this.visibleWhere(canonical) },
      select: { id: true },
    });
    if (!existing) return null;
    const data: Record<string, unknown> = {};
    if (patch.name !== undefined) data.name = patch.name;
    if (patch.description !== undefined) data.description = patch.description;
    if (patch.tags !== undefined) data.tags = patch.tags ?? [];
    if (Object.keys(data).length > 0) {
      await this.prisma.skill.update({ where: { id }, data });
    }
    return this.get(canonical, id);
  }

  async disableSkillGlobally(
    scope: ScopeTuple,
    skillId: string,
  ): Promise<{ affectedAgentCount: number }> {
    const canonical = await this.resolveScope(scope);
    if (!canonical) return { affectedAgentCount: 0 };
    const result = await this.prisma.agentSkill.updateMany({
      where: {
        enabled: true,
        agentVersion: {
          activeBindings: { some: { environmentId: canonical.environmentId } },
        },
        environmentSkill: {
          environmentId: canonical.environmentId,
          projectSkill: { projectId: canonical.projectId, skillId },
        },
      },
      data: { enabled: false },
    });
    return { affectedAgentCount: result.count };
  }

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
    const canonical = await this.resolveScope(scope);
    if (!canonical) return null;
    const agentVersionId = await this.activeAgentVersion(canonical, agentId);
    const environmentSkill = await this.environmentSkillFor(canonical, skillRowId, false);
    if (!agentVersionId || !environmentSkill) return null;
    const row = await this.prisma.agentSkill.findFirst({
      where: { agentVersionId, environmentSkillId: environmentSkill.id },
      include: {
        environmentSkill: { include: { projectSkill: { include: { skill: true } } } },
      },
    });
    if (!row) return null;
    return {
      agentSkillId: row.id,
      enabled: row.enabled,
      enabledAt: toIso(row.createdAt),
      config: row.config ?? null,
      skill: await this.hydrate(canonical, row.environmentSkill.projectSkill.skill),
    };
  }

  async getSkillUsage(
    scope: ScopeTuple,
    skillId: string,
  ): Promise<{ agentCount: number; agents: Array<{ agentId: string; enabled: boolean }> }> {
    const canonical = await this.resolveScope(scope);
    if (!canonical) return { agentCount: 0, agents: [] };
    const rows = await this.prisma.agentSkill.findMany({
      where: {
        agentVersion: {
          activeBindings: { some: { environmentId: canonical.environmentId } },
        },
        environmentSkill: {
          environmentId: canonical.environmentId,
          projectSkill: { projectId: canonical.projectId, skillId },
        },
      },
      select: {
        enabled: true,
        agentVersion: { select: { agentId: true } },
      },
    });
    const agents = rows.map((row: any) => ({
      agentId: row.agentVersion.agentId,
      enabled: row.enabled,
    }));
    return { agentCount: agents.length, agents };
  }

  private async hydrate(scope: ScopeTuple | null, row: any): Promise<SkillRecord> {
    const requiredEnv: string[] = row.requiredEnvironmentKeys ?? [];
    const envSetMap =
      scope && requiredEnv.length > 0 ? await this.scopedEnv.setMap(scope, requiredEnv) : {};
    const envReady = scope
      ? requiredEnv.length === 0 || requiredEnv.every((key) => !!envSetMap[key])
      : null;
    const manifest: SkillManifest = row.manifest;
    return {
      id: row.id,
      skillId: row.slug,
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
      optionalEnv: row.optionalEnvironmentKeys ?? [],
      importedFrom: manifest.importedFrom ?? null,
      envReady,
      envSetMap,
      category: deriveSkillCategory(row.slug, manifest),
      createdAt: toIso(row.createdAt),
      updatedAt: toIso(row.updatedAt),
    };
  }
}

function toIso(value: Date | string): string {
  return value instanceof Date ? value.toISOString() : new Date(value).toISOString();
}

export function deriveSkillCategory(
  skillId: string,
  manifest: SkillManifest | null | undefined,
): string {
  const declared = manifest?.category?.trim();
  if (declared) return declared;
  const slug = (skillId || "").split(".").pop() ?? "";
  const head = slug.split(/[-_]/)[0]?.trim();
  return head || "uncategorized";
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
