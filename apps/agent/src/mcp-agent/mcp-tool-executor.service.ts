import { Inject, Injectable, Logger, Optional } from "@nestjs/common";
import { MCPPermissionGatewayService } from "../mcp-platform/permission-gateway.service";
import { McpServerRegistryService, type ServerRow } from "./server-registry.service";
import { McpCredentialService } from "../tool-gateway/mcp-transport/mcp-credential.service";
import { McpConnectionPool } from "../tool-gateway/mcp-transport/mcp-client-pool.service";
import { ToolAuditService } from "../monitoring/tool-audit.service";
import type { RequestScope } from "../auth/scope.guard";
import { validatePublicUrl, describeUrlValidationError } from "../shared/url-validator";
import { env } from "../shared/env";

/**
 * Theme K.12 — MCP tool dispatcher used by the customer-agent turn
 * loop (Surface 2).
 *
 * Flow per call:
 *   1. Resolve the effective permission state via the 4-tier gateway.
 *   2. If `block` → return structured error; LLM cannot invoke.
 *   3. If `require_approval` → open a PlatosAgentApproval waitpoint
 *      via the existing approvals plumbing; the turn loop blocks.
 *   4. If `auto_allow` → dispatch to the server's transport,
 *      record audit, return result.
 *
 * Tool names are fully-qualified: `<server.slug>.<tool.name>`.
 */

export interface McpExecuteInput {
  qualifiedName: string;
  params: Record<string, unknown>;
  agentId: string;
  threadId: string;
  /** Optional session-level permission overrides (tier 4). */
  sessionOverrides?: Record<string, "auto_allow" | "require_approval" | "block">;
}

export type McpExecuteResult =
  | { status: "success"; result: unknown; latencyMs: number }
  | {
      status: "failed" | "timeout" | "blocked" | "pending_approval";
      error: string;
      latencyMs: number;
      tier?: number;
      approvalId?: string;
    };

@Injectable()
export class McpToolExecutorService {
  private readonly logger = new Logger(McpToolExecutorService.name);

  constructor(
    private readonly registry: McpServerRegistryService,
    private readonly permissionGateway: MCPPermissionGatewayService,
    private readonly credentials: McpCredentialService,
    private readonly pool: McpConnectionPool,
    @Optional() private readonly toolAudit?: ToolAuditService,
  ) {}

  async execute(
    scope: RequestScope,
    input: McpExecuteInput,
  ): Promise<McpExecuteResult> {
    const started = Date.now();
    const { qualifiedName, params, agentId, threadId, sessionOverrides } = input;

    // Parse qualified name → server slug + tool name.
    const dotIdx = qualifiedName.indexOf(".");
    if (dotIdx <= 0 || dotIdx === qualifiedName.length - 1) {
      return {
        status: "failed",
        error: `invalid qualified tool name: ${qualifiedName}`,
        latencyMs: Date.now() - started,
      };
    }
    const serverSlug = qualifiedName.slice(0, dotIdx);
    const toolName = qualifiedName.slice(dotIdx + 1);

    // Permission gate before anything else.
    const perm = await this.permissionGateway.resolve({
      scope: {
        organizationId: scope.organizationId,
        projectId: scope.projectId,
        environmentId: scope.environmentId,
      },
      agentId,
      userId: scope.userId,
      toolName: qualifiedName,
      ...(sessionOverrides ? { sessionOverrides } : {}),
    });
    if (perm.state === "block") {
      return {
        status: "blocked",
        error: `blocked by tier-${perm.tier} policy`,
        tier: perm.tier,
        latencyMs: Date.now() - started,
      };
    }
    if (perm.state === "require_approval") {
      // Surface as pending — the turn loop already handles this
      // event type by opening a PlatosAgentApproval waitpoint and
      // pausing the stream. McpToolExecutor surfaces the intent
      // + which tier asked for approval.
      return {
        status: "pending_approval",
        error: `tier-${perm.tier} require_approval`,
        tier: perm.tier,
        latencyMs: Date.now() - started,
      };
    }

    // Find the server — try per-agent install first, then org-scope
    // via any binding for this agent.
    const server = await this.findServer(scope, agentId, serverSlug);
    if (!server) {
      return {
        status: "failed",
        error: `MCP server '${serverSlug}' not enabled for this agent`,
        latencyMs: Date.now() - started,
      };
    }

    try {
      const result = await this.dispatch(scope, server, toolName, params);
      const latencyMs = Date.now() - started;
      // Audit (fire-and-forget) — same `PlatosToolCallAudit` table
      // entity tools use, with the `type: "mcp"` distinguisher.
      this.toolAudit
        ?.record({
          scope,
          toolId: null,
          toolName: qualifiedName,
          entityId: server.slug,
          entityPk: server.id,
          agentId,
          threadId,
          args: params as any,
          result: result as any,
          error: null,
          status: "success",
          latencyMs,
        })
        .catch(() => undefined);
      return { status: "success", result, latencyMs };
    } catch (err: any) {
      const latencyMs = Date.now() - started;
      const errMsg = err?.message || String(err);
      this.toolAudit
        ?.record({
          scope,
          toolId: null,
          toolName: qualifiedName,
          entityId: server.slug,
          entityPk: server.id,
          agentId,
          threadId,
          args: params as any,
          result: null,
          error: errMsg,
          status: "failed",
          latencyMs,
        })
        .catch(() => undefined);
      return { status: "failed", error: errMsg, latencyMs };
    }
  }

