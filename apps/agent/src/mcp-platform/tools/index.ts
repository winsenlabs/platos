/**
 * Theme K.5 – K.8 — platform MCP tool handlers.
 *
 * Each handler wraps an existing service method. The MCP adapter does
 * NO business logic — it unmarshals params, calls the handler, and
 * returns the result. Audit + scope enforcement live in the services
 * these handlers call (the same machinery the REST / dashboard uses).
 *
 * Categories:
 *   - Introspection (whoami, list_accessible_scopes, list_tools)
 *   - K.5 agents.* / threads.* / messages.*                (this file)
 *   - K.5 entities.*                                       (./entities.ts)
 *   - K.6 trigger.* meta-tools                             (./trigger.ts)
 *   - K.7 skills.*                                         (./skills.ts)
 *   - K.8 memories/providers/approvals/budgets/evals/
 *         artifacts/monitoring/audit/gdpr                  (./platos-control.ts)
 *
 * The Nest controller composes the full handler list via
 * `buildPlatformToolHandlers` + the per-category builders imported below.
 * Each builder takes its own dependency bag so unit tests can inject
 * doubles per category without reaching into the full Nest container.
 */

import type { AgentCrudService } from "../../agent-runtime/agent-crud.service";
import type { ConversationService } from "../../memory/conversation.service";
import type { AgentTaskService } from "../../agent-runtime/agent-task.service";
import type { RatingService } from "../../evals/rating.service";
import type { McpToolHandler } from "../mcp-router";
import type { RequestScope } from "../../auth/scope.guard";

import type { AuthService } from "../../auth/auth.service";
import type { ToolExecutorService } from "../../tool-gateway/tool-executor.service";
import type { EntityMcpDiscoveryService } from "../../tool-gateway/mcp-transport/entity-mcp-discovery.service";
import type { ToolRegistryService } from "../../tool-gateway/tool-registry.service";
import type { McpBearerTokenService } from "../mcp-bearer-token.service";
import type { MessageCryptoService } from "../../monitoring/message-crypto.service";
import type { SkillRegistryService } from "../../skills/skill-registry.service";
import type { SkillImporterService } from "../../skills/skill-importer.service";
import type { MemoryService } from "../../memory/memory.service";
import type { MemoryExtractionService } from "../../memory/memory-extraction.service";
import type { MemoryImportService } from "../../memory/memory-import.service";
import type { KnowledgeGraphService } from "../../memory/knowledge-graph.service";
import type { ProviderRegistryService } from "../../providers/provider-registry.service";
import type { ProviderKeyService } from "../../providers/provider-key.service";
import type { ScopedEnvService } from "../../providers/scoped-env.service";
import type { OAuthService } from "../../oauth/oauth.service";
import type { MonitoringApprovalsService } from "../../monitoring/approvals.service";
import type { BudgetService } from "../../monitoring/budget.service";
import type { EvalService } from "../../evals/eval.service";
import type { CostService } from "../../monitoring/cost.service";
import type { ToolAuditService } from "../../monitoring/tool-audit.service";
import type { SafetyEventService } from "../../monitoring/safety-event.service";
import type { GoldenSetService } from "../../evals/golden-set.service";
import type { SpansService } from "../../monitoring/spans.service";

import { buildEntityToolHandlers } from "./entities";
// EUI — end-user identity management (end_users.get / link_identity / bind_external_id / unlink_identity).
import { buildEndUserToolHandlers } from "./end-users";
// Connect reimagining — channels.* messaging-channel doorway management
// (create / list / get / update / delete / rotate_webhook_secret).
import { buildChannelToolHandlers } from "./channels";
// Connect v3 — channel_apps.* marketplace-app management (create / list / get /
// update / delete / list_installations / bind_installation).
import { buildChannelAppToolHandlers } from "./channel-apps";
import { buildTriggerToolHandlers } from "./trigger";
import { buildSkillToolHandlers } from "./skills";
import { buildPlatosControlToolHandlers } from "./platos-control";
import { buildOrchestrationToolHandlers } from "./orchestration";
import { buildMacroToolHandlers, MacroRecordingState } from "./macros";
import { buildReflectionToolHandlers } from "./reflection";
// MCPF-W3 — provider + OAuth + MCP token tools.
import { buildProviderToolHandlers } from "./providers";
import { buildOAuthToolHandlers } from "./oauth";
import { buildMcpToolHandlers } from "./mcp";
// MCPF-W4 — PlatosTask + alert channel tools (re-scoped from 37 to 16; the
// 2 forms tools + 19 phantom-feature tools were dropped — see THEME_MCPF.md
// §3 Wave 4 re-scope log for the full list of deferred features).
import { buildPlatosTaskToolHandlers } from "./platos_tasks";
import { buildAlertChannelToolHandlers } from "./alert_channels";
// MCPF-W5 — Knowledge Graph (8 tools) + Skills extensions (4 tools, wired
// into the existing buildSkillToolHandlers builder).
import { buildKgToolHandlers } from "./kg";
import type { McpRouter } from "../mcp-router";
import { buildEventsToolHandlers } from "./events";
import type { McpEventsService } from "../events.service";
import { buildAdminToolHandlers } from "./admin";
// MCPF-W6 — final wave (5 monitoring + 17 settings/admin = 22 tools).
import { buildMonitoringToolHandlers } from "./monitoring";
import { buildSettingsToolHandlers } from "./settings";
import type { TraceService } from "../../monitoring/trace.service";
import type { ProviderHealthService } from "../../auth/provider-health.service";
import type { OrganizationService } from "../../admin/organization.service";
import type { EnvironmentService } from "../../admin/environment.service";
import type { AgentClusterService } from "../../agent-runtime/agent-cluster.service";
import type { ChannelPersistenceService } from "../../channels/channel-persistence.service";
import type { PlatosSecretStore } from "@platos/tenancy-database";

