/**
 * Theme K.7 — Platform MCP tools for the Platos Skills library.
 * Theme MCPF-W5 — extended with 4 skill-management tools (update / global
 * disable / per-agent config inspect / uninstall).
 *
 * Wraps SkillRegistryService + SkillImporterService. Scope is taken from
 * the verified MCP token — the LLM-supplied `agentId` is still scope-
 * filtered through the service layer, so cross-scope enumeration is
 * structurally impossible.
 *
 * Tier-1 require_approval (set in `permission-gateway.service.ts`
 * PLATFORM_TIER_MINIMUMS):
 *   - skills.install
 *   - skills.update              (MCPF-W5 — patches name/description/tags)
 *   - skills.disable_globally    (MCPF-W5 — flips enabled=false on every agent)
 *   - skills.uninstall           (MCPF-W5 — irreversible row removal)
 *
 * Audit redaction: skill mutations log `{ skillId, name }` only — never
 * the source/promptBlock/manifest content.
 */

import type { SkillRegistryService } from "../../skills/skill-registry.service";
import type { SkillImporterService } from "../../skills/skill-importer.service";
import type { ToolAuditService } from "../../monitoring/tool-audit.service";
import type { McpToolHandler } from "../mcp-router";
import type { RequestScope } from "../../auth/scope.guard";

type ScopeTuple = Pick<RequestScope, "organizationId" | "projectId" | "environmentId">;

function tuple(scope: RequestScope): ScopeTuple {
  return {
    organizationId: scope.organizationId,
    projectId: scope.projectId,
    environmentId: scope.environmentId,
  };
}