  private async findServer(
    scope: RequestScope,
    agentId: string,
    serverSlug: string,
  ): Promise<ServerRow | null> {
    const servers = await this.registry.list(scope, {});
    // Prefer per-agent install over org-scope when both exist with the
    // same slug (matches schema unique-key intent).
    const perAgent = servers.find(
      (s) => s.slug === serverSlug && s.agentId === agentId,
    );
    if (perAgent) return perAgent;
    // Org-scope fallback — confirm the agent has a binding.
    const orgScope = servers.find(
      (s) => s.slug === serverSlug && s.agentId === null,
    );
    if (!orgScope) return null;
    const bindings = await this.registry.listBindings(scope, agentId);
    const boundIds = new Set(bindings.map((b) => b.serverId));
    return boundIds.has(orgScope.id) ? orgScope : null;
  }

  private async dispatch(
    scope: RequestScope,
    server: ServerRow,
    toolName: string,
    params: Record<string, unknown>,
  ): Promise<unknown> {
    if (server.transport === "remote-http" || server.transport === "remote-sse") {
      if (!server.url) throw new Error("server.url missing");
      // BUG-15: cheap early SSRF reject before we touch the pool — defense-in-
      // depth even after the BUG-4 registration guard, in case a row was
      // inserted via admin tools. The pool's fetch re-validates + address-pins
      // every hop of every request too.
      const urlCheck = await validatePublicUrl(server.url);
      if (!urlCheck.ok) {
        throw new Error(`server url blocked by SSRF guard: ${describeUrlValidationError(urlCheck.error)}`);
      }
      // Phase 1: resolvedUrl is server.url as-is (no per-user templating).
      const resolvedUrl = server.url;
      let resolvedHeaders: Record<string, string>;
      try {
        resolvedHeaders = await this.credentials.resolveHeaders(server, {
          organizationId: scope.organizationId,
          projectId: scope.projectId,
          environmentId: scope.environmentId,
        });
      } catch (err: any) {
        // Redacted — resolveHeaders never echoes secret/header values.
        throw new Error(`credential resolution failed: ${err?.message ?? "unknown"}`);
      }
      const client = await this.pool.getClient({
        server,
        resolvedUrl,
        resolvedHeaders,
        transportKind: server.transport,
      });
      // callTool throws an McpError on a JSON-RPC protocol error (caught by
      // execute()'s try/catch → audited as failed); a tool-level `isError`
      // result is returned as-is, matching the pre-SDK behavior (which only
      // threw on the JSON-RPC envelope error, not on tool-level errors).
      const result = await client.callTool(
        { name: toolName, arguments: params },
        undefined,
        { timeout: env.MCP_CALL_TIMEOUT_MS ?? 30_000 },
      );
      return result;
    }
    if (server.transport.startsWith("hosted-")) {
      // Platos-hosted servers: the specific handler lives in
      // `transports/hosted/<name>.ts`. MVP v1 ships with the
      // registration + permission + executor pipeline; the individual
      // handlers are K.11 scaffolds. Tolerate until they land.
      throw new Error(
        `hosted MCP server '${server.transport}' handler not yet implemented (K.11)`,
      );
    }
    if (server.transport === "stdio") {
      throw new Error("stdio transport not yet implemented (K.10)");
    }
    throw new Error(`unknown transport: ${server.transport}`);
  }
}
