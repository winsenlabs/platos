/**
 * Theme MCPF-W6 — Settings / Admin MCP tools (17 tools).
 *
 * Wraps Organization + Project + RuntimeEnvironment + SecretStore +
 * AgentCluster surfaces so an operator can manage scope topology
 * + secrets + clusters entirely via MCP.
 *
 * Layout:
 *   • Org (7)          — list / get / update / list_members / add_member
 *                         / remove_member / set_member_role
 *   • Environments (6) — list / create / delete / list_secrets
 *                         / set_secret / delete_secret
 *   • Clusters (3)     — list / create / add_agent
 *   • Projects (1)     — list_all (via OrgMember membership)
 *
 * Approval-gated mutations (set in `permission-gateway.service.ts`
 * PLATFORM_TIER_MINIMUMS):
 *   - org.update / org.add_member / org.remove_member / org.set_member_role
 *   - environments.create / environments.delete
 *   - environments.set_secret / environments.delete_secret
 *   - clusters.create / clusters.add_agent
 *
 * Audit redaction discipline:
 *   - Secret writes log NAME ONLY — never the value or any prefix of it.
 *   - Member operations log `memberId` + `role` — never email/name/avatar.
 *   - Cluster operations log `clusterId` + `agentId` only.
 *   - Read tools don't audit (Wave 1-5 pattern).
 */

import type { McpToolHandler } from "../mcp-router";
import type { RequestScope } from "../../auth/scope.guard";
import type { ToolAuditService } from "../../monitoring/tool-audit.service";
import type { OrganizationService } from "../../admin/organization.service";
import type { EnvironmentService } from "../../admin/environment.service";
import type { AgentClusterService } from "../../agent-runtime/agent-cluster.service";

type ScopeTuple = Pick<RequestScope, "organizationId" | "projectId" | "environmentId">;

function tuple(scope: RequestScope): ScopeTuple {
  return {
    organizationId: scope.organizationId,
    projectId: scope.projectId,
    environmentId: scope.environmentId,
  };
}

