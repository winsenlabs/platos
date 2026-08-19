/**
 * Theme K.5 — Platform MCP tools for the entity (connected-backend) registry.
 * Theme MCPF-W1 — extended with 10 new entity-management tools so the entire
 * webapp Entities surface is reachable from MCP clients.
 *
 * Each handler wraps a method on `AuthService`, `ToolRegistryService`,
 * `MessageCryptoService`, `McpBearerTokenService`, or directly on Prisma —
 * it has no business logic of its own. Scope is always taken from the
 * verified MCP token, never from the LLM-supplied args.
 *
 * Tier-1 require_approval (set in `permission-gateway.service.ts`
 * PLATFORM_TIER_MINIMUMS):
 *   - entities.register
 *   - entities.delete
 *   - entities.regenerate_secret
 *   - entities.set_mcp_enabled       (MCPF-W1)
 *   - entities.generate_mcp_token    (MCPF-W1)
 *   - entities.set_test_credentials  (MCPF-W1)
 *
 * Downstream org/agent/session tiers can only tighten — never relax — the
 * require_approval floor.
 */

import type { AuthService } from "../../auth/auth.service";
import type { ToolExecutorService } from "../../tool-gateway/tool-executor.service";
import type { ToolRegistryService } from "../../tool-gateway/tool-registry.service";
import type { EntityMcpDiscoveryService } from "../../tool-gateway/mcp-transport/entity-mcp-discovery.service";
import type { McpToolHandler } from "../mcp-router";
import type { RequestScope } from "../../auth/scope.guard";
import type { McpBearerTokenService } from "../mcp-bearer-token.service";
import type { MessageCryptoService } from "../../monitoring/message-crypto.service";
import type { ToolAuditService } from "../../monitoring/tool-audit.service";