export function buildSkillToolHandlers(deps: {
  registry: SkillRegistryService;
  importer: SkillImporterService;
  toolAudit: ToolAuditService;
}): McpToolHandler[] {
  const { registry, importer, toolAudit } = deps;

  /**
   * MCPF-W5 — fire-and-forget audit trail for mutating skill tools.
   * `args` is sanitised by the caller — never the manifest source —
   * so prompt blocks never reach the audit log.
   */
  function auditSkillMutation(
    scope: RequestScope,
    toolName: string,
    args: Record<string, unknown>,
    result: unknown,
    status: "success" | "failed",
    startedAt: number,
    error?: string,
  ): void {
    toolAudit
      .record({
        scope: tuple(scope),
        toolName,
        userId: scope.userId ?? null,
        args,
        result,
        ...(error !== undefined ? { error } : {}),
        status,
        latencyMs: Date.now() - startedAt,
        source: "mcp_platform",
      })
      .catch(() => undefined);
  }

  return [
    {
      name: "skills.list",
      description:
        "List every skill visible in the token's scope (official org-level + project/env registered).",
      inputSchema: { type: "object", properties: {}, additionalProperties: false },
      async execute(_params, scope) {
        const skills = await registry.list(tuple(scope));
        return { skills };
      },
    },
    {
      name: "skills.get",
      description:
        "Fetch a single skill row. Accepts either the DB row id (cuid) or " +
        "the manifest slug (e.g. `platos.code_execution`) under `skillId`. " +
        "Falls back to the slug-keyed lookup so callers that picked an id " +
        "out of `skills.list` (which exposes the slug as `skillId`) keep " +
        "working — the asymmetry was a long-standing footgun.",
      inputSchema: {
        type: "object",
        required: ["skillId"],
        properties: { skillId: { type: "string" } },
        additionalProperties: false,
      },
      async execute(params, scope) {
        const idOrSlug = String(params["skillId"]);
        // MCPF-followup — accept id or slug. `skills.list` exposes the
        // slug under `skillId`, so callers naturally feed it back here.
        // Without slug fallback `skills.get(skills.list()[0].skillId)`
        // 404'd — a long-standing footgun.
        const skill = await registry.getBySlugOrId(tuple(scope), idOrSlug);
        if (!skill) throw new Error(`skill ${idOrSlug} not found in scope`);
        return { skill };
      },
    },
    {
      name: "skills.install",
      description:
        "Import a skill from a URL (claude.ai/skills, github, gist, raw) and register it in the scope. Destructive — defaults to require_approval at platform tier.",
      inputSchema: {
        type: "object",
        required: ["url"],
        properties: {
          url: { type: "string" },
        },
        additionalProperties: false,
      },
      async execute(params, scope) {
        const url = String(params["url"]);
        const parsed = await importer.importFromUrl(url);
        const skill = await registry.register(tuple(scope), parsed, {
          origin: "community",
        });
        return { skill };
      },
    },
    {
      name: "skills.enable",
      description:
        "Enable a scope-resident skill on a specific agent. Fails fast " +
        "if the skill's required_env isn't set in the target env.",
      inputSchema: {
        type: "object",
        required: ["agentId", "skillId"],
        properties: {
          agentId: { type: "string" },
          skillId: { type: "string" },
        },
        additionalProperties: false,
      },
      async execute(params, scope) {
        const agentId = String(params["agentId"]);
        const skillId = String(params["skillId"]);
        const skill = await registry.enableForAgent(tuple(scope), agentId, skillId);
        return { skill };
      },
    },
    {
      name: "skills.disable",
      description:
        "Disable a skill on an agent (soft — the PlatosAgentSkill row is retained with enabled=false).",
      inputSchema: {
        type: "object",
        required: ["agentId", "skillId"],
        properties: {
          agentId: { type: "string" },
          skillId: { type: "string" },
        },
        additionalProperties: false,
      },
      async execute(params, scope) {
        const agentId = String(params["agentId"]);
        const skillId = String(params["skillId"]);
        await registry.disableForAgent(tuple(scope), agentId, skillId);
        return { ok: true, agentId, skillId };
      },
    },

    // ── MCPF-W5 skill management ──────────────────────────────────
    {
      name: "skills.update",
      description:
        "Partial-patch update of a skill's metadata. Only `name`, " +
        "`description`, `tags` are patchable here — `source`, `promptBlock`, " +
        "`manifest`, `providesTools`, `requiredEnv`, `version` require a " +
        "full re-register via `skills.install`. Cross-scope ids return " +
        "`{ error: 'not_found' }`. Approval-gated.",
      inputSchema: {
        type: "object",
        required: ["skillId"],
        properties: {
          skillId: { type: "string" },
          name: { type: "string" },
          description: { type: "string" },
          tags: { type: "array", items: { type: "string" } },
        },
        additionalProperties: false,
      },
      async execute(params, scope) {
        const startedAt = Date.now();
        const skillId = String(params["skillId"]);
        const patch: { name?: string; description?: string; tags?: string[] } = {};
        if (params["name"] !== undefined) patch.name = String(params["name"]);
        if (params["description"] !== undefined) patch.description = String(params["description"]);
        if (params["tags"] !== undefined) patch.tags = params["tags"] as string[];
        const auditArgs: Record<string, unknown> = {
          skillId,
          patchedFields: Object.keys(patch),
        };
        try {
          const skill = await registry.updateSkill(tuple(scope), skillId, patch);
          if (!skill) {
            auditSkillMutation(
              scope,
              "skills.update",
              auditArgs,
              null,
              "failed",
              startedAt,
              "skill not found in scope",
            );
            return { error: "not_found", skillId };
          }
          auditSkillMutation(
            scope,
            "skills.update",
            auditArgs,
            { skillId: skill.id, name: skill.name },
            "success",
            startedAt,
          );
          return { skill };
        } catch (err: any) {
          const message = err?.message ?? String(err);
          auditSkillMutation(scope, "skills.update", auditArgs, null, "failed", startedAt, message);
          return { error: "update_failed", message };
        }
      },
    },
    {
      name: "skills.disable_globally",
      description:
        "Flip `enabled=false` on every PlatosAgentSkill row in scope that " +
        "links the given skill. Used by 'this skill is leaking PII / broken " +
        "— turn it off everywhere immediately' workflows. Soft-flip — agent " +
        "rows are retained so re-enable later restores prior config. " +
        "Idempotent: re-running after every agent is already disabled " +
        "returns `affectedAgentCount: 0`. Approval-gated.",
      inputSchema: {
        type: "object",
        required: ["skillId"],
        properties: { skillId: { type: "string" } },
        additionalProperties: false,
      },
      async execute(params, scope) {
        const startedAt = Date.now();
        const skillId = String(params["skillId"]);
        const auditArgs = { skillId };
        try {
          const out = await registry.disableSkillGlobally(tuple(scope), skillId);
          auditSkillMutation(
            scope,
            "skills.disable_globally",
            auditArgs,
            { skillId, affectedAgentCount: out.affectedAgentCount },
            "success",
            startedAt,
          );
          return { ok: true, skillId, affectedAgentCount: out.affectedAgentCount };
        } catch (err: any) {
          const message = err?.message ?? String(err);
          auditSkillMutation(
            scope,
            "skills.disable_globally",
            auditArgs,
            null,
            "failed",
            startedAt,
            message,
          );
          return { error: "disable_failed", message };
        }
      },
    },
    {
      name: "skills.get_installed_config",
      description:
        "Fetch the per-agent skill config row + the underlying skill " +
        "record. Returns `{ agentSkillId, enabled, enabledAt, config, " +
        "skill }` — `config` is currently always null (reserved for " +
        "future per-agent knobs like default model overrides or " +
        "skill-level max_results). Returns `null` if either the agent " +
        "isn't in scope or the skill isn't installed on it.",
      inputSchema: {
        type: "object",
        required: ["agentId", "skillId"],
        properties: {
          agentId: { type: "string" },
          skillId: { type: "string" },
        },
        additionalProperties: false,
      },
      async execute(params, scope) {
        const agentId = String(params["agentId"]);
        const skillId = String(params["skillId"]);
        const out = await registry.getInstalledConfig(tuple(scope), agentId, skillId);
        if (!out) return { error: "not_installed", agentId, skillId };
        return out;
      },
    },
    {
      name: "skills.uninstall",
      description:
        "Permanently remove a skill from the scope. Refuses if any agent " +
        "in scope still has the skill installed (enabled or not) — caller " +
        "must `skills.disable_globally` + iterate `skills.disable` per " +
        "agent first, or call `skills.disable_globally` then explicitly " +
        "remove every PlatosAgentSkill row. Returns `{ error: " +
        "'skill_in_use', affectedAgents: [...] }` when blocked. " +
        "Official org-level skills cannot be uninstalled from a project " +
        "scope — returns `{ error: 'cannot_uninstall_official' }` instead; " +
        "use `skills.disable_globally` to turn them off everywhere in scope. " +
        "Approval-gated; irreversible (re-installing requires re-importing " +
        "the manifest).",
      inputSchema: {
        type: "object",
        required: ["skillId"],
        properties: { skillId: { type: "string" } },
        additionalProperties: false,
      },
      async execute(params, scope) {
        const startedAt = Date.now();
        const skillId = String(params["skillId"]);
        const auditArgs = { skillId };
        try {
          // MCPF-W5 review followup — refuse to "uninstall" official
          // org-level skills from a project-scoped caller. `registry.remove`
          // would silently no-op (its WHERE filters projectId + environmentId,
          // and official rows store both as NULL), so the tool would have
          // returned `{ ok: true }` while the row stayed in the DB.
          // Surface it as an explicit `cannot_uninstall_official` error.
          const skill = await registry.get(tuple(scope), skillId);
          if (!skill) {
            auditSkillMutation(
              scope,
              "skills.uninstall",
              auditArgs,
              null,
              "failed",
              startedAt,
              "skill not found in scope",
            );
            return { error: "not_found", skillId };
          }
          if (skill.isOfficial) {
            auditSkillMutation(
              scope,
              "skills.uninstall",
              auditArgs,
              { skillId, blocked: true, reason: "official" },
              "failed",
              startedAt,
              "cannot_uninstall_official",
            );
            return {
              error: "cannot_uninstall_official",
              skillId,
              message:
                "Official skills are managed at org level and cannot be " +
                "removed from a project scope. Use `skills.disable_globally` " +
                "to turn it off across every agent in this scope instead.",
            };
          }

          const usage = await registry.getSkillUsage(tuple(scope), skillId);
          if (usage.agentCount > 0) {
            const result = {
              error: "skill_in_use",
              skillId,
              affectedAgents: usage.agents,
            };
            auditSkillMutation(
              scope,
              "skills.uninstall",
              auditArgs,
              { skillId, blocked: true, agentCount: usage.agentCount },
              "failed",
              startedAt,
              "skill_in_use",
            );
            return result;
          }
          await registry.remove(tuple(scope), skillId);
          auditSkillMutation(
            scope,
            "skills.uninstall",
            auditArgs,
            { skillId, removed: true },
            "success",
            startedAt,
          );
          return { ok: true, skillId };
        } catch (err: any) {
          const message = err?.message ?? String(err);
          auditSkillMutation(
            scope,
            "skills.uninstall",
            auditArgs,
            null,
            "failed",
            startedAt,
            message,
          );
          return { error: "uninstall_failed", message };
        }
      },
    },
  ];
}