export function buildSettingsToolHandlers(deps: {
  orgs: OrganizationService;
  envs: EnvironmentService;
  clusters: AgentClusterService;
  toolAudit: ToolAuditService;
  prisma: any;
}): McpToolHandler[] {
  const { orgs, envs, clusters, toolAudit, prisma } = deps;

  function auditMutation(
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
    // ── org.* ─────────────────────────────────────────────────────────
    {
      name: "org.list",
      description:
        "List organizations the calling user is a member of. Soft-" +
        "deleted orgs are filtered out. Returns the caller's role on " +
        "each row (ADMIN | MEMBER) so the client can hide owner-gated " +
        "actions.",
      inputSchema: { type: "object", properties: {}, additionalProperties: false },
      async execute(_params, scope) {
        const reqScope = scope as RequestScope;
        const orgList = await orgs.listForUser(reqScope.userId ?? "");
        return { orgs: orgList, count: orgList.length };
      },
    },
    {
      name: "org.get",
      description:
        "Fetch a single org. Caller must be a member; non-members get " +
        "`{ error: 'not_found' }`. When `orgId` is omitted the call " +
        "defaults to the token's pinned `scope.organizationId` — useful " +
        "for the common \"who am I currently scoped to\" lookup.",
      inputSchema: {
        type: "object",
        // MCPF-followup — `orgId` is no longer required; missing input
        // defaults to the token's pinned organization.
        properties: { orgId: { type: "string" } },
        additionalProperties: false,
      },
      async execute(params, scope) {
        const reqScope = scope as RequestScope;
        // MCPF-followup — default to the scope's pinned org when the
        // caller omits the field. Previous behaviour returned
        // `not_found, orgId: "undefined"` because `String(params["orgId"])`
        // coerced undefined into the literal "undefined".
        const rawOrgId = params["orgId"];
        const orgId = (typeof rawOrgId === "string" && rawOrgId.length > 0)
          ? rawOrgId
          : reqScope.organizationId;
        const org = await orgs.getForUser(orgId, reqScope.userId ?? "");
        if (!org) return { error: "not_found", orgId };
        return org;
      },
    },
    {
      name: "org.update",
      description:
        "Update org `title`. Owner-gated (ADMIN role). Approval-gated " +
        "at the platform tier — the gate bounds operator-driven org " +
        "renames.",
      inputSchema: {
        type: "object",
        required: ["orgId"],
        properties: {
          orgId: { type: "string" },
          title: { type: "string" },
        },
        additionalProperties: false,
      },
      async execute(params, scope) {
        const startedAt = Date.now();
        const reqScope = scope as RequestScope;
        const orgId = String(params["orgId"]);
        const patch: { title?: string } = {};
        if (params["title"] !== undefined) patch.title = String(params["title"]);
        try {
          const result = await orgs.update(orgId, reqScope.userId ?? "", patch);
          auditMutation(reqScope, "org.update", { orgId, fields: Object.keys(patch) }, { id: result.id }, "success", startedAt);
          return result;
        } catch (err: any) {
          const message = err?.message ?? String(err);
          auditMutation(reqScope, "org.update", { orgId, fields: Object.keys(patch) }, null, "failed", startedAt, message);
          if (message === "access_denied") return { error: "access_denied", orgId };
          if (message === "title_invalid") return { error: "title_invalid" };
          if (message === "not_found") return { error: "not_found", orgId };
          return { error: "update_failed", message };
        }
      },
    },
    {
      name: "org.list_members",
      description:
        "List members of an org. Caller must be a member. Returns " +
        "id + userId + role + user metadata (name/email/avatar).",
      inputSchema: {
        type: "object",
        required: ["orgId"],
        properties: { orgId: { type: "string" } },
        additionalProperties: false,
      },
      async execute(params, scope) {
        const reqScope = scope as RequestScope;
        const orgId = String(params["orgId"]);
        const members = await orgs.listMembers(orgId, reqScope.userId ?? "");
        if (members === null) return { error: "not_found", orgId };
        return { members, count: members.length };
      },
    },
    {
      name: "org.add_member",
      description:
        "Invite a user to the org by email. Owner-gated (ADMIN role). " +
        "Lands as a pending `OrgMemberInvite` — the invitee must accept " +
        "via the webapp accept-invite flow before joining. Refuses on " +
        "duplicate invite or if user is already a member.",
      inputSchema: {
        type: "object",
        required: ["orgId", "email"],
        properties: {
          orgId: { type: "string" },
          email: { type: "string", format: "email" },
          role: { type: "string", enum: ["ADMIN", "MEMBER"] },
        },
        additionalProperties: false,
      },
      async execute(params, scope) {
        const startedAt = Date.now();
        const reqScope = scope as RequestScope;
        const orgId = String(params["orgId"]);
        const email = String(params["email"]).toLowerCase();
        const role = (params["role"] as "ADMIN" | "MEMBER" | undefined) ?? "MEMBER";
        try {
          const invite = await orgs.addMemberInvite(orgId, reqScope.userId ?? "", { email, role });
          auditMutation(reqScope, "org.add_member", { orgId, role }, { inviteId: invite.id }, "success", startedAt);
          return invite;
        } catch (err: any) {
          const message = err?.message ?? String(err);
          auditMutation(reqScope, "org.add_member", { orgId, role }, null, "failed", startedAt, message);
          if (message === "access_denied") return { error: "access_denied", orgId };
          if (message === "email_invalid") return { error: "email_invalid" };
          if (message === "already_member") return { error: "already_member" };
          if (message === "invite_already_pending") return { error: "invite_already_pending" };
          // OSS member-cap rejection (PLATOS_MAX_PROJECT_MEMBERS).
          if (message.startsWith("member_limit_reached:")) {
            const limit = Number(message.split(":")[1] ?? 2);
            return { error: "member_limit_reached", limit };
          }
          return { error: "add_member_failed", message };
        }
      },
    },
    {
      name: "org.remove_member",
      description:
        "Remove an OrgMember row. Owner-gated. Refuses to remove the " +
        "last ADMIN — the org must always have at least one admin. " +
        "Pass the `OrgMember.id`, NOT the user id.",
      inputSchema: {
        type: "object",
        required: ["orgId", "memberId"],
        properties: {
          orgId: { type: "string" },
          memberId: { type: "string" },
        },
        additionalProperties: false,
      },
      async execute(params, scope) {
        const startedAt = Date.now();
        const reqScope = scope as RequestScope;
        const orgId = String(params["orgId"]);
        const memberId = String(params["memberId"]);
        try {
          const result = await orgs.removeMember(orgId, reqScope.userId ?? "", { memberId });
          auditMutation(reqScope, "org.remove_member", { orgId, memberId }, result, "success", startedAt);
          return result;
        } catch (err: any) {
          const message = err?.message ?? String(err);
          auditMutation(reqScope, "org.remove_member", { orgId, memberId }, null, "failed", startedAt, message);
          if (message === "access_denied") return { error: "access_denied", orgId };
          if (message === "not_found") return { error: "not_found", memberId };
          if (message === "last_admin_protected") return { error: "last_admin_protected" };
          return { error: "remove_member_failed", message };
        }
      },
    },
    {
      name: "org.set_member_role",
      description:
        "Change a member's role between ADMIN and MEMBER. Owner-gated. " +
        "Refuses to demote the last ADMIN. Idempotent — same-role calls " +
        "return the existing row without writing.",
      inputSchema: {
        type: "object",
        required: ["orgId", "memberId", "role"],
        properties: {
          orgId: { type: "string" },
          memberId: { type: "string" },
          role: { type: "string", enum: ["ADMIN", "MEMBER"] },
        },
        additionalProperties: false,
      },
      async execute(params, scope) {
        const startedAt = Date.now();
        const reqScope = scope as RequestScope;
        const orgId = String(params["orgId"]);
        const memberId = String(params["memberId"]);
        const role = String(params["role"]) as "ADMIN" | "MEMBER";
        try {
          const result = await orgs.setMemberRole(orgId, reqScope.userId ?? "", { memberId, role });
          auditMutation(reqScope, "org.set_member_role", { orgId, memberId, role }, result, "success", startedAt);
          return result;
        } catch (err: any) {
          const message = err?.message ?? String(err);
          auditMutation(reqScope, "org.set_member_role", { orgId, memberId, role }, null, "failed", startedAt, message);
          if (message === "access_denied") return { error: "access_denied", orgId };
          if (message === "not_found") return { error: "not_found", memberId };
          if (message === "last_admin_protected") return { error: "last_admin_protected" };
          return { error: "set_role_failed", message };
        }
      },
    },

    // ── projects.* ────────────────────────────────────────────────────
    {
      name: "projects.list_all",
      description:
        "List all projects the caller has access to (across every org " +
        "the caller is a member of). Returns id + slug + name + " +
        "organizationId + createdAt. Soft-deleted projects + orgs are " +
        "filtered out.",
      inputSchema: { type: "object", properties: {}, additionalProperties: false },
      async execute(_params, scope) {
        const reqScope = scope as RequestScope;
        const userId = reqScope.userId ?? "";
        if (!userId) return { projects: [], count: 0 };
        const projects = await prisma.project.findMany({
          where: {
            deletedAt: null,
            organization: { deletedAt: null, members: { some: { userId } } },
          },
          select: {
            id: true,
            slug: true,
            name: true,
            organizationId: true,
            externalRef: true,
            version: true,
            engine: true,
            createdAt: true,
            updatedAt: true,
            organization: { select: { slug: true, title: true } },
          },
          orderBy: [{ organizationId: "asc" }, { name: "asc" }],
        });
        return { projects, count: projects.length };
      },
    },

    // ── environments.* ────────────────────────────────────────────────
    {
      name: "environments.list",
      description:
        "List runtime environments in the caller's project scope. " +
        "Soft-archived envs are filtered out. Caller must be a member " +
        "of the org.",
      inputSchema: { type: "object", properties: {}, additionalProperties: false },
      async execute(_params, scope) {
        const reqScope = scope as RequestScope;
        try {
          const list = await envs.list(tuple(reqScope), reqScope.userId ?? null);
          return { environments: list, count: list.length };
        } catch (err: any) {
          if (err?.message === "access_denied") return { error: "access_denied" };
          return { error: "list_failed", message: err?.message ?? String(err) };
        }
      },
    },
    {
      name: "environments.create",
      description:
        "Create a new RuntimeEnvironment in the caller's project. " +
        "Owner-gated (ADMIN). Validates slug format (`[a-z0-9-]{1,31}` " +
        "starting with alphanumeric). Mints fresh apiKey + pkApiKey + " +
        "shortcode. Default `type` is DEVELOPMENT.",
      inputSchema: {
        type: "object",
        required: ["slug"],
        properties: {
          slug: { type: "string" },
          type: {
            type: "string",
            enum: ["PRODUCTION", "STAGING", "DEVELOPMENT", "PREVIEW"],
          },
        },
        additionalProperties: false,
      },
      async execute(params, scope) {
        const startedAt = Date.now();
        const reqScope = scope as RequestScope;
        const slug = String(params["slug"]);
        const type = params["type"] as
          | "PRODUCTION"
          | "STAGING"
          | "DEVELOPMENT"
          | "PREVIEW"
          | undefined;
        try {
          const created = await envs.create(tuple(reqScope), reqScope.userId ?? null, {
            slug,
            ...(type !== undefined ? { type } : {}),
          });
          auditMutation(reqScope, "environments.create", { slug, type: type ?? "DEVELOPMENT" }, { id: created.id }, "success", startedAt);
          return created;
        } catch (err: any) {
          const message = err?.message ?? String(err);
          auditMutation(reqScope, "environments.create", { slug, type: type ?? "DEVELOPMENT" }, null, "failed", startedAt, message);
          if (message === "access_denied") return { error: "access_denied" };
          if (message === "slug_invalid") return { error: "slug_invalid" };
          if (message === "slug_taken") return { error: "slug_taken", slug };
          return { error: "create_failed", message };
        }
      },
    },
    {
      name: "environments.delete",
      description:
        "Soft-archive a RuntimeEnvironment (sets `archivedAt = now()`). " +
        "Owner-gated. Refuses when active agents or non-archived threads " +
        "reference it (would break running agents). PRODUCTION envs are " +
        "delete-protected and must be removed via the webapp UI.",
      inputSchema: {
        type: "object",
        required: ["environmentId"],
        properties: { environmentId: { type: "string" } },
        additionalProperties: false,
      },
      async execute(params, scope) {
        const startedAt = Date.now();
        const reqScope = scope as RequestScope;
        const environmentId = String(params["environmentId"]);
        try {
          const result = await envs.deleteEnvironment(tuple(reqScope), reqScope.userId ?? null, { environmentId });
          auditMutation(reqScope, "environments.delete", { environmentId }, result, "success", startedAt);
          return result;
        } catch (err: any) {
          const message = err?.message ?? String(err);
          auditMutation(reqScope, "environments.delete", { environmentId }, null, "failed", startedAt, message);
          if (message === "access_denied") return { error: "access_denied" };
          if (message === "not_found") return { error: "not_found", environmentId };
          if (message === "production_env_protected") return { error: "production_env_protected" };
          if (message.startsWith("env_in_use_by_")) {
            const [reason, count] = message.split(":");
            return { error: "env_in_use", reason, count: Number(count) || 0 };
          }
          return { error: "delete_failed", message };
        }
      },
    },
    {
      name: "environments.list_secrets",
      description:
        "List secret NAMES (and version + timestamps) for the caller's " +
        "(project, environment) scope. Caller must be an org member. " +
        "**NEVER returns secret values** — use the dashboard or " +
        "deploy-pipeline injection to read them.",
      inputSchema: { type: "object", properties: {}, additionalProperties: false },
      async execute(_params, scope) {
        const reqScope = scope as RequestScope;
        try {
          const secrets = await envs.listSecrets(tuple(reqScope), reqScope.userId ?? null);
          return { secrets, count: secrets.length };
        } catch (err: any) {
          if (err?.message === "access_denied") return { error: "access_denied" };
          return { error: "list_failed", message: err?.message ?? String(err) };
        }
      },
    },
    {
      name: "environments.set_secret",
      description:
        "Write a secret to the caller's (project, environment) scope. " +
        "Owner-gated (ADMIN). Encrypted at rest with the webapp-shared " +
        "`ENCRYPTION_KEY` (AES-256-GCM). Audit logs record the NAME " +
        "only — never the value or any prefix. Validates name format " +
        "(`^[A-Z][A-Z0-9_]{0,63}$`) + 8KiB value cap.",
      inputSchema: {
        type: "object",
        required: ["name", "value"],
        properties: {
          name: { type: "string" },
          value: { type: "string" },
        },
        additionalProperties: false,
      },
      async execute(params, scope) {
        const startedAt = Date.now();
        const reqScope = scope as RequestScope;
        const name = String(params["name"]);
        const value = String(params["value"]);
        try {
          const result = await envs.setSecret(tuple(reqScope), reqScope.userId ?? null, { name, value });
          // Strip value from audit args — log NAME ONLY.
          auditMutation(reqScope, "environments.set_secret", { name }, { ok: true, name }, "success", startedAt);
          return result;
        } catch (err: any) {
          const message = err?.message ?? String(err);
          auditMutation(reqScope, "environments.set_secret", { name }, null, "failed", startedAt, message);
          if (message === "access_denied") return { error: "access_denied" };
          if (message === "name_invalid") return { error: "name_invalid" };
          if (message === "value_required") return { error: "value_required" };
          if (message === "value_too_long") return { error: "value_too_long" };
          if (message === "encryption_key_not_set" || message === "encryption_key_invalid_length") {
            return { error: "agent_misconfigured", message };
          }
          return { error: "set_failed", message };
        }
      },
    },
    {
      name: "environments.delete_secret",
      description:
        "Remove a secret from the caller's (project, environment) " +
        "scope. Owner-gated. Idempotent — already-missing secrets " +
        "return `{ deleted: false }` rather than throwing. Audit logs " +
        "the NAME only.",
      inputSchema: {
        type: "object",
        required: ["name"],
        properties: { name: { type: "string" } },
        additionalProperties: false,
      },
      async execute(params, scope) {
        const startedAt = Date.now();
        const reqScope = scope as RequestScope;
        const name = String(params["name"]);
        try {
          const result = await envs.deleteSecret(tuple(reqScope), reqScope.userId ?? null, { name });
          auditMutation(reqScope, "environments.delete_secret", { name }, result, "success", startedAt);
          return result;
        } catch (err: any) {
          const message = err?.message ?? String(err);
          auditMutation(reqScope, "environments.delete_secret", { name }, null, "failed", startedAt, message);
          if (message === "access_denied") return { error: "access_denied" };
          if (message === "name_invalid") return { error: "name_invalid" };
          return { error: "delete_failed", message };
        }
      },
    },

    // ── clusters.* ────────────────────────────────────────────────────
    {
      name: "clusters.list",
      description:
        "List agent clusters in the caller's scope. Each cluster row " +
        "includes its members (id + name + slug). Newest-first.",
      inputSchema: { type: "object", properties: {}, additionalProperties: false },
      async execute(_params, scope) {
        const reqScope = scope as RequestScope;
        const list = await clusters.list(reqScope);
        return { clusters: list, count: list.length };
      },
    },
    {
      name: "clusters.create",
      description:
        "Create a new agent cluster. Approval-gated. `name` is the " +
        "human-readable label; `slug` is the stable URL handle " +
        "(`[a-z0-9-]+`). Optionally seed with `agentIds[]` to add " +
        "members at creation time — each agentId is scope-validated.",
      inputSchema: {
        type: "object",
        required: ["name", "slug"],
        properties: {
          name: { type: "string" },
          slug: { type: "string" },
          description: { type: "string" },
          primaryAgentId: { type: "string" },
          agentIds: { type: "array", items: { type: "string" } },
        },
        additionalProperties: false,
      },
      async execute(params, scope) {
        const startedAt = Date.now();
        const reqScope = scope as RequestScope;
        const name = String(params["name"]);
        const slug = String(params["slug"]);
        if (!/^[a-z0-9][a-z0-9-]{0,30}$/.test(slug)) {
          auditMutation(reqScope, "clusters.create", { name, slug }, null, "failed", startedAt, "slug_invalid");
          return { error: "slug_invalid" };
        }
        const description = params["description"] as string | undefined;
        const primaryAgentId = params["primaryAgentId"] as string | undefined;
        const agentIds = params["agentIds"] as string[] | undefined;
        try {
          const created = await clusters.create(reqScope, {
            name,
            slug,
            ...(description !== undefined ? { description } : {}),
            ...(primaryAgentId !== undefined ? { primaryAgentId } : {}),
            ...(agentIds !== undefined ? { agentIds } : {}),
          });
          auditMutation(reqScope, "clusters.create", { name, slug, agentCount: agentIds?.length ?? 0 }, { id: created.id }, "success", startedAt);
          return created;
        } catch (err: any) {
          const message = err?.message ?? String(err);
          auditMutation(reqScope, "clusters.create", { name, slug }, null, "failed", startedAt, message);
          if (message.includes("Unique") || message.includes("unique")) return { error: "slug_taken", slug };
          return { error: "create_failed", message };
        }
      },
    },
    {
      name: "clusters.add_agent",
      description:
        "Add an agent to an existing cluster. Approval-gated. Both the " +
        "cluster + agent are scope-validated before the write — cross-" +
        "scope ids return `not_found`. Optional `role` is stored in " +
        "the cluster's metadata.roles map.",
      inputSchema: {
        type: "object",
        required: ["clusterId", "agentId"],
        properties: {
          clusterId: { type: "string" },
          agentId: { type: "string" },
          role: { type: "string" },
        },
        additionalProperties: false,
      },
      async execute(params, scope) {
        const startedAt = Date.now();
        const reqScope = scope as RequestScope;
        const clusterId = String(params["clusterId"]);
        const agentId = String(params["agentId"]);
        const role = params["role"] as string | undefined;
        try {
          await clusters.addAgent(clusterId, agentId, reqScope, role);
          auditMutation(reqScope, "clusters.add_agent", { clusterId, agentId, role: role ?? null }, { ok: true }, "success", startedAt);
          return { ok: true, clusterId, agentId };
        } catch (err: any) {
          const message = err?.message ?? String(err);
          auditMutation(reqScope, "clusters.add_agent", { clusterId, agentId, role: role ?? null }, null, "failed", startedAt, message);
          if (/cluster not found/i.test(message)) return { error: "cluster_not_found", clusterId };
          if (/agent not found/i.test(message)) return { error: "agent_not_found", agentId };
          return { error: "add_agent_failed", message };
        }
      },
    },
  ];
}