/**
 * Factory that builds the handler list. Takes the services as
 * dependencies so unit tests can inject doubles.
 */
export function buildPlatformToolHandlers(deps: {
  agentCrud: AgentCrudService;
  conversation: ConversationService;
  agentTask: AgentTaskService;
  rating: RatingService;
  // K.5 entities + K.7 skills + K.8 control plane dependencies.
  auth: AuthService;
  toolExecutor: ToolExecutorService;
  // MCP-connected-entity (design Commit 5) — kicks tools/list discovery when an
  // mcp-kind entity is registered / refreshed via entities.register /
  // entities.refresh_discovery. Optional; best-effort.
  entityMcpDiscovery?: EntityMcpDiscoveryService;
  // MCPF-W1 — additional deps for the new entity-management tools.
  toolRegistry: ToolRegistryService;
  bearerTokens: McpBearerTokenService;
  messageCrypto: MessageCryptoService;
  skillRegistry: SkillRegistryService;
  skillImporter: SkillImporterService;
  memory: MemoryService;
  memoryImport: MemoryImportService;
  // MCPF-W2 — memories.extract_now wraps the manual-trigger path.
  memoryExtraction: MemoryExtractionService;
  graph: KnowledgeGraphService;
  providers: ProviderRegistryService;
  providerKeys: ProviderKeyService;
  // MCPF-W3 — provider key resolution + health checks (providers.test_credentials, rotate_key).
  scopedEnv: ScopedEnvService;
  // MCPF-W3 — OAuth client + token management.
  oauth: OAuthService;
  approvals: MonitoringApprovalsService;
  budgets: BudgetService;
  evals: EvalService;
  cost: CostService;
  toolAudit: ToolAuditService;
  safetyEvents: SafetyEventService;
  // K.14 orchestration composites.
  goldenSet: GoldenSetService;
  prisma: any;
  secretStore: PlatosSecretStore;
  // K.17 — macro recording state + router back-ref for replay dispatch.
  macroState: MacroRecordingState;
  getRouter: () => McpRouter;
  // K.15 — event bus + notification routing.
  events: McpEventsService;
  // K.16 — reflection tools (explain_turn needs SpansService for timeline).
  spans: SpansService;
  // MCPF-W6 — monitoring (5 tools) + settings/admin (17 tools).
  traces: TraceService;
  providerHealth: ProviderHealthService;
  orgs: OrganizationService;
  envs: EnvironmentService;
  clusters: AgentClusterService;
  channelPersistence: ChannelPersistenceService;
  /**
   * Connect channels.* — evict the channels runtime's cached Chat instance
   * after update / delete / rotate_webhook_secret so credential/config/routing
   * changes take effect immediately instead of after the runtime's 10-min TTL.
   * Optional (best-effort); wired by McpPlatformController via ModuleRef.
   */
  invalidateChannelRuntime?: (connectionId: string) => void;
  /**
   * Connect v3 channel_apps.* — evict the channels runtime's cached decrypted
   * bot token(s) for an app after update / delete / revoke so credential /
   * install changes take effect immediately. Optional (best-effort); wired by
   * McpPlatformController via ModuleRef.
   */
  invalidateChannelApp?: (appId: string) => void;
}): McpToolHandler[] {
  const { agentCrud, conversation, rating, toolAudit } = deps;

  // MCPF-W2 — fire-and-forget audit trail for mutating threads.* tools.
  // Mirrors the shape used by `entities.ts`'s auditMutation so MCP-driven
  // thread edits + entity edits surface in the same dashboard rows.
  function auditThreadMutation(
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
        scope: {
          organizationId: scope.organizationId,
          projectId: scope.projectId,
          environmentId: scope.environmentId,
        },
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

  const handlers: McpToolHandler[] = [
    // ── Introspection ──────────────────────────────────────────────
    {
      name: "platos.whoami",
      description:
        "Return the scope + permissions the current MCP token is pinned to.",
      inputSchema: { type: "object", properties: {}, additionalProperties: false },
      async execute(_params, scope, token) {
        return {
          scope: {
            organizationId: scope.organizationId,
            projectId: scope.projectId,
            environmentId: scope.environmentId,
          },
          mintedByUserId: token.mintedByUserId,
          permissions: token.permissions,
          expiresAt: token.expiresAt?.toISOString() ?? null,
        };
      },
    },
    {
      name: "platos.list_accessible_scopes",
      description:
        "Return scopes this token can reach. For scope-pinned tokens (all non-admin mints) returns exactly one scope.",
      inputSchema: { type: "object", properties: {}, additionalProperties: false },
      async execute(_params, scope) {
        return {
          scopes: [
            {
              organizationId: scope.organizationId,
              projectId: scope.projectId,
              environmentId: scope.environmentId,
            },
          ],
        };
      },
    },

    // ── agents.* ───────────────────────────────────────────────────
    {
      name: "agents.list",
      description: "List agents visible in the token's pinned scope.",
      inputSchema: {
        type: "object",
        properties: {
          limit: { type: "integer", minimum: 1, maximum: 500 },
        },
        additionalProperties: false,
      },
      async execute(params, scope) {
        void params;
        const agents = await agentCrud.list(scope as RequestScope);
        return { agents };
      },
    },
    {
      name: "agents.get",
      description: "Fetch a single agent by id.",
      inputSchema: {
        type: "object",
        required: ["agentId"],
        properties: { agentId: { type: "string" } },
        additionalProperties: false,
      },
      async execute(params, scope) {
        const agentId = String(params["agentId"]);
        const agent = await agentCrud.findById(agentId, scope as RequestScope);
        if (!agent) throw new Error(`agent ${agentId} not found in scope`);
        return agent;
      },
    },
    {
      name: "agents.create",
      description:
        "Create a new agent. Accepts the same DTO as POST /agents (name, slug, model, systemPrompt, ...). Required: name, model.",
      inputSchema: {
        type: "object",
        required: ["name", "model"],
        properties: {
          name: { type: "string" },
          slug: { type: "string" },
          model: { type: "string" },
          systemPrompt: { type: "string" },
          maxSteps: { type: "integer", minimum: 1 },
          contextLimit: { type: "integer", minimum: 1 },
          historyMode: { type: "string", enum: ["rolling", "compact"] },
          toolMode: { type: "string" },
          enableUserProfiling: { type: "boolean" },
          metaTools: { type: "object" },
          toolsBlockConfig: { type: "object" },
          memoryConfig: { type: "object" },
        },
        additionalProperties: true,
      },
      async execute(params, scope) {
        return agentCrud.create(scope as RequestScope, params as any);
      },
    },
    {
      name: "agents.update",
      description: "Update an agent. Same body shape as PATCH /agents/:id.",
      inputSchema: {
        type: "object",
        required: ["agentId"],
        properties: {
          agentId: { type: "string" },
          name: { type: "string" },
          model: { type: "string" },
          systemPrompt: { type: "string" },
          maxSteps: { type: "integer" },
          contextLimit: { type: "integer" },
          historyMode: { type: "string", enum: ["rolling", "compact"] },
          isActive: { type: "boolean" },
          toolsBlockConfig: { type: "object" },
          metaTools: { type: "object" },
          memoryConfig: { type: "object" },
        },
        additionalProperties: true,
      },
      async execute(params, scope) {
        const agentId = String(params["agentId"]);
        const { agentId: _drop, ...rest } = params;
        void _drop;
        return agentCrud.update(agentId, scope as RequestScope, rest as any);
      },
    },
    {
      name: "agents.delete",
      description:
        "Delete an agent. Destructive — defaults to require_approval at platform tier.",
      inputSchema: {
        type: "object",
        required: ["agentId"],
        properties: { agentId: { type: "string" } },
        additionalProperties: false,
      },
      async execute(params, scope) {
        const agentId = String(params["agentId"]);
        const ok = await agentCrud.delete(agentId, scope as RequestScope);
        return { ok, agentId };
      },
    },
    {
      name: "agents.canary.set",
      description: "Configure canary version routing for an agent.",
      inputSchema: {
        type: "object",
        required: ["agentId", "canaryPercent"],
        properties: {
          agentId: { type: "string" },
          canaryVersionId: { type: ["string", "null"] },
          canaryPercent: { type: "integer", minimum: 0, maximum: 100 },
        },
        additionalProperties: false,
      },
      async execute(params, scope) {
        return agentCrud.setCanary(
          String(params["agentId"]),
          scope as RequestScope,
          {
            canaryVersionId: (params["canaryVersionId"] as string | null) ?? null,
            canaryPercent: params["canaryPercent"] as number,
          },
        );
      },
    },
    {
      name: "agents.canary.promote",
      description:
        "Promote the current canary version to the primary. Destructive; defaults to require_approval.",
      inputSchema: {
        type: "object",
        required: ["agentId"],
        properties: { agentId: { type: "string" } },
        additionalProperties: false,
      },
      async execute(params, scope) {
        return agentCrud.promoteCanary(String(params["agentId"]), scope as RequestScope);
      },
    },

    // ── threads.* ──────────────────────────────────────────────────
    {
      name: "threads.list",
      description: "List threads for the current user in scope.",
      inputSchema: {
        type: "object",
        properties: {
          agentId: { type: "string" },
          limit: { type: "integer", minimum: 1, maximum: 500 },
        },
        additionalProperties: false,
      },
      async execute(params, scope) {
        const limit = (params["limit"] as number) ?? 50;
        const agentId = params["agentId"] as string | undefined;
        const threads = await conversation.listThreads(scope as RequestScope, {
          ...(agentId ? { agentId } : {}),
          limit,
        });
        return { threads };
      },
    },
    {
      name: "threads.get",
      description: "Fetch a thread by id (scope-filtered).",
      inputSchema: {
        type: "object",
        required: ["threadId"],
        properties: { threadId: { type: "string" } },
        additionalProperties: false,
      },
      async execute(params, scope) {
        const threadId = String(params["threadId"]);
        const thread = await conversation.getThread(threadId, scope as RequestScope);
        if (!thread) throw new Error(`thread ${threadId} not found in scope`);
        return thread;
      },
    },

    // ── MCPF-W2 threads mutators ───────────────────────────────────
    {
      name: "threads.create",
      description:
        "Start a new thread for the current user attached to an agent. " +
        "If the agent doesn't exist in scope it's lazily created (matches " +
        "the dashboard chat path). `displayName` + `email` are optional " +
        "and used to upsert the PlatosEndUser row when the scope has a " +
        "userId attached.",
      inputSchema: {
        type: "object",
        required: ["agentId"],
        properties: {
          agentId: { type: "string" },
          title: { type: "string" },
          displayName: { type: "string" },
          email: { type: "string" },
        },
        additionalProperties: false,
      },
      async execute(params, scope) {
        const startedAt = Date.now();
        const reqScope = scope as RequestScope;
        const agentId = String(params["agentId"]);
        const title = params["title"] as string | undefined;
        const displayName = params["displayName"] as string | undefined;
        const email = params["email"] as string | undefined;
        const opts: { displayName?: string; email?: string } = {};
        if (displayName !== undefined) opts.displayName = displayName;
        if (email !== undefined) opts.email = email;
        try {
          const thread = await conversation.createThread(
            reqScope,
            agentId,
            title,
            Object.keys(opts).length > 0 ? opts : undefined,
          );
          auditThreadMutation(reqScope, "threads.create", params, thread, "success", startedAt);
          return thread;
        } catch (err: any) {
          const message = err?.message ?? String(err);
          auditThreadMutation(
            reqScope,
            "threads.create",
            params,
            null,
            "failed",
            startedAt,
            message,
          );
          return { error: "create_failed", message };
        }
      },
    },
    {
      name: "threads.update",
      description:
        "Rename or archive/unarchive a thread. Pass `title` (string|null) " +
        "to rename — server-side trim + 200-char cap + newline strip. Pass " +
        "`archived: true` to soft-delete (moves status → 'archived'); " +
        "`archived: false` to restore. At least one of `title` / `archived` " +
        "must be supplied. Scope-pinned — cross-scope ids return " +
        "`{ error: 'not_found' }`.",
      inputSchema: {
        type: "object",
        required: ["threadId"],
        properties: {
          threadId: { type: "string" },
          title: { type: ["string", "null"] },
          archived: { type: "boolean" },
        },
        additionalProperties: false,
      },
      async execute(params, scope) {
        const startedAt = Date.now();
        const reqScope = scope as RequestScope;
        const threadId = String(params["threadId"]);
        const hasTitle = Object.prototype.hasOwnProperty.call(params, "title");
        const archivedRaw = params["archived"];
        const hasArchived = typeof archivedRaw === "boolean";
        if (!hasTitle && !hasArchived) {
          const err = "supply at least one of `title` or `archived`";
          auditThreadMutation(reqScope, "threads.update", params, null, "failed", startedAt, err);
          return { error: "no_op", message: err };
        }
        try {
          let title: string | null | undefined;
          let archived: boolean | undefined;
          let archivedAt: string | null | undefined;
          let updatedAt: string | undefined;
          if (hasTitle) {
            const renamed = await conversation.renameThread(
              threadId,
              reqScope,
              (params["title"] as string | null) ?? null,
            );
            if (!renamed) {
              auditThreadMutation(
                reqScope,
                "threads.update",
                params,
                null,
                "failed",
                startedAt,
                "thread not found in scope",
              );
              return { error: "not_found", threadId };
            }
            title = renamed.title;
            updatedAt = renamed.updatedAt;
          }
          if (hasArchived) {
            const t = archivedRaw === true
              ? await conversation.archiveThread(threadId, reqScope)
              : await conversation.unarchiveThread(threadId, reqScope);
            archived = (t as any).status === "archived";
            archivedAt = (t as any).archivedAt
              ? ((t as any).archivedAt instanceof Date
                  ? (t as any).archivedAt.toISOString()
                  : String((t as any).archivedAt))
              : null;
            // If we didn't rename, surface the post-archive title + updatedAt
            // so the response always carries the latest server-side state.
            if (title === undefined) title = (t as any).title ?? null;
            if (updatedAt === undefined) {
              const u = (t as any).updatedAt;
              updatedAt = u instanceof Date ? u.toISOString() : String(u);
            }
          }
          const result = {
            threadId,
            ...(title !== undefined ? { title } : {}),
            ...(archived !== undefined ? { archived } : {}),
            ...(archivedAt !== undefined ? { archivedAt } : {}),
            ...(updatedAt !== undefined ? { updatedAt } : {}),
          };
          auditThreadMutation(reqScope, "threads.update", params, result, "success", startedAt);
          return result;
        } catch (err: any) {
          const message = err?.message ?? String(err);
          // archiveThread / unarchiveThread throw "Thread not found or access denied"
          // for cross-scope ids — surface as a clean 404 shape.
          if (/not found/i.test(message)) {
            auditThreadMutation(
              reqScope,
              "threads.update",
              params,
              null,
              "failed",
              startedAt,
              message,
            );
            return { error: "not_found", threadId };
          }
          auditThreadMutation(reqScope, "threads.update", params, null, "failed", startedAt, message);
          return { error: "update_failed", message };
        }
      },
    },
    {
      name: "threads.delete",
      description:
        "Soft-delete a thread (PIFSP-20 — sets `status='archived'` + " +
        "`archivedAt=now()`). Hard purge is admin-tier only. Scope-pinned. " +
        "Idempotent for cross-scope ids: returns `{ ok: false, archivedAt: null }`.",
      inputSchema: {
        type: "object",
        required: ["threadId"],
        properties: { threadId: { type: "string" } },
        additionalProperties: false,
      },
      async execute(params, scope) {
        const startedAt = Date.now();
        const reqScope = scope as RequestScope;
        const threadId = String(params["threadId"]);
        try {
          const out = await conversation.deleteThread(threadId, reqScope);
          const result = { ok: out.archived, threadId, archivedAt: out.archivedAt };
          auditThreadMutation(reqScope, "threads.delete", params, result, "success", startedAt);
          return result;
        } catch (err: any) {
          const message = err?.message ?? String(err);
          auditThreadMutation(reqScope, "threads.delete", params, null, "failed", startedAt, message);
          return { error: "delete_failed", message };
        }
      },
    },
    {
      name: "threads.fork",
      description:
        "Branch a new thread from an existing one at a specific message. " +
        "Clones every active message up to (and including) `upToMessageId` " +
        "into the new thread. Scope is preserved. Soft cap: 10 active forks " +
        "per parent — archive an existing fork before exceeding the cap. " +
        "Returns the new Thread row.",
      inputSchema: {
        type: "object",
        required: ["threadId", "upToMessageId"],
        properties: {
          threadId: { type: "string" },
          upToMessageId: { type: "string" },
          title: { type: "string" },
        },
        additionalProperties: false,
      },
      async execute(params, scope) {
        const startedAt = Date.now();
        const reqScope = scope as RequestScope;
        const threadId = String(params["threadId"]);
        const upToMessageId = String(params["upToMessageId"]);
        const title = params["title"] as string | undefined;
        try {
          const fork = await conversation.forkThread(threadId, reqScope, {
            upToMessageId,
            ...(title !== undefined ? { title } : {}),
          });
          auditThreadMutation(reqScope, "threads.fork", params, fork, "success", startedAt);
          return fork;
        } catch (err: any) {
          const message = err?.message ?? String(err);
          auditThreadMutation(reqScope, "threads.fork", params, null, "failed", startedAt, message);
          return { error: "fork_failed", message };
        }
      },
    },
    {
      name: "threads.edit_and_rerun",
      description:
        "Edit a USER message in a thread + soft-delete every message after " +
        "it. Returns the new user-message row (revision bumped, " +
        "`editParentMessageId` points at the prior revision). Caller is " +
        "expected to immediately kick off a new turn with the edited " +
        "message — the streaming runtime picks up because `loadHistory` " +
        "filters on `status='active'`. Only USER messages may be edited; " +
        "use `threads.fork` to retry from an assistant turn.",
      inputSchema: {
        type: "object",
        required: ["threadId", "messageId", "newContent"],
        properties: {
          threadId: { type: "string" },
          messageId: { type: "string" },
          newContent: { type: "string" },
        },
        additionalProperties: false,
      },
      async execute(params, scope) {
        const startedAt = Date.now();
        const reqScope = scope as RequestScope;
        const threadId = String(params["threadId"]);
        const messageId = String(params["messageId"]);
        const newContent = String(params["newContent"]);
        try {
          const next = await conversation.editAndRerun(
            threadId,
            messageId,
            reqScope,
            newContent,
          );
          // Audit the rewrite without echoing the new content (PII-friendly).
          auditThreadMutation(
            reqScope,
            "threads.edit_and_rerun",
            { threadId, messageId, newContentLength: newContent.length },
            { id: next.id, revision: (next as any).revision ?? null },
            "success",
            startedAt,
          );
          return next;
        } catch (err: any) {
          const message = err?.message ?? String(err);
          auditThreadMutation(
            reqScope,
            "threads.edit_and_rerun",
            { threadId, messageId, newContentLength: newContent.length },
            null,
            "failed",
            startedAt,
            message,
          );
          return { error: "edit_failed", message };
        }
      },
    },

    // ── messages.* ─────────────────────────────────────────────────
    {
      name: "messages.list",
      description: "Fetch recent messages for a thread.",
      inputSchema: {
        type: "object",
        required: ["threadId"],
        properties: {
          threadId: { type: "string" },
          limit: { type: "integer", minimum: 1, maximum: 500 },
        },
        additionalProperties: false,
      },
      async execute(params, scope) {
        const threadId = String(params["threadId"]);
        const limit = (params["limit"] as number) ?? 100;
        const messages = await conversation.getMessages(
          threadId,
          scope as RequestScope,
          { limit },
        );
        return messages;
      },
    },
    {
      name: "messages.rate",
      description: "Attach an up/down rating to a specific assistant message.",
      inputSchema: {
        type: "object",
        required: ["messageId", "rating"],
        properties: {
          messageId: { type: "string" },
          rating: { type: "string", enum: ["up", "down"] },
          comment: { type: "string" },
        },
        additionalProperties: false,
      },
      async execute(params, scope) {
        const messageId = String(params["messageId"]);
        const ratingValue: 1 | -1 = params["rating"] === "up" ? 1 : -1;
        const comment = params["comment"] as string | undefined;
        return rating.upsert(scope as RequestScope, {
          messageId,
          rating: ratingValue,
          ...(comment !== undefined ? { comment } : {}),
        });
      },
    },
  ];

  // ── K.5 entities.* + MCPF-W1 entities management ──────────────────
  handlers.push(
    ...buildEntityToolHandlers({
      auth: deps.auth,
      toolExecutor: deps.toolExecutor,
      toolRegistry: deps.toolRegistry,
      bearerTokens: deps.bearerTokens,
      messageCrypto: deps.messageCrypto,
      toolAudit: deps.toolAudit,
      prisma: deps.prisma,
      ...(deps.entityMcpDiscovery
        ? { entityMcpDiscovery: deps.entityMcpDiscovery }
        : {}),
    }),
  );

  // ── EUI end_users.* — end-user identity management (4 tools) ──────
  // Read + manual-edit surface over the PlatosEndUser ↔ PlatosEndUserIdentity
  // link-not-merge graph, plus external-id adoption (bind_external_id, the
  // per-user Composio {{endUserId}} anchor). Scope-pinned; mutations audited.
  handlers.push(
    ...buildEndUserToolHandlers({
      prisma: deps.prisma,
      toolAudit: deps.toolAudit,
    }),
  );

  // ── Connect channels.* — messaging-channel doorway management (6 tools) ─
  // CRUD + webhook-secret rotation over PlatosChannelConnection. Scope-pinned;
  // agentId validated against the token scope; credentials encrypted at rest
  // via the same MessageCryptoService envelope entities use; mutations audited.
  handlers.push(
    ...buildChannelToolHandlers({
      prisma: deps.prisma,
      channelPersistence: deps.channelPersistence,
      toolAudit: deps.toolAudit,
      // Evict the cached Chat instance after mutations (stale-credential fix).
      invalidateRuntime: deps.invalidateChannelRuntime,
    }),
  );

  // ── Connect v3 channel_apps.* — marketplace-app management (10 tools) ────
  // CRUD over PlatosChannelApp + list/bind/import/revoke/status of its
  // workspace installations.
  // Scope-pinned; defaultAgentId + routing rule ids validated against the token
  // scope; clientSecret + signingSecret encrypted at rest via the same
  // MessageCryptoService envelope; mutations audited + floored require_approval.
  handlers.push(
    ...buildChannelAppToolHandlers({
      prisma: deps.prisma,
      channelPersistence: deps.channelPersistence,
      toolAudit: deps.toolAudit,
      // Evict the cached decrypted bot token(s) after mutations.
      invalidateApp: deps.invalidateChannelApp,
    }),
  );

  // ── K.6 trigger.* meta-tools ──────────────────────────────────────
  handlers.push(...buildTriggerToolHandlers());

  // ── K.7 skills.* + MCPF-W5 skill management ───────────────────────
  // MCPF-W5 added 4 tools (update / disable_globally / get_installed_config
  // / uninstall) inside the existing builder — toolAudit is now required
  // so mutations record audit rows like other MCPF waves.
  handlers.push(
    ...buildSkillToolHandlers({
      registry: deps.skillRegistry,
      importer: deps.skillImporter,
      toolAudit: deps.toolAudit,
    }),
  );

  // ── MCPF-W5 kg.* (8 tools) ────────────────────────────────────────
  // Wraps KnowledgeGraphService — graph CRUD + search + link discovery.
  // `kg.delete_node` + `kg.discover_links` are approval-gated.
  handlers.push(
    ...buildKgToolHandlers({
      graph: deps.graph,
      toolAudit: deps.toolAudit,
    }),
  );

  // ── K.8 platos control plane ──────────────────────────────────────
  handlers.push(
    ...buildPlatosControlToolHandlers({
      memory: deps.memory,
      memoryImport: deps.memoryImport,
      // MCPF-W2 — memories.extract_now.
      memoryExtraction: deps.memoryExtraction,
      conversation: deps.conversation,
      graph: deps.graph,
      providers: deps.providers,
      approvals: deps.approvals,
      budgets: deps.budgets,
      evals: deps.evals,
      cost: deps.cost,
      toolAudit: deps.toolAudit,
      safetyEvents: deps.safetyEvents,
      prisma: deps.prisma,
    }),
  );

  // ── K.14 orchestration composites ─────────────────────────────────
  handlers.push(
    ...buildOrchestrationToolHandlers({
      agentCrud: deps.agentCrud,
      auth: deps.auth,
      skillRegistry: deps.skillRegistry,
      memory: deps.memory,
      goldenSet: deps.goldenSet,
      prisma: deps.prisma,
    }),
  );

  // ── K.17 macros ───────────────────────────────────────────────────
  handlers.push(
    ...buildMacroToolHandlers({
      state: deps.macroState,
      prisma: deps.prisma,
      getRouter: deps.getRouter,
    }),
  );

  // ── K.15 events.* + notifications.* ───────────────────────────────
  handlers.push(
    ...buildEventsToolHandlers({
      events: deps.events,
    }),
  );

  // ── K.16 reflection (explain_turn / simulate_turn / diff_agents) ───
  handlers.push(
    ...buildReflectionToolHandlers({
      agentCrud: deps.agentCrud,
      conversation: deps.conversation,
      spans: deps.spans,
      toolAudit: deps.toolAudit,
      approvals: deps.approvals,
      cost: deps.cost,
      prisma: deps.prisma,
    }),
  );

  // ── K.18 admin-tier cross-scope tools ─────────────────────────────
  // Each handler has `requiresAdminTier: true`; the router hides them
  // from scope-tier tokens on tools/list + rejects calls with 403.
  handlers.push(
    ...buildAdminToolHandlers({
      prisma: deps.prisma,
      toolAudit: deps.toolAudit,
      cost: deps.cost,
      memory: deps.memory,
      graph: deps.graph,
    }),
  );

  // ── MCPF-W3 providers.* (8 tools) ─────────────────────────────────
  handlers.push(
    ...buildProviderToolHandlers({
      agentCrud: deps.agentCrud,
      providers: deps.providers,
      providerKeys: deps.providerKeys,
      scopedEnv: deps.scopedEnv,
      toolAudit: deps.toolAudit,
      prisma: deps.prisma,
    }),
  );

  // ── MCPF-W3 oauth.* (6 tools) ─────────────────────────────────────
  handlers.push(
    ...buildOAuthToolHandlers({
      oauth: deps.oauth,
      toolAudit: deps.toolAudit,
    }),
  );

  // ── MCPF-W3 mcp.* (2 tools) ───────────────────────────────────────
  handlers.push(
    ...buildMcpToolHandlers({
      auth: deps.auth,
      bearerTokens: deps.bearerTokens,
      prisma: deps.prisma,
    }),
  );

  // ── MCPF-W4 platos_tasks.* (10 tools) ─────────────────────────────
  // Wraps PlatosTask CRUD + run dispatch + run history. PlatosTasksController
  // already exposes these over REST; this surface fan-outs to the same
  // Prisma model + the trigger.dev `platos-custom-task` execution path.
  handlers.push(
    ...buildPlatosTaskToolHandlers({
      toolAudit: deps.toolAudit,
      prisma: deps.prisma,
    }),
  );

  // ── MCPF-W4 alert_channels.* (6 tools) ────────────────────────────
  // Preserves the alert-channel inventory with stable unavailable responses
  // until WIN-124 adds canonical persistence.
  handlers.push(
    ...buildAlertChannelToolHandlers({
      toolAudit: deps.toolAudit,
      prisma: deps.prisma,
      secretStore: deps.secretStore,
    }),
  );

  // ── MCPF-W6 monitoring.* (5 tools) ────────────────────────────────
  // Read-only operator surface: run history is explicitly unavailable;
  // canonical thread traces, cost rollups, and provider health remain active.
  handlers.push(
    ...buildMonitoringToolHandlers({
      traces: deps.traces,
      providerHealth: deps.providerHealth,
      prisma: deps.prisma,
    }),
  );

  // ── MCPF-W6 settings/admin.* (17 tools) ───────────────────────────
  // org.* (7) + projects.list_all + environments.* (6) + clusters.* (3).
  // 9 mutations are approval-gated in PLATFORM_TIER_MINIMUMS:
  //   org.update / org.add_member / org.remove_member / org.set_member_role
  //   environments.create / environments.delete
  //   environments.set_secret / environments.delete_secret
  //   clusters.create / clusters.add_agent
  // Credential tools fail before persistence/audit until WIN-124 lands.
  handlers.push(
    ...buildSettingsToolHandlers({
      orgs: deps.orgs,
      envs: deps.envs,
      clusters: deps.clusters,
      toolAudit: deps.toolAudit,
      prisma: deps.prisma,
    }),
  );

  // ── MCPF-W4 forms.* — DEFERRED ────────────────────────────────────
  // The original 37-tool spec assumed trigger.dev had a built-in form
  // capture system. Confirmed via grep across schema + webapp + agent:
  // there is NO `FormSubmission` model and no form-builder surface in
  // the codebase. The 2 forms tools (`forms.list_submissions` +
  // `forms.export_csv`) are deferred to a future theme that introduces
  // the schema + webapp UI.
  // TODO(MCPF-W4-followup): build form capture (schema + UI + service)
  // before adding these MCP tools.

  // TL.1 — stamp every platform handler with the canonical category so
  // the Tools tab + TL.2 display modes can group them under a single
  // "platform MCP" bucket. Individual builders (entities/trigger/skills/
  // platos-control/orchestration/macros/reflection/events/admin) opt out
  // if they set an explicit category of their own.
  for (const h of handlers) {
    if (!h.category) h.category = "platos.platform";
  }

  return handlers;
}