// RFC 7230 token regex — mirrors the validation in
// agent.controller.ts:patchEntity testCredentials path. Direct API callers
// can't smuggle in \r\n and split a header.
const HEADER_NAME_RE = /^[A-Za-z0-9!#$%&'*+.^_`|~-]+$/;

function scopeTuple(scope: RequestScope) {
  return {
    organizationId: scope.organizationId,
    projectId: scope.projectId,
    environmentId: scope.environmentId,
  };
}

export function buildEntityToolHandlers(deps: {
  auth: AuthService;
  toolExecutor: ToolExecutorService;
  toolRegistry: ToolRegistryService;
  bearerTokens: McpBearerTokenService;
  messageCrypto: MessageCryptoService;
  toolAudit: ToolAuditService;
  prisma: any;
  // MCP-connected-entity (design Commit 5) — kicks outbound tools/list
  // discovery when an mcp-kind entity is registered / manually refreshed.
  // Optional (best-effort); absent in slim test harnesses.
  entityMcpDiscovery?: EntityMcpDiscoveryService;
}): McpToolHandler[] {
  const {
    auth,
    toolExecutor,
    toolRegistry,
    bearerTokens,
    messageCrypto,
    toolAudit,
    prisma,
    entityMcpDiscovery,
  } = deps;

  /**
   * MCPF-W1 — fire-and-forget audit trail for mutating entity tools. Mirrors
   * the shape used by ToolExecutorService so the same dashboard rows surface
   * MCP-driven entity edits + tool-call dispatches.
   */
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
        scope: scopeTuple(scope),
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
      name: "entities.list",
      description:
        "List connected entities in the token's scope. Returns every " +
        "registered entity's metadata (serviceSecret is stripped before return).",
      inputSchema: {
        type: "object",
        properties: {},
        additionalProperties: false,
      },
      async execute(_params, scope) {
        const entities = await auth.listEntities(
          scope.organizationId,
          scope.projectId,
        );
        // BUG-13/14: strip serviceSecret and serviceSecretHash before returning.
        return {
          entities: entities.map((e: any) => {
            const { serviceSecret, serviceSecretHash, ...safe } = e;
            return safe;
          }),
        };
      },
    },
    {
      name: "entities.get",
      description: "Fetch a single entity by its `entityId` slug.",
      inputSchema: {
        type: "object",
        required: ["entityId"],
        properties: { entityId: { type: "string" } },
        additionalProperties: false,
      },
      async execute(params, scope) {
        const entityId = String(params["entityId"]);
        const entity = await auth.getEntity(
          scope.organizationId,
          scope.projectId,
          entityId,
        );
        if (!entity) throw new Error(`entity ${entityId} not found in scope`);
        // BUG-13/14: strip serviceSecret and serviceSecretHash before returning.
        const { serviceSecret, serviceSecretHash, ...safeEntity } = entity as any;
        return safeEntity;
      },
    },
    {
      name: "entities.register",
      description:
        "Register a new connected entity. Destructive — defaults to " +
        "require_approval at platform tier. Returns the freshly generated " +
        "serviceSecret in `plaintextSecret` — show once, never again. " +
        "Set connectionKind='mcp' to register an OUTBOUND MCP server " +
        "(Composio, Linear-hosted, any streamable-HTTP MCP endpoint): supply " +
        "the endpoint as mcpClient.url (NOT mcpUrls — that stays [] for mcp), " +
        "and discovery (tools/list) fires automatically to populate the tool " +
        "matrix + flip connectionStatus to 'connected'.",
      inputSchema: {
        type: "object",
        // §1.5a — `mcpUrls` is NO LONGER hard-required with minItems:1 because
        // the mcp kind registers with mcpUrls:[]. Per-kind requirements are
        // enforced in the handler: wire needs ≥1 mcpUrl, mcp needs
        // mcpClient.transport (+ url for remote transports).
        required: ["entityId", "displayName"],
        properties: {
          entityId: { type: "string" },
          displayName: { type: "string" },
          mcpUrls: { type: "array", items: { type: "string" } },
          serviceSecret: { type: "string" },
          connectionKind: { type: "string", enum: ["wire", "mcp"] },
          mcpClient: {
            type: "object",
            properties: {
              transport: { type: "string" },
              url: { type: "string" },
              credsSecretKey: { type: "string" },
              headersTemplate: { type: "object" },
            },
            additionalProperties: false,
          },
          // PIFSP-3: `customParams` dropped from the entity schema — use
          // the agent-config editor's "MCP arguments" panel instead.
        },
        additionalProperties: false,
      },
      async execute(params, scope) {
        const connectionKind =
          params["connectionKind"] === "mcp" ? "mcp" : "wire";
        const mcpUrls = (params["mcpUrls"] as string[]) ?? [];
        const rawClient = params["mcpClient"] as
          | {
              transport?: string;
              url?: string | null;
              credsSecretKey?: string | null;
              headersTemplate?: unknown;
            }
          | undefined;

        if (connectionKind === "mcp") {
          const transport = rawClient?.transport;
          if (!transport || typeof transport !== "string") {
            return {
              error: "invalid_mcp_client",
              message:
                "connectionKind 'mcp' requires mcpClient.transport " +
                "(remote-http | remote-sse | hosted-*).",
            };
          }
          if (
            (transport === "remote-http" || transport === "remote-sse") &&
            !rawClient?.url
          ) {
            return {
              error: "invalid_mcp_client",
              message: `mcpClient.url is required for transport "${transport}".`,
            };
          }
        } else if (mcpUrls.length < 1) {
          return {
            error: "invalid_mcp_urls",
            message: "wire entities require at least one mcpUrls entry.",
          };
        }

        const entity = await auth.registerEntity({
          organizationId: scope.organizationId,
          projectId: scope.projectId,
          entityId: String(params["entityId"]),
          displayName: String(params["displayName"]),
          mcpUrls,
          serviceSecret:
            (params["serviceSecret"] as string | undefined) ?? "auto",
          connectionKind,
          ...(connectionKind === "mcp" && rawClient
            ? {
                mcpClient: {
                  transport: rawClient.transport as string,
                  url: rawClient.url ?? null,
                  credsSecretKey: rawClient.credsSecretKey ?? null,
                  headersTemplate: rawClient.headersTemplate,
                },
              }
            : {}),
        }, scope);

        // Kick discovery for mcp entities (fire-and-forget). tools/list writes
        // the shared matrix per env + stamps connectionStatus (§1.5a / §5).
        if (
          connectionKind === "mcp" &&
          entityMcpDiscovery &&
          (entity as { id?: string })?.id
        ) {
          void entityMcpDiscovery
            .discover((entity as { id: string }).id)
            .catch(() => undefined);
        }
        return entity;
      },
    },
    {
      name: "entities.delete",
      description:
        "Delete a connected entity. Destructive — defaults to " +
        "require_approval at platform tier. Returns `{ ok }`.",
      inputSchema: {
        type: "object",
        required: ["entityId"],
        properties: { entityId: { type: "string" } },
        additionalProperties: false,
      },
      async execute(params, scope) {
        const entityId = String(params["entityId"]);
        const ok = await auth.deleteEntity(
          scope.organizationId,
          scope.projectId,
          entityId,
        );
        return { ok, entityId };
      },
    },
    {
      name: "entities.regenerate_secret",
      description:
        "Rotate an entity's serviceSecret. Destructive — defaults to " +
        "require_approval at platform tier. Returns the new secret once.",
      inputSchema: {
        type: "object",
        required: ["entityId"],
        properties: { entityId: { type: "string" } },
        additionalProperties: false,
      },
      async execute(params, scope) {
        const entityId = String(params["entityId"]);
        const result = await auth.regenerateServiceSecret(
          scope.organizationId,
          scope.projectId,
          entityId,
          scope,
        );
        if (!result) throw new Error(`entity ${entityId} not found in scope`);
        return result;
      },
    },
    {
      name: "entities.wire_test",
      description:
        "Dispatch a signed test tool-call through the production " +
        "ToolExecutorService to confirm the entity handshake (HMAC " +
        "verification + callback reachability). Returns transcript + latency.",
      inputSchema: {
        type: "object",
        required: ["entityId"],
        properties: {
          entityId: { type: "string" },
          toolName: { type: "string" },
          params: { type: "object" },
        },
        additionalProperties: false,
      },
      async execute(params, scope) {
        const entityId = String(params["entityId"]);
        const toolName = ((params["toolName"] as string | undefined) ?? "ping").trim();
        if (!toolName) throw new Error("toolName required");
        const toolParams = (params["params"] as Record<string, unknown> | undefined) ?? {};
        const startedAt = Date.now();
        try {
          const result = await toolExecutor.execute(
            { tool: toolName, params: toolParams, purpose: "wire-test" },
            scope as RequestScope,
            // Attribute the audit row. NO endUserId is synthesized (design §3.1
            // row iv) — entities.wire_test targets wire entities; if ever aimed
            // at an mcp-kind tool with a {{endUserId}} template it fails closed
            // at the §3.2 guard, which is correct.
            { source: "wire_test" },
          );
          return {
            entityId,
            toolName,
            status: result.status,
            latencyMs: Date.now() - startedAt,
            result: result.status === "success" ? result.result : undefined,
            error: result.status !== "success" ? result.error : undefined,
          };
        } catch (err: any) {
          return {
            entityId,
            toolName,
            status: "failed",
            latencyMs: Date.now() - startedAt,
            error: err?.message || String(err),
          };
        }
      },
    },

    {
      name: "entities.refresh_discovery",
      description:
        "MCP-connected-entity (design Commit 5 / §5) — manually re-run the " +
        "outbound tools/list discovery for a connectionKind='mcp' entity " +
        "across every project environment. Idempotent-replace: re-registers " +
        "newly-reported tools, prunes dropped ones, and re-stamps " +
        "connectionStatus ('connected' on success, 'disconnected' + " +
        "discoveryError on failure). Use after rotating an upstream key or " +
        "when a server changes its tool set between periodic sweeps. Rejects " +
        "wire entities (their tools arrive via the inbound /tools/sync path).",
      inputSchema: {
        type: "object",
        required: ["entityId"],
        properties: { entityId: { type: "string" } },
        additionalProperties: false,
      },
      async execute(params, scope) {
        const entityId = String(params["entityId"]);
        const startedAt = Date.now();
        const entity = await auth.getEntity(
          scope.organizationId,
          scope.projectId,
          entityId,
        );
        if (!entity) {
          auditMutation(
            scope,
            "entities.refresh_discovery",
            params,
            null,
            "failed",
            startedAt,
            "not_found",
          );
          return { error: "not_found", entityId };
        }
        if ((entity as { connectionKind?: string }).connectionKind !== "mcp") {
          auditMutation(
            scope,
            "entities.refresh_discovery",
            params,
            null,
            "failed",
            startedAt,
            "not_mcp_entity",
          );
          return {
            error: "not_mcp_entity",
            message:
              "Discovery refresh only applies to connectionKind='mcp' entities.",
            entityId,
          };
        }
        if (!entityMcpDiscovery) {
          return { error: "discovery_unavailable", entityId };
        }
        try {
          const result = await entityMcpDiscovery.discover(
            (entity as { id: string }).id,
          );
          auditMutation(
            scope,
            "entities.refresh_discovery",
            params,
            result,
            "success",
            startedAt,
          );
          return { entityId, ...result };
        } catch (err: any) {
          const message = err?.message ?? String(err);
          auditMutation(
            scope,
            "entities.refresh_discovery",
            params,
            null,
            "failed",
            startedAt,
            message,
          );
          return { error: "discovery_failed", message, entityId };
        }
      },
    },

    // ── MCPF-W1 — Entities MCP Config (10 tools) ───────────────────────

    {
      name: "entities.update",
      description:
        "Partial-patch an entity's metadata. Editable fields: " +
        "`displayName` (string) and `mcpUrls` (string[]). Scope-pinned — " +
        "only entities in the token's (org, project) are reachable. " +
        "Returns the updated row with serviceSecret stripped. To rotate " +
        "the secret use `entities.regenerate_secret`; to change the " +
        "agent allow-list use `entities.set_linked_agents`.",
      inputSchema: {
        type: "object",
        required: ["entityId"],
        properties: {
          entityId: { type: "string" },
          displayName: { type: "string" },
          mcpUrls: { type: "array", items: { type: "string" } },
        },
        additionalProperties: false,
      },
      async execute(params, scope) {
        const entityId = String(params["entityId"]);
        const startedAt = Date.now();
        // 404 with a clean error rather than letting Prisma P2025 bubble.
        const existing = await auth.getEntity(
          scope.organizationId,
          scope.projectId,
          entityId,
        );
        if (!existing) {
          const err = `entity ${entityId} not found in scope`;
          auditMutation(scope, "entities.update", params, null, "failed", startedAt, err);
          return { error: "not_found", entityId };
        }
        const patch: { displayName?: string; mcpUrls?: string[] } = {};
        if (typeof params["displayName"] === "string") patch.displayName = params["displayName"];
        if (Array.isArray(params["mcpUrls"])) patch.mcpUrls = params["mcpUrls"] as string[];
        if (Object.keys(patch).length === 0) {
          // No-op patch — return the existing row without hitting Prisma so
          // we don't bump updatedAt for nothing.
          auditMutation(scope, "entities.update", params, existing, "success", startedAt);
          return existing;
        }
        try {
          const updated = await auth.updateEntity(
            scope.organizationId,
            scope.projectId,
            entityId,
            patch,
          );
          auditMutation(scope, "entities.update", params, updated, "success", startedAt);
          return updated;
        } catch (err: any) {
          const message = err?.message ?? String(err);
          auditMutation(scope, "entities.update", params, null, "failed", startedAt, message);
          return { error: "update_failed", message };
        }
      },
    },

    {
      name: "entities.get_tools",
      description:
        "List the tools exposed by a single entity in the current scope " +
        "with health stats (totalCalls, totalFailures, avgLatencyMs, " +
        "p95LatencyMs, lastStatus). enabled flag reflects the per-(entity, " +
        "tool, environment) ACL written by `entities.set_tool_acl`.",
      inputSchema: {
        type: "object",
        required: ["entityId"],
        properties: { entityId: { type: "string" } },
        additionalProperties: false,
      },
      async execute(params, scope) {
        const entityId = String(params["entityId"]);
        const tuple = scopeTuple(scope);
        const tools = toolRegistry.getScopedTools(tuple, {
          enabledOnly: false,
          sourceEntityId: entityId,
        });
        if (tools.length === 0) {
          return { entityId, tools: [] };
        }
        // Join with PlatosToolHealth for the same shape the dashboard renders.
        const entityPk = tools[0]?.entityPk ?? null;
        const healthRows = entityPk
          ? await prisma.platosToolHealth.findMany({
              where: { environmentId: scope.environmentId, entityId: entityPk },
            })
          : [];
        const healthByToolId = new Map<string, any>();
        for (const h of healthRows as Array<{
          toolId: string;
          lastStatus: string | null;
          totalCalls: number;
          totalFailures: number;
          avgLatencyMs: number | null;
          p95LatencyMs: number | null;
          lastCalledAt: Date | null;
        }>) {
          healthByToolId.set(h.toolId, h);
        }
        return {
          entityId,
          tools: tools.map((t) => {
            const h = healthByToolId.get(t.toolId);
            return {
              toolName: t.toolName,
              description: t.description,
              category: t.category ?? "uncategorized",
              enabled: t.enabled,
              lastStatus: h?.lastStatus ?? null,
              totalCalls: h?.totalCalls ?? 0,
              totalFailures: h?.totalFailures ?? 0,
              avgLatencyMs: h?.avgLatencyMs ?? null,
              p95LatencyMs: h?.p95LatencyMs ?? null,
              lastCalledAt: h?.lastCalledAt?.toISOString?.() ?? null,
            };
          }),
        };
      },
    },

    {
      name: "entities.set_tool_acl",
      description:
        "Enable or disable a single tool for (entityId, toolName) within " +
        "the current environment. Writes through ToolRegistryService so the " +
        "in-memory matrix cache is updated for next-turn enumeration.",
      inputSchema: {
        type: "object",
        required: ["entityId", "toolName", "enabled"],
        properties: {
          entityId: { type: "string" },
          toolName: { type: "string" },
          enabled: { type: "boolean" },
        },
        additionalProperties: false,
      },
      async execute(params, scope) {
        const entityId = String(params["entityId"]);
        const toolName = String(params["toolName"]);
        const enabled = !!params["enabled"];
        const startedAt = Date.now();
        try {
          const updated = await toolRegistry.setToolEnabled(
            scopeTuple(scope),
            entityId,
            toolName,
            enabled,
          );
          if (!updated) {
            auditMutation(
              scope,
              "entities.set_tool_acl",
              params,
              null,
              "failed",
              startedAt,
              "tool_mapping_not_found",
            );
            return { error: "tool_mapping_not_found", entityId, toolName };
          }
          const result = { ok: true, entityId, toolName, enabled };
          auditMutation(scope, "entities.set_tool_acl", params, result, "success", startedAt);
          return result;
        } catch (err: any) {
          const message = err?.message ?? String(err);
          auditMutation(scope, "entities.set_tool_acl", params, null, "failed", startedAt, message);
          return { error: "set_tool_acl_failed", message };
        }
      },
    },

    {
      name: "entities.get_linked_agents",
      description:
        "List the agents allowed to use this entity's tools. Empty array " +
        "= unrestricted (every agent in scope sees the tools); non-empty " +
        "= only the listed PlatosAgent.id values.",
      inputSchema: {
        type: "object",
        required: ["entityId"],
        properties: { entityId: { type: "string" } },
        additionalProperties: false,
      },
      async execute(params, scope) {
        const entityId = String(params["entityId"]);
        const entity = await auth.getEntity(
          scope.organizationId,
          scope.projectId,
          entityId,
        );
        if (!entity) return { error: "not_found", entityId };
        return {
          entityId,
          linkedAgentIds: (entity as { linkedAgentIds?: string[] }).linkedAgentIds ?? [],
        };
      },
    },

    {
      name: "entities.set_linked_agents",
      description:
        "Replace the per-entity agent allow-list. Every supplied agentId " +
        "must belong to (org, project, env) — forged ids return an error. " +
        "Empty array clears the restriction (= every agent in scope sees " +
        "the tools). Mirrors PATCH /entities/:id linkedAgentIds.",
      inputSchema: {
        type: "object",
        required: ["entityId", "agentIds"],
        properties: {
          entityId: { type: "string" },
          agentIds: { type: "array", items: { type: "string" } },
        },
        additionalProperties: false,
      },
      async execute(params, scope) {
        const entityId = String(params["entityId"]);
        const rawIds = (params["agentIds"] as unknown[]) ?? [];
        const cleaned = Array.from(
          new Set(
            rawIds
              .map((x) => (typeof x === "string" ? x.trim() : ""))
              .filter((x): x is string => x.length > 0),
          ),
        );
        const startedAt = Date.now();
        const entity = await auth.getEntity(
          scope.organizationId,
          scope.projectId,
          entityId,
        );
        if (!entity) {
          auditMutation(
            scope,
            "entities.set_linked_agents",
            params,
            null,
            "failed",
            startedAt,
            "not_found",
          );
          return { error: "not_found", entityId };
        }
        // Forged-id guard: each id must belong to this scope.
        if (cleaned.length > 0) {
          const known = await prisma.platosAgent.findMany({
            where: {
              id: { in: cleaned },
              organizationId: scope.organizationId,
              projectId: scope.projectId,
              environmentId: scope.environmentId,
            },
            select: { id: true },
          });
          const knownIds = new Set((known as Array<{ id: string }>).map((a) => a.id));
          const bogus = cleaned.filter((id) => !knownIds.has(id));
          if (bogus.length > 0) {
            auditMutation(
              scope,
              "entities.set_linked_agents",
              params,
              null,
              "failed",
              startedAt,
              "unknown_agent_ids",
            );
            return { error: "unknown_agent_ids", unknownAgentIds: bogus };
          }
        }
        await prisma.platosConnectedEntity.update({
          where: { id: (entity as { id: string }).id },
          data: { linkedAgentIds: cleaned },
        });
        // Mirror the in-memory matrix cache so next-turn enumeration sees
        // the new allow-list without a full registry rebuild — same path
        // used by agent.controller.ts:patchEntity.
        toolRegistry.syncEntityLinkedAgents((entity as { id: string }).id, cleaned);
        const result = { ok: true, entityId, count: cleaned.length };
        auditMutation(scope, "entities.set_linked_agents", params, result, "success", startedAt);
        return result;
      },
    },

    {
      name: "entities.get_test_credentials",
      description:
        "Fetch the entity's stored test-credential headers — DECRYPTED in " +
        "memory, returned in plaintext. Caller already has scope access; " +
        "encryption is purely an at-rest defence. Audit-logged.",
      inputSchema: {
        type: "object",
        required: ["entityId"],
        properties: { entityId: { type: "string" } },
        additionalProperties: false,
      },
      async execute(params, scope) {
        const entityId = String(params["entityId"]);
        const startedAt = Date.now();
        const entity = await auth.getEntity(
          scope.organizationId,
          scope.projectId,
          entityId,
        );
        if (!entity) {
          auditMutation(
            scope,
            "entities.get_test_credentials",
            params,
            null,
            "failed",
            startedAt,
            "not_found",
          );
          return { error: "not_found", entityId };
        }
        const encrypted = (entity as { testCredentials?: string | null }).testCredentials;
        if (!encrypted) {
          // Read still audited so we can prove no plaintext was served.
          auditMutation(
            scope,
            "entities.get_test_credentials",
            params,
            { empty: true },
            "success",
            startedAt,
          );
          return { entityId, headers: [], empty: true };
        }
        try {
          const envelope = JSON.parse(encrypted);
          const decrypted = messageCrypto.decryptJsonField(envelope) as {
            headers?: Array<{ name: string; value: string }>;
            userId?: string;
            updatedAt?: string;
            updatedByUserId?: string;
          } | null;
          if (!decrypted || (decrypted as any).__platos_enc === 1) {
            auditMutation(
              scope,
              "entities.get_test_credentials",
              params,
              null,
              "failed",
              startedAt,
              "decryption_failed",
            );
            return {
              error: "decryption_failed",
              message: "Test credentials present but the encryption key changed.",
            };
          }
          const result = {
            entityId,
            headers: decrypted.headers ?? [],
            userId: decrypted.userId,
            updatedAt: decrypted.updatedAt,
            updatedByUserId: decrypted.updatedByUserId,
          };
          // Audit the access — log a redacted summary (count only, never
          // header values) so the audit log itself doesn't become a leak.
          auditMutation(
            scope,
            "entities.get_test_credentials",
            params,
            { entityId, headerCount: (decrypted.headers ?? []).length },
            "success",
            startedAt,
          );
          return result;
        } catch (err: any) {
          const message = err?.message ?? String(err);
          auditMutation(
            scope,
            "entities.get_test_credentials",
            params,
            null,
            "failed",
            startedAt,
            message,
          );
          return { error: "decryption_failed", message };
        }
      },
    },

    {
      name: "entities.set_test_credentials",
      description:
        "Store encrypted test-credential headers used when 'Test' is " +
        "clicked from the dashboard. Validates RFC 7230 names + 4096-char " +
        "value cap + 32-header total. Pass `null` to clear. Audit-logged.",
      inputSchema: {
        type: "object",
        required: ["entityId"],
        properties: {
          entityId: { type: "string" },
          testCredentials: {
            oneOf: [
              { type: "null" },
              {
                type: "object",
                required: ["headers"],
                properties: {
                  headers: {
                    type: "array",
                    items: {
                      type: "object",
                      required: ["name", "value"],
                      properties: {
                        name: { type: "string" },
                        value: { type: "string" },
                      },
                    },
                  },
                  userId: { type: "string" },
                },
              },
            ],
          },
        },
        additionalProperties: false,
      },
      async execute(params, scope) {
        const entityId = String(params["entityId"]);
        const startedAt = Date.now();
        const entity = await auth.getEntity(
          scope.organizationId,
          scope.projectId,
          entityId,
        );
        if (!entity) {
          auditMutation(
            scope,
            "entities.set_test_credentials",
            { entityId },
            null,
            "failed",
            startedAt,
            "not_found",
          );
          return { error: "not_found", entityId };
        }
        const entityPk = (entity as { id: string }).id;
        const raw = params["testCredentials"] as
          | { headers: Array<{ name: string; value: string }>; userId?: string }
          | null
          | undefined;

        if (raw === null) {
          await prisma.platosConnectedEntity.update({
            where: { id: entityPk },
            data: { testCredentials: null },
          });
          auditMutation(
            scope,
            "entities.set_test_credentials",
            { entityId, cleared: true },
            { ok: true, cleared: true },
            "success",
            startedAt,
          );
          return { ok: true, cleared: true };
        }

        if (!raw || typeof raw !== "object" || !Array.isArray(raw.headers)) {
          return { error: "headers must be an array" };
        }
        if (raw.headers.length > 32) {
          return { error: "Too many test-credential headers (max 32).", limit: 32 };
        }
        const invalidHeaders: string[] = [];
        const cleaned: Array<{ name: string; value: string }> = [];
        for (const h of raw.headers) {
          if (
            !h ||
            typeof h !== "object" ||
            typeof h.name !== "string" ||
            typeof h.value !== "string"
          ) {
            return { error: "Every header needs a string name + string value." };
          }
          const name = h.name.trim();
          const value = h.value.trim();
          if (!HEADER_NAME_RE.test(name)) {
            invalidHeaders.push(name);
            continue;
          }
          if (value.length > 4096) {
            return {
              error: "Header values capped at 4096 chars.",
              headerName: name,
            };
          }
          cleaned.push({ name, value });
        }
        if (invalidHeaders.length > 0) {
          return {
            error: "One or more header names violate RFC 7230.",
            invalidHeaders,
          };
        }
        const userId =
          typeof raw.userId === "string" && raw.userId.trim().length > 0
            ? raw.userId.trim()
            : undefined;
        const stash = {
          headers: cleaned,
          userId,
          updatedAt: new Date().toISOString(),
          updatedByUserId: scope.userId,
        };
        const encrypted = messageCrypto.encryptJsonField(stash);
        await prisma.platosConnectedEntity.update({
          where: { id: entityPk },
          data: { testCredentials: JSON.stringify(encrypted) },
        });
        // Redacted audit — count + name list only, never header values.
        auditMutation(
          scope,
          "entities.set_test_credentials",
          { entityId, headerCount: cleaned.length, headerNames: cleaned.map((h) => h.name) },
          { ok: true, headerCount: cleaned.length },
          "success",
          startedAt,
        );
        return { ok: true, headerCount: cleaned.length };
      },
    },

    {
      name: "entities.get_mcp_config",
      description:
        "Fetch the per-entity MCP gateway configuration: enabled flag, " +
        "identityMode (anonymous/oidc/bearer), branding, toolAllowlist, " +
        "consentCopy, redirectUriAllowlist, rateLimitPerMinute. " +
        "Returns `{ enabled: false, exists: false }` if no row exists.",
      inputSchema: {
        type: "object",
        required: ["entityId"],
        properties: { entityId: { type: "string" } },
        additionalProperties: false,
      },
      async execute(params, scope) {
        const entityId = String(params["entityId"]);
        const entity = await auth.getEntity(
          scope.organizationId,
          scope.projectId,
          entityId,
        );
        if (!entity) return { error: "not_found", entityId };
        const entityPk = (entity as { id: string }).id;
        const config = await prisma.platosEntityMcpConfig.findUnique({
          where: { entityPk },
        });
        if (!config) {
          return {
            entityPk,
            entityId,
            enabled: false,
            identityMode: "bearer",
            identityProviders: null,
            bearerTokenCount: 0,
            branding: null,
            toolAllowlist: [],
            consentCopy: null,
            redirectUriAllowlist: [],
            rateLimitPerMinute: 60,
            injectMcpContext: false,
            exists: false,
          };
        }
        return {
          entityPk: config.entityPk,
          entityId,
          enabled: config.enabled,
          identityMode: config.identityMode,
          identityProviders: config.identityProviders,
          bearerTokenCount: config.bearerTokenCount,
          branding: config.branding,
          toolAllowlist: config.toolAllowlist,
          consentCopy: config.consentCopy,
          redirectUriAllowlist: config.redirectUriAllowlist,
          rateLimitPerMinute: config.rateLimitPerMinute,
          injectMcpContext: config.injectMcpContext === true,
          exists: true,
        };
      },
    },

    {
      name: "entities.set_mcp_enabled",
      description:
        "Toggle the per-entity MCP gateway flag. Cross-tenant impact — " +
        "defaults to require_approval at platform tier. Upserts the " +
        "`PlatosEntityMcpConfig` row so first toggle auto-creates defaults.",
      inputSchema: {
        type: "object",
        required: ["entityId", "enabled"],
        properties: {
          entityId: { type: "string" },
          enabled: { type: "boolean" },
        },
        additionalProperties: false,
      },
      async execute(params, scope) {
        const entityId = String(params["entityId"]);
        const enabled = !!params["enabled"];
        const startedAt = Date.now();
        const entity = await auth.getEntity(
          scope.organizationId,
          scope.projectId,
          entityId,
        );
        if (!entity) {
          auditMutation(
            scope,
            "entities.set_mcp_enabled",
            params,
            null,
            "failed",
            startedAt,
            "not_found",
          );
          return { error: "not_found", entityId };
        }
        const entityPk = (entity as { id: string }).id;
        await prisma.platosEntityMcpConfig.upsert({
          where: { entityPk },
          create: { entityPk, enabled },
          update: { enabled },
        });
        const result = { ok: true, entityId, enabled };
        auditMutation(scope, "entities.set_mcp_enabled", params, result, "success", startedAt);
        return result;
      },
    },

    {
      name: "entities.set_mcp_inject_context",
      description:
        "MCPF-followup: toggle whether MCP-origin tool calls receive a " +
        "`_context` envelope (source/mcpUserId/mcpClientId) merged into " +
        "their arguments. Default OFF — entity backends whose tool " +
        "functions don't accept unexpected `**kwargs` (or use platools-py's " +
        "dispatch wrapper that pops `_context` before the handler runs) " +
        "would crash on `TypeError`. Flip to ON only after the entity " +
        "backend is confirmed to handle the envelope. CTX.2 envelopeKeys " +
        "(agent contextMapping) is unaffected — already opt-in via agent config.",
      inputSchema: {
        type: "object",
        required: ["entityId", "enabled"],
        properties: {
          entityId: { type: "string" },
          enabled: { type: "boolean" },
        },
        additionalProperties: false,
      },
      async execute(params, scope) {
        const entityId = String(params["entityId"]);
        const enabled = !!params["enabled"];
        const startedAt = Date.now();
        const entity = await auth.getEntity(
          scope.organizationId,
          scope.projectId,
          entityId,
        );
        if (!entity) {
          auditMutation(
            scope,
            "entities.set_mcp_inject_context",
            params,
            null,
            "failed",
            startedAt,
            "not_found",
          );
          return { error: "not_found", entityId };
        }
        const entityPk = (entity as { id: string }).id;
        await prisma.platosEntityMcpConfig.upsert({
          where: { entityPk },
          create: { entityPk, injectMcpContext: enabled },
          update: { injectMcpContext: enabled },
        });
        // Bust the in-memory tool registry cache so the new flag takes
        // effect on the next dispatch without an agent restart.
        try {
          await toolRegistry.rebuildIndex();
        } catch {
          // Cache rebuild best-effort — DB row is the source of truth.
        }
        const result = { ok: true, entityId, injectMcpContext: enabled };
        auditMutation(
          scope,
          "entities.set_mcp_inject_context",
          params,
          result,
          "success",
          startedAt,
        );
        return result;
      },
    },

    {
      name: "entities.generate_mcp_token",
      description:
        "Mint a bearer PAT (`plt_ent_*`) for the entity's MCP gateway. " +
        "Returns the plaintext token ONCE — store it before responding. " +
        "Destructive at the trust-boundary level — defaults to " +
        "require_approval at platform tier. NOT a platform PAT — scoped " +
        "to the per-entity OAuth realm.",
      inputSchema: {
        type: "object",
        required: ["entityId", "label"],
        properties: {
          entityId: { type: "string" },
          label: { type: "string", minLength: 1 },
          expiresInDays: { type: "integer", minimum: 1, maximum: 3650 },
        },
        additionalProperties: false,
      },
      async execute(params, scope) {
        const entityId = String(params["entityId"]);
        const label = String(params["label"] ?? "").trim();
        if (!label) return { error: "label_required" };
        const expiresInDays =
          typeof params["expiresInDays"] === "number"
            ? Math.floor(params["expiresInDays"] as number)
            : null;
        const startedAt = Date.now();
        const entity = await auth.getEntity(
          scope.organizationId,
          scope.projectId,
          entityId,
        );
        if (!entity) {
          auditMutation(
            scope,
            "entities.generate_mcp_token",
            params,
            null,
            "failed",
            startedAt,
            "not_found",
          );
          return { error: "not_found", entityId };
        }
        const entityPk = (entity as { id: string }).id;
        const expiresAt = new Date(Date.now() + (expiresInDays ?? 90) * 86400_000);
        const minted = await bearerTokens.generate(
          entityPk,
          scope.environmentId,
          label,
          scope.userId ?? "mcp:platform",
          {
            expiresAt,
          },
        );
        const result = {
          id: minted.id,
          token: minted.raw,
          label,
          mcpUserId: minted.mcpUserId,
          expiresAt: expiresAt.toISOString(),
        };
        // Redacted audit: never log the plaintext token, only its prefix +
        // metadata. Caller has the full value in the response.
        auditMutation(
          scope,
          "entities.generate_mcp_token",
          { entityId, label, expiresInDays },
          {
            id: minted.id,
            tokenPrefix: minted.raw.slice(0, 8),
            mcpUserId: minted.mcpUserId,
            expiresAt: expiresAt.toISOString(),
          },
          "success",
          startedAt,
        );
        return result;
      },
    },
  ];
}
