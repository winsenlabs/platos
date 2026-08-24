import { Injectable, Inject, Optional, Logger } from "@nestjs/common";
import { PRISMA_TOKEN } from "../shared/database.provider";
import { ToolRegistryService, type OrgToolEntry } from "./tool-registry.service";
import { ToolSyncWsService } from "./tool-sync-ws.service";
// Gateway slug re-routing — see dynamic-executor.ts for why the old
// explicit-marker-only lookup never fired.
import {
  findDynamicExecutor,
  executorParamNames,
  toolNotFoundMessage,
} from "./dynamic-executor";
import { SpansService } from "../monitoring/spans.service";
import { ToolAuditService } from "../monitoring/tool-audit.service";
import { SafetyService } from "../monitoring/safety.service";
import { SafetyEventService } from "../monitoring/safety-event.service";
import { traceSessionContext } from "../agent-runtime/postman-context-handle";
import { RateLimitService } from "../monitoring/rate-limit.service";
// Issue #1 — per-tool approval policy gate. The MCP path already
// consults the 4-tier resolver before forwarding; the agent-runtime
// dispatcher historically did not, so prompt-level approval was the
// only enforcement. Wired here behind a feature flag for safe rollout.
import { MCPPermissionGatewayService } from "../mcp-platform/permission-gateway.service";
// Issue #1 (full pause flow) — when the gate returns `require_approval`
// we persist a `PlatosAgentApproval` row, publish the `approval_needed`
// event over Redis (the dashboard's Socket.IO room subscribes), and
// BLPOP-wait for resolution. Mirrors the pattern in
// `agent.service.ts`'s `request_approval` meta-tool.
import { MonitoringApprovalsService } from "../monitoring/approvals.service";
import { REDIS_TOKEN } from "../shared/redis.provider";
import type { Redis } from "ioredis";
import { approvalRedisKey } from "../monitoring/approval-keys";
import * as crypto from "crypto";
import {
  validatePublicUrl,
  describeUrlValidationError,
  fetchWithValidatedRedirects,
} from "../shared/url-validator";
import type { RequestScope } from "../auth/scope.guard";
import { env } from "../shared/env";
// MCP-as-connected-entity (design Commit 4) — the two Phase-1 transport
// primitives, relocated onto the entity dispatch path in Commit 2. mcpDispatch
// resolves per-user credentials/URL through McpCredentialService (fail-closed
// on a templated-but-unlinked `{{endUserId}}`) and calls the external server
// through a pooled official-SDK Client. Both are providers of ToolGatewayModule,
// so DI supplies them; they stay @Optional() only so bare-constructor test
// fixtures (no MCP) keep working — the mcp branch guards on their presence.
import {
  McpCredentialService,
  hasResidualEndUserTemplate,
} from "./mcp-transport/mcp-credential.service";
import { McpConnectionPool } from "./mcp-transport/mcp-client-pool.service";
// Theme CTX.2 — tool-arg auto-injection + outgoing `_context` envelope
// assembly. Both read from `scope.sessionContext` + `scope.contextMapping`
// (populated at stream() entry). Fail-open when unset.
import {
  buildEnvelope as buildCtxEnvelope,
  filterByEntityIds as filterToolsByEntityIds,
  injectArgs as injectCtxArgs,
  resolvePath as resolveCtxPath,
  type ContextMapping,
} from "../agent-runtime/context-resolver";
// Theme CTX.6 — 4-tier resolution (constant / session-override / auto-match /
// LLM). Supersedes the CTX.2 flat-mapping path; the resolver reads the SAME
// `contextMapping` JSONB + falls back gracefully on legacy-shape rows so this
// wire-up can ship without a migration.
import {
  applyResolutions as applyCtxResolutions,
  resolveToolMappings as resolveCtxToolMappings,
  type AgentContextMapping,
} from "../agent-runtime/context-automap.service";

interface ToolCallRequest {
  tool: string;
  params: Record<string, unknown>;
  purpose?: string;
}

interface ToolCallResult {
  tool: string;
  status: "success" | "failed" | "timeout";
  result?: unknown;
  error?: string;
  latencyMs: number;
  /**
   * Present when an audit row was persisted for this call. The replay
   * endpoint uses this id to re-dispatch with identical args. Theme E.5.
   */
  auditId?: string;
}

/**
 * PIFSP-21 — optional origin metadata. Every tool dispatch has an
 * origin: normal agent turn, skill invocation, audit replay, external
 * MCP client, or the wire-test button. When omitted the audit row
 * implicitly records `source = null` (treated as `"agent_turn"` by
 * readers / dashboards).
 *
 * `mcpUserId` / `mcpClientId` are populated ONLY when `source =
 * "mcp_client"` — these are the OAuth-token identity + client_id of
 * the external MCP client making the call. They flow through both the
 * `_context` envelope on the wire (so entity backends can render who
 * is acting on their behalf) and the `PlatosToolCallAudit` row.
 */
export interface ToolCallOrigin {
  source?:
    | "agent_turn"
    | "skill_invocation"
    | "replay"
    | "mcp_client"
    | "wire_test";
  mcpUserId?: string;
  mcpClientId?: string;
  /**
   * MCP per-user isolation (the crown jewel). The resolved
   * `PlatosEndUser.externalUserId` — the customer-meaningful opaque id that
   * becomes Composio's `user_id`. `mcpDispatch` substitutes it into the
   * `connectionKind="mcp"` server's URL + headers wherever `{{endUserId}}`
   * appears. When a template needs it and it is null/absent, dispatch fails
   * CLOSED (§3.2) — we NEVER fall back to `scope.userId`, an org id, or any
   * shared identity. Wire dispatch ignores this field entirely.
   */
  endUserId?: string | null;
}

/** Exact route resolved by a caller that preflights a specific entity. */
export interface ToolRouteConstraint {
  entityPk: string;
  entityId: string;
  toolId: string;
}

const RESERVED_EXTERNAL_ARGUMENT_ENVELOPES = new Set([
  "_context",
  "__platos",
  "_platos",
  "platos_context",
  "platosContext",
  "__platosContext",
]);

function stripReservedExternalArgumentEnvelopes(
  params: Record<string, unknown> | undefined,
): Record<string, unknown> {
  const strip = (value: unknown): unknown => {
    if (Array.isArray(value)) return value.map(strip);
    if (!value || typeof value !== "object") return value;
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .filter(([key]) => !RESERVED_EXTERNAL_ARGUMENT_ENVELOPES.has(key))
        .map(([key, nested]) => [key, strip(nested)]),
    );
  };
  return strip(params ?? {}) as Record<string, unknown>;
}

/**
 * ToolExecutorService — executes tool calls on entity backends.
 *
 * Each tool call:
 * 1. Resolves the callback URL from the scoped tool matrix
 * 2. Signs the request with HMAC-SHA256
 * 3. Sends to the entity's MCP endpoint (via WS if connected, HTTP fallback otherwise)
 * 4. Records health metrics per (toolId, entityId, environmentId)
 * 5. Returns structured result
 *
 * Supports parallel execution via executeBatch().
 */
@Injectable()
export class ToolExecutorService {
  /** Added with the gateway re-routing fix so a re-route is visible in logs. */
  private readonly logger = new Logger(ToolExecutorService.name);
  private prisma: any;

  constructor(
    @Inject(PRISMA_TOKEN) prisma: any,
    private readonly toolRegistry: ToolRegistryService,
    @Optional() private readonly wsService?: ToolSyncWsService,
    @Optional() private readonly spansService?: SpansService,
    @Optional() private readonly toolAuditService?: ToolAuditService,
    // Theme H.9 — pre-invoke detector gate + per-(agent,user) rate limit.
    // Optional so existing test fixtures don't need these wired.
    @Optional() private readonly safetyService?: SafetyService,
    @Optional() private readonly safetyEventService?: SafetyEventService,
    @Optional() private readonly rateLimitService?: RateLimitService,
    // Issue #1 — optional so existing test fixtures keep working.
    // The gate is also feature-flagged: nothing happens unless
    // PLATOS_TOOL_DISPATCH_PERMISSION_GATE=1 is set in the env.
    @Optional() private readonly permissionGateway?: MCPPermissionGatewayService,
    // Issue #1 (full pause flow) — optional. When both are wired AND
    // the gate flag is set, `require_approval` starts a real
    // persisted approval + Socket.IO event + BLPOP wait.
    @Optional() private readonly approvalsService?: MonitoringApprovalsService,
    @Optional() @Inject(REDIS_TOKEN) private readonly redis?: Redis,
    // MCP-as-connected-entity (design Commit 4) — pooled outbound MCP client +
    // per-user credential/URL resolver. Both are ToolGatewayModule providers, so
    // DI always supplies them in the running binary; @Optional() only keeps
    // bare-constructor test fixtures (which never exercise an mcp entity)
    // working. The `connectionKind === "mcp"` branch guards on their presence.
    @Optional() private readonly mcpCredentials?: McpCredentialService,
    @Optional() private readonly mcpPool?: McpConnectionPool,
  ) {
    this.prisma = prisma;
  }

  /**
   * Issue #1 — per-tool approval gate with full pause/resume flow.
   *
   * When `PLATOS_TOOL_DISPATCH_PERMISSION_GATE=1` is set and the
   * `MCPPermissionGatewayService` is wired (DI populates it via the
   * tool-gateway module's providers), every tool dispatch consults
   * the 4-tier resolver before forwarding to the entity. Behaviour
   * depends on the resolved state:
   *
   *   - `auto_allow`       → return `{ kind: "allow" }`; caller dispatches
   *                          normally with `call.params`.
   *   - `block`            → return `{ kind: "deny", result }` with the
   *                          tier + reason. Caller short-circuits.
   *   - `require_approval` → persist a `PlatosAgentApproval` row, publish
   *                          `approval_needed` over Redis (dashboard
   *                          Socket.IO room picks it up), and BLPOP-wait
   *                          for resolution. On approval, return
   *                          `{ kind: "allow", params }` with possibly-
   *                          edited args. On rejection / timeout, return
   *                          `{ kind: "deny", result }`.
   *
   * Mirrors the pattern in `agent.service.ts`'s `request_approval`
   * meta-tool: scoped Redis key (see EOBD.15), duplicated connection
   * so BLPOP doesn't queue every other ioredis op behind it, double-
   * write of the resolve transition for ledger consistency.
   *
   * Fails closed when the enabled gateway is unavailable or cannot resolve
   * policy. Dispatch must not bypass an enabled authorization boundary merely
   * because its persistence layer is unhealthy.
   *
   * The flag is off by default. Rollout: enable in staging, watch the
   * safety-event ledger for `dispatcher_permission_gate` entries,
   * confirm no legitimate calls are over-blocked, then enable in prod.
   */
  private async checkDispatchPermission(
    call: ToolCallRequest,
    scope: RequestScope,
    startTime: number,
  ): Promise<
    | { kind: "allow"; params?: Record<string, unknown> }
    | { kind: "deny"; result: ToolCallResult }
  > {
    if (process.env.PLATOS_TOOL_DISPATCH_PERMISSION_GATE !== "1") {
      return { kind: "allow" };
    }
    if (!this.permissionGateway) {
      this.logger.error("Tool dispatch permission gateway unavailable");
      return {
        kind: "deny",
        result: {
          tool: call.tool,
          status: "failed",
          error: "Tool dispatch denied because permission policy could not be evaluated.",
          latencyMs: Date.now() - startTime,
        },
      };
    }
    let resolved;
    try {
      resolved = await this.permissionGateway.resolve({
        scope: {
          organizationId: scope.organizationId,
          projectId: scope.projectId,
          environmentId: scope.environmentId,
        },
        agentId: scope.agentId ?? null,
        userId: scope.userId ?? null,
        toolName: call.tool,
      });
    } catch {
      this.logger.error("Tool dispatch permission resolution failed");
      return {
        kind: "deny",
        result: {
          tool: call.tool,
          status: "failed",
          error: "Tool dispatch denied because permission policy could not be evaluated.",
          latencyMs: Date.now() - startTime,
        },
      };
    }
    if (resolved.state === "auto_allow") return { kind: "allow" };

    // Record the gate decision on the safety-event ledger so the
    // governance dashboard reflects every block / pending-approval.
    await this.safetyEventService?.record(
      {
        organizationId: scope.organizationId,
        projectId: scope.projectId,
        environmentId: scope.environmentId,
        operatorUserId: scope.operatorUserId,
      },
      {
        detector: "dispatcher_permission_gate",
        action: resolved.state === "block" ? "block" : "warn",
        severity: resolved.state === "block" ? "high" : "medium",
        detail: `tool=${call.tool} state=${resolved.state} tier=${resolved.tier} reason=${resolved.reason}`,
        meta: { tier: resolved.tier, state: resolved.state },
        agentId: scope.agentId ?? null,
        threadId: scope.sessionId ?? null,
        userId: scope.userId ?? null,
        toolName: call.tool,
      },
    );

    if (resolved.state === "block") {
      return {
        kind: "deny",
        result: {
          tool: call.tool,
          status: "failed",
          error: `Tool ${call.tool} blocked by policy (tier ${resolved.tier}): ${resolved.reason}`,
          latencyMs: Date.now() - startTime,
        },
      };
    }

    // require_approval: the full pause/resume flow. Falls back to
    // a clean deny if the infra deps aren't wired (the gate stays
    // strict — never silently passes through a require_approval).
    if (!this.approvalsService || !this.redis) {
      return {
        kind: "deny",
        result: {
          tool: call.tool,
          status: "failed",
          error: `Tool ${call.tool} requires approval but the approval infrastructure (Redis + MonitoringApprovalsService) is not wired in this process`,
          latencyMs: Date.now() - startTime,
        },
      };
    }

    return await this.runApprovalPause(call, scope, resolved, startTime);
  }

  /**
   * Issue #1 — the pause/resume implementation. Extracted so the gate's
   * deny path stays readable.
   *
   * Lifecycle:
   *   1. Build a stable `requestHash` so concurrent retries dedupe to one
   *      approval row (idempotent against the dashboard's "Approve" race).
   *   2. `createMcpApproval` persists the row and returns it (or the
   *      existing pending row on hash collision).
   *   3. Publish `approval_needed` over the `approval:event` Redis pub/sub
   *      channel. The dashboard's `ConnectionsGateway` subscribes and
   *      pushes it into the thread's Socket.IO room.
   *   4. BLPOP on a scoped Redis key (`approval:<org>:<proj>:<env>:<id>`).
   *      Use a duplicated connection so the blocking call doesn't queue
   *      every other ioredis op behind it (see EOBD.15 + the
   *      ioredis-single-connection trap documented in agent.service.ts).
   *   5. On resolution: parse, double-write the transition for ledger
   *      consistency, return `{ kind: "allow", params: editedArgs ?? original }`.
   *   6. On timeout: mark `timed_out` and return a clean deny.
   */
  private async runApprovalPause(
    call: ToolCallRequest,
    scope: RequestScope,
    resolved: { state: string; tier: number; reason: string },
    startTime: number,
  ): Promise<
    | { kind: "allow"; params?: Record<string, unknown> }
    | { kind: "deny"; result: ToolCallResult }
  > {
    const scopeTuple = {
      organizationId: scope.organizationId,
      projectId: scope.projectId,
      environmentId: scope.environmentId,
    };
    const timeoutSeconds = Math.max(
      60,
      Number(process.env.PLATOS_TOOL_DISPATCH_APPROVAL_TIMEOUT_SECONDS ?? "300"),
    );

    // Stable hash so concurrent retries of the same call dedupe to one
    // approval row. Includes scope + tool + args so different args get
    // different rows (the operator's edit could be material).
    const requestHash = crypto
      .createHash("sha256")
      .update(
        JSON.stringify({
          org: scope.organizationId,
          proj: scope.projectId,
          env: scope.environmentId,
          agent: scope.agentId ?? null,
          tool: call.tool,
          params: call.params ?? {},
        }),
      )
      .digest("hex");

    let approval;
    try {
      approval = await this.approvalsService!.createMcpApproval({
        scope: scopeTuple,
        toolName: call.tool,
        args: call.params ?? {},
        requestHash,
        requestedByUserId: scope.userId ?? null,
        timeoutSeconds,
        actionLabel: `Tool dispatch: ${call.tool}`,
      });
    } catch {
      this.logger.error("Tool approval persistence failed");
      return {
        kind: "deny",
        result: {
          tool: call.tool,
          status: "failed",
          error: "Tool approval could not be requested.",
          latencyMs: Date.now() - startTime,
        },
      };
    }

    const redisKey = approvalRedisKey(scopeTuple, approval.approvalId);

    // Publish the approval_needed event. Best-effort: a publish failure
    // doesn't break the wait — the dashboard can still poll
    // `/approvals?status=pending` and resolve manually.
    try {
      await this.redis!.publish(
        "approval:event",
        JSON.stringify({
          type: "approval_needed",
          approvalId: approval.approvalId,
          action: `Tool dispatch: ${call.tool}`,
          details: `tier=${resolved.tier} reason=${resolved.reason}`,
          organizationId: scope.organizationId,
          projectId: scope.projectId,
          environmentId: scope.environmentId,
          agentId: scope.agentId ?? "default",
          userId: scope.userId ?? null,
          toolName: call.tool,
          source: "dispatcher_permission_gate",
        }),
      );
    } catch {
      /* best-effort */
    }

    // Duplicated connection so BLPOP doesn't queue every other ioredis
    // op behind it. See EOBD.15 + the trap documented in
    // agent.service.ts. Cheap (one TCP open/close per gated call).
    const blockClient =
      (this.redis as any).duplicate?.() ?? this.redis!;
    const usingDuplicate = blockClient !== this.redis;

    try {
      const result = await (blockClient as any).blpop(redisKey, timeoutSeconds);
      if (!result) {
        // Timeout. Persist the transition + broadcast resolved-state so
        // UI cards stop spinning.
        await this.approvalsService!.resolve({
          scope: scopeTuple,
          approvalId: approval.approvalId,
          status: "timed_out",
        }).catch(() => {});
        await this.redis!.publish(
          "approval:event",
          JSON.stringify({
            type: "approval_resolved",
            approvalId: approval.approvalId,
            status: "timed_out",
            organizationId: scope.organizationId,
            projectId: scope.projectId,
            environmentId: scope.environmentId,
            agentId: scope.agentId ?? "default",
            // SECURITY (audit H4 regression) — route to the requester's user
            // room; they left the scope room, so a timeout must carry userId
            // to reach their card and stop the spinner.
            userId: scope.userId ?? null,
          }),
        ).catch(() => {});
        return {
          kind: "deny",
          result: {
            tool: call.tool,
            status: "failed",
            error: `Tool ${call.tool} approval timed out after ${timeoutSeconds}s`,
            latencyMs: Date.now() - startTime,
          },
        };
      }

      const [, payload] = result as [string, string];
      let parsed: {
        approved?: boolean;
        editedArgs?: Record<string, unknown>;
        respondedBy?: string | null;
        comment?: string | null;
      } = {};
      try {
        parsed = JSON.parse(payload);
      } catch {
        /* fall through with empty parsed → treated as rejected below */
      }

      // Double-write of the transition for ledger consistency (HTTP
      // resolver already persists; this is idempotent).
      await this.approvalsService!.resolve({
        scope: scopeTuple,
        approvalId: approval.approvalId,
        status: parsed.approved ? "approved" : "rejected",
        respondedBy: parsed.respondedBy ?? null,
        comment: parsed.comment ?? null,
        editedArgs: parsed.editedArgs ?? null,
        editedByUserId: parsed.editedArgs ? parsed.respondedBy ?? null : null,
      }).catch(() => {});

      if (!parsed.approved) {
        return {
          kind: "deny",
          result: {
            tool: call.tool,
            status: "failed",
            error: `Tool ${call.tool} approval rejected${parsed.comment ? `: ${parsed.comment}` : ""}`,
            latencyMs: Date.now() - startTime,
          },
        };
      }

      // Approved. If the operator edited args, dispatch uses those;
      // otherwise the original params. Either way, `mark_consumed` is
      // recorded once the dispatch finishes successfully — done in
      // execute() after executeInner returns.
      return {
        kind: "allow",
        params: parsed.editedArgs ?? call.params,
      };
    } catch {
      this.logger.error("Tool approval wait failed");
      return {
        kind: "deny",
        result: {
          tool: call.tool,
          status: "failed",
          error: "Tool approval could not be completed.",
          latencyMs: Date.now() - startTime,
        },
      };
    } finally {
      // Cleanup: delete the key if still there. Use the main client;
      // the duplicate is about to be torn down.
      try {
        await this.redis!.del(redisKey);
      } catch {
        /* best-effort */
      }
      if (usingDuplicate) {
        try {
          (blockClient as any).disconnect?.();
        } catch {
          /* ignore */
        }
      }
    }
  }

  /**
   * Execute a single tool call on an entity backend.
   *
   * PIFSP-21 — optional `origin` marks the dispatch source so the MCP
   * gateway + wire-test + replay paths can be distinguished in the
   * audit log. Omit for standard agent-turn dispatches.
   */
  async execute(
    call: ToolCallRequest,
    scope: RequestScope,
    origin?: ToolCallOrigin,
    resolvedRoute?: ToolRouteConstraint,
  ): Promise<ToolCallResult> {
    const startTime = Date.now();
    const startNs = startTime * 1_000_000;
    const spanId = this.spansService?.nextSpanId();

    // Theme H.9 — pre-tool-invoke safety gate. Scans the stringified
    // params for PII + injection patterns and refuses dispatch on
    // high-severity hits (default policy). Records a safety event either
    // way so the governance dashboard reflects the scan.
    if (this.safetyService) {
      const scan = this.safetyService.scanToolParams(call.tool, call.params);
      const highSeverity = scan.flags.filter((f) => f.severity === "high");
      if (highSeverity.length > 0) {
        await this.safetyEventService?.record(
          {
            organizationId: scope.organizationId,
            projectId: scope.projectId,
            environmentId: scope.environmentId,
            operatorUserId: scope.operatorUserId,
          },
          {
            detector: "tool_param",
            action: "block",
            severity: "high",
            detail: `Tool ${call.tool} blocked: ${highSeverity[0]?.detail ?? "param scan"}`,
            meta: { flags: highSeverity },
            agentId: scope.agentId ?? null,
            threadId: scope.sessionId ?? null,
            userId: scope.userId ?? null,
            toolName: call.tool,
          },
        );
        return {
          tool: call.tool,
          status: "failed",
          error: `Tool call blocked by safety policy: ${highSeverity[0]?.detail ?? "param scan"}`,
          latencyMs: Date.now() - startTime,
        };
      }
      // Low/medium — warn only (don't block). Persist for the dashboard.
      for (const flag of scan.flags.filter((f) => f.severity !== "high")) {
        await this.safetyEventService?.record(
          {
            organizationId: scope.organizationId,
            projectId: scope.projectId,
            environmentId: scope.environmentId,
            operatorUserId: scope.operatorUserId,
          },
          {
            detector: "tool_param",
            action: "warn",
            severity: flag.severity,
            detail: `Tool ${call.tool}: ${flag.detail}`,
            meta: flag,
            agentId: scope.agentId ?? null,
            threadId: scope.sessionId ?? null,
            userId: scope.userId ?? null,
            toolName: call.tool,
          },
        );
      }
    }

    // Theme H.8 — per-(agent, user) tool-call rate limit. Only applied
    // when both agentId + userId are present on the scope (some internal
    // admin paths skip this deliberately).
    if (this.rateLimitService && scope.agentId && scope.userId) {
      try {
        const rl = await this.rateLimitService.checkToolCall(
          {
            organizationId: scope.organizationId,
            projectId: scope.projectId,
            environmentId: scope.environmentId,
          },
          scope.agentId,
          scope.userId,
        );
        if (!rl.allowed) {
          // PRELAUNCH-A3-4 — record the denial on the safety-event ledger
          // so governance timelines reflect tool-call rate-limit blocks.
          await this.safetyEventService?.record(
            {
              organizationId: scope.organizationId,
              projectId: scope.projectId,
              environmentId: scope.environmentId,
              operatorUserId: scope.operatorUserId,
            },
            {
              detector: "rate_limit",
              action: "block",
              severity: "medium",
              detail: `tool-call rate exceeded (limit ${rl.limit}/min)`,
              meta: { bucket: "agent_user_tool_per_minute", limit: rl.limit },
              agentId: scope.agentId ?? null,
              userId: scope.userId ?? null,
              toolName: call.tool,
            },
          );
          return {
            tool: call.tool,
            status: "failed",
            error: `Tool-call rate limit exceeded: ${rl.limit}/min. Retry in ${rl.retryAfterSeconds}s.`,
            latencyMs: Date.now() - startTime,
          };
        }
      } catch {
        // Fail-open on rate-limit backend errors.
      }
    }

    // Issue #1 — per-tool approval gate (feature-flagged via
    // PLATOS_TOOL_DISPATCH_PERMISSION_GATE=1). Runs after safety + rate
    // limit so cheap denials short-circuit before the more expensive
    // 4-tier resolver kicks in.
    //
    //   - kind: "allow" → continue. `params` is set when the operator
    //     edited the args during approval; we forward the edited shape
    //     to the entity. Falls back to `call.params` when unedited.
    //   - kind: "deny"  → block, reject, or timeout. Caller short-circuits.
    const gated = await this.checkDispatchPermission(call, scope, startTime);
    if (gated.kind === "deny") return gated.result;
    const dispatchedCall: ToolCallRequest =
      gated.params !== undefined
        ? { ...call, params: gated.params }
        : call;

    const inner = await this.executeInner(
      dispatchedCall,
      scope,
      startTime,
      origin,
      resolvedRoute,
    );
    const { result, toolId, entityId, entityPk } = inner;

    // Emit a tool.call span if a trace is open. The span carries scope tags
    // (via SpansService.record) plus per-call attributes for the trace viewer.
    if (this.spansService && scope.traceId && spanId) {
      const endNs = Date.now() * 1_000_000;
      await this.spansService.record(
        {
          organizationId: scope.organizationId,
          projectId: scope.projectId,
          environmentId: scope.environmentId,
          agentId: scope.agentId,
          threadId: scope.sessionId,
          userId: scope.userId,
          sessionContext: traceSessionContext(scope),
        },
        {
          traceId: scope.traceId,
          spanId,
          parentSpanId: scope.parentSpanId,
          name: "tool.call",
          kind: "client",
          startTimeUnixNano: startNs,
          endTimeUnixNano: endNs,
          durationMs: result.latencyMs,
          status: result.status === "success" ? "ok" : "error",
          errorMessage: result.status !== "success" ? result.error : undefined,
          attributes: {
            "platos.tool.name": call.tool,
            "platos.tool.status": result.status,
            "platos.tool.latency_ms": result.latencyMs,
            ...(call.purpose ? { "platos.tool.purpose": call.purpose } : {}),
          },
        },
      );
    }

    // Persist the audit row (Theme E.5). Fire-and-await so callers never see
    // the call complete before the audit is durable — the replay endpoint
    // relies on being able to look up the row by id immediately. Failures to
    // write are swallowed inside ToolAuditService.record.
    if (this.toolAuditService) {
      const auditId = await this.toolAuditService.record({
        scope: {
          organizationId: scope.organizationId,
          projectId: scope.projectId,
          environmentId: scope.environmentId,
        },
        toolId: toolId ?? null,
        toolName: call.tool,
        entityId: entityId ?? null,
        entityPk: entityPk ?? null,
        agentId: scope.agentId ?? null,
        threadId: scope.sessionId ?? null,
        userId: scope.userId ?? null,
        actorUserId: scope.operatorUserId ?? null,
        traceId: scope.traceId ?? null,
        spanId: spanId ?? null,
        parentSpanId: scope.parentSpanId ?? null,
        // Record the original caller-supplied args so a replay is a true
        // re-invocation, not a replay of any operator-injected defaults.
        args: call.params,
        result: result.status === "success" ? result.result ?? null : null,
        error: result.status !== "success" ? result.error ?? null : null,
        status: result.status,
        latencyMs: result.latencyMs,
        // PIFSP-21 — origin tagging. Nullable on purpose: rows from
        // pre-PIFSP-21 callers keep `source = null` (implicitly
        // `agent_turn` to readers).
        source: origin?.source ?? null,
        mcpUserId: origin?.mcpUserId ?? null,
        mcpClientId: origin?.mcpClientId ?? null,
        // MCP per-user isolation — persist the resolved end-user identity
        // (externalUserId) verbatim so the replay endpoint can reconstruct
        // `origin.endUserId` and re-dispatch to the same user (or fail closed
        // when null). Null for wire calls. Design §3.1.
        endUserId: origin?.endUserId ?? null,
      });
      if (auditId) {
        return { ...result, auditId };
      }
    }

    return result;
  }

  private async executeInner(
    call: ToolCallRequest,
    scope: RequestScope,
    startTime: number,
    origin?: ToolCallOrigin,
    resolvedRoute?: ToolRouteConstraint,
  ): Promise<{
    result: ToolCallResult;
    toolId?: string;
    entityId?: string;
    entityPk?: string;
  }> {

    // Resolve the tool's callback URL within this scope. If many entities in
    // the scope expose the same tool, we pick the first — callers who need a
    // specific entity can narrow beforehand via the registry.
    let scopedTools = this.toolRegistry.getScopedTools(scope, {
      enabledOnly: true,
      agentId: scope.agentId,
    });
    if (resolvedRoute) {
      scopedTools = scopedTools.filter(
        (tool) =>
          tool.entityPk === resolvedRoute.entityPk &&
          tool.sourceEntityId === resolvedRoute.entityId &&
          tool.toolId === resolvedRoute.toolId &&
          tool.environmentId === scope.environmentId,
      );
    }
    // Theme CTX.2 — Role 3 (tool-matrix routing). Narrow to tools belonging
    // to the entity_ids declared on `thread.sessionContext` before picking a
    // target. Ensures a tool-name collision across entities resolves to the
    // caller-declared one (union semantics). Empty / missing → untouched.
    const ctxMapExec = scope.contextMapping as ContextMapping | null | undefined;
    const ctxBagExec = scope.sessionContext;
    if (ctxMapExec && ctxBagExec) {
      const entKey = ctxMapExec.entityIdsKey || "entity_ids";
      const entIds = resolveCtxPath(ctxBagExec, entKey);
      scopedTools = filterToolsByEntityIds(scopedTools, entIds);
    }
    let toolEntry = scopedTools.find((t) => t.toolName === call.tool);

    if (!toolEntry) {
      // Dynamic-executor fallback — an entity can mark ONE of its tools with
      // `"x-dynamic-executor": true` in its registered param schema, declaring
      // "I can execute tool names beyond the registered set" (e.g. a gateway
      // whose search tool surfaces thousands of downstream action slugs like
      // GMAIL_SEND_EMAIL that would be absurd to register individually). When
      // the LLM calls such a discovered slug directly, re-route the call
      // through the executor tool as { tool_slug, arguments } instead of
      // failing TOOL_NOT_IN_SCOPE. One-level recursion only: the rewritten
      // name resolves (or fails) as a normal registered tool. The tool.call
      // span + audit row keep the ORIGINAL slug, which is the truthful record
      // of what the model asked for.
      //
      // FIX (2026-07-31) — the explicit-marker-only lookup here was dead code.
      // NOTHING sets `x-dynamic-executor`: it appears nowhere but the line that
      // read it — no docs, no validation, no warning for a gateway-shaped tool
      // that lacks it. Walle's `walle_execute_tool` registers with tool_slug /
      // slug / arguments / args / toolkit and no marker, so every direct slug
      // call fell straight through to the error below.
      //
      // Measured on the live deployment before this fix: 13 distinct slugs, 28
      // failed calls across Slack, Gmail, Google Calendar, Notion and Tavily,
      // spanning at least three days. `findDynamicExecutor` still prefers the
      // explicit marker but now also infers the executor from its shape, so a
      // correctly-shaped gateway works on registration.
      const dynamicExecutor = findDynamicExecutor(scopedTools, call.tool);
      if (dynamicExecutor) {
        // Use the executor's OWN parameter names — gateways differ (tool_slug vs
        // slug, arguments vs args), and hardcoding one pair would silently pass
        // an unrecognised key to any gateway that named them differently.
        const { slugKey, argsKey } = executorParamNames(dynamicExecutor);
        this.logger.log(
          `[tool-exec] re-routing unregistered slug "${call.tool}" through gateway "${dynamicExecutor.toolName}"`,
        );
        return this.executeInner(
          {
            ...call,
            tool: dynamicExecutor.toolName,
            params: { [slugKey]: call.tool, [argsKey]: call.params ?? {} },
          },
          scope,
          startTime,
          origin,
          resolvedRoute,
        );
      }
      return {
        result: {
          tool: call.tool,
          status: "failed",
          // The old text described a permissions failure regardless of cause, so
          // agents relayed it to users as "your integration is disconnected" —
          // which is what happened with Slack: the connection was fine and the
          // operator was sent to re-authenticate it anyway.
          error: toolNotFoundMessage(call.tool, scope, false),
          latencyMs: Date.now() - startTime,
        },
      };
    }

    if (origin?.source === "mcp_client") {
      call.params = stripReservedExternalArgumentEnvelopes(call.params);
    }

    // Get entity's service secret for HMAC signing.
    // PIFSP-3: `customParams` was the legacy per-entity arg-injection
    // mechanism. Column dropped; the agent-config "MCP arguments" editor
    // is the new home for per-tool defaults. CTX.6 below is the only
    // arg-resolution layer left.
    let serviceSecret: string;
    try {
      if (resolvedRoute) {
        const persistedRoute = await this.prisma.environmentEntityTool.findFirst({
          where: {
            environmentId: scope.environmentId,
            entityId: resolvedRoute.entityPk,
            toolId: resolvedRoute.toolId,
            enabled: true,
            entity: {
              externalId: resolvedRoute.entityId,
              projectId: scope.projectId,
              project: { organizationId: scope.organizationId },
            },
            tool: { name: call.tool },
          },
          select: {
            id: true,
            callbackUrl: true,
            tool: {
              select: {
                name: true,
                description: true,
                paramSchema: true,
                category: true,
              },
            },
          },
        });
        if (!persistedRoute) {
          return {
            result: {
              tool: call.tool,
              status: "failed",
              error: "Resolved tool route is no longer valid for this entity and environment",
              latencyMs: Date.now() - startTime,
            },
            toolId: resolvedRoute.toolId,
            entityId: resolvedRoute.entityId,
            entityPk: resolvedRoute.entityPk,
          };
        }
        toolEntry = {
          ...toolEntry,
          callbackUrl: persistedRoute.callbackUrl ?? "",
          toolName: persistedRoute.tool.name,
          description: persistedRoute.tool.description,
          paramSchema: persistedRoute.tool.paramSchema as Record<string, unknown>,
          category: persistedRoute.tool.category,
        };
      }
      // SECURITY (audit L2) — re-verify scope when re-loading the entity's
      // serviceSecret. The cache boundary holds today, so this is defense in
      // depth: a slip that yielded a cross-scope entityPk would otherwise hand
      // back another tenant's HMAC signing key. Entity is scoped
      // by (organizationId, projectId) only — it has NO environmentId column,
      // so do not add one here.
      // MCP-as-connected-entity (design Commit 4) — also load `connectionKind`
      // (the transport discriminator) and the 1:1 `mcpClient` transport config.
      // `mcpClient: true` inside a `select` returns the full related row (the
      // select-mode equivalent of `include: { mcpClient: true }`) while keeping
      // the read tight, per the audit-L2 defense-in-depth note above.
      const entity = await this.prisma.entity.findFirst({
        where: {
          id: resolvedRoute?.entityPk ?? toolEntry.entityPk,
          projectId: scope.projectId,
          project: { organizationId: scope.organizationId },
        },
        select: {
          id: true,
          externalId: true,
          projectId: true,
          connectionKind: true,
          mcpConfig: { select: { injectMcpContext: true } },
          mcpClient: {
            include: { credential: { select: { name: true } } },
          },
        },
      });
      if (!entity) {
        return {
          result: {
            tool: call.tool,
            status: "failed",
            error: `Entity ${toolEntry.sourceEntityId} not registered`,
            latencyMs: Date.now() - startTime,
          },
          toolId: toolEntry.toolId,
          entityId: toolEntry.sourceEntityId,
          entityPk: toolEntry.entityPk,
        };
      }
      toolEntry = {
        ...toolEntry,
        connectionKind: entity.connectionKind,
        entityMcpInjectContext: entity.mcpConfig?.injectMcpContext === true,
      };

      // ── connectionKind === "mcp" DISPATCH BRANCH (design §4) ───────────────
      // The single executor change. Fires BEFORE any wire read: no
      // `serviceSecret`, no HMAC, no `_context` envelope, no OIDC-token block,
      // no CTX.6 arg-injection, no WS/HTTP callback — all of those are wire-only.
      // An mcp entity is outbound: Platos is the CLIENT. Per-user identity flows
      // via `{{endUserId}}` substituted into the pooled client's URL/headers and
      // fails CLOSED when a template needs an end user we don't have (§3.2).
      // mcpDispatch never throws — it always returns the standard result shape,
      // so it is safe inside this try. `entity.connectionKind` defaults to
      // "wire" for every pre-migration row, so the wire path is untouched (AC7).
      if (entity.connectionKind === "mcp") {
        return await this.mcpDispatch(
          entity,
          entity.mcpClient ?? null,
          toolEntry,
          call,
          scope,
          origin,
          startTime,
        );
      }

      const credential = await this.prisma.credential.findFirst({
        where: {
          environmentId: scope.environmentId,
          kind: "ENTITY_SECRET",
          name: entity.externalId,
          revokedAt: null,
          environment: {
            projectId: scope.projectId,
            project: { organizationId: scope.organizationId },
          },
        },
        select: { name: true },
      });
      serviceSecret = credential
        ? (await this.mcpCredentials?.resolveEntitySigningCredential(
            {
              organizationId: scope.organizationId,
              projectId: scope.projectId,
              environmentId: scope.environmentId,
            },
            credential.name,
          )) ?? ""
        : "";
      if (!serviceSecret) {
        return {
          result: {
            tool: call.tool,
            status: "failed",
            error: `Entity ${toolEntry.sourceEntityId} signing credential is unavailable`,
            latencyMs: Date.now() - startTime,
          },
          toolId: toolEntry.toolId,
          entityId: toolEntry.sourceEntityId,
          entityPk: toolEntry.entityPk,
        };
      }

      // Theme CTX.6 — 4-tier resolution (constant → session-override →
      // auto-match → LLM). Operator intent (constant / explicit mapping)
      // wins over everything except LLM-provided args, which are preserved
      // verbatim. Fail-open on every error (catches schema-less tools,
      // missing session context, etc.).
      //
      // Keep the CTX.2 path as a fallback for rows that predate CTX.6 AND
      // don't have a paramSchema on the registry entry — the automap
      // resolver needs a schema to enumerate params.
      try {
        const toolSchema = (toolEntry as { paramSchema?: unknown }).paramSchema;
        if (toolSchema && ctxMapExec) {
          const resolved = resolveCtxToolMappings(
            { name: call.tool, inputSchema: toolSchema },
            { contextMapping: ctxMapExec as AgentContextMapping | null | undefined },
            ctxBagExec ?? null,
          );
          call.params = applyCtxResolutions(resolved, call.params, ctxBagExec ?? null);
        } else if (ctxMapExec?.toolArgInjection && ctxBagExec) {
          // Legacy CTX.2 flat mapping fallback (no paramSchema available).
          const argMap = ctxMapExec.toolArgInjection[call.tool];
          if (argMap && typeof argMap === "object") {
            // Filter to string values — the CTX.6 shape allows booleans for _auto.
            const flat: Record<string, string> = {};
            for (const [k, v] of Object.entries(argMap as Record<string, unknown>)) {
              if (typeof v === "string" && k !== "_auto") flat[k] = v;
            }
            call.params = injectCtxArgs(call.params, flat, ctxBagExec);
          }
        }
      } catch {
        // Fail-open — never let a bad mapping break tool dispatch.
      }
    } catch (error) {
      return {
        result: {
          tool: call.tool,
          status: "failed",
          error: `Failed to load entity config: ${error}`,
          latencyMs: Date.now() - startTime,
        },
        toolId: toolEntry.toolId,
        entityId: toolEntry.sourceEntityId,
        entityPk: toolEntry.entityPk,
      };
    }

    // Theme CTX.2 — Role 4 (WS envelope). Build the `_context` object from
    // `contextMapping.envelopeKeys` → entity backends read per-session
    // identity / tenant metadata without the value being visible to the
    // LLM or a re-signable arg. Gets merged into the `arguments` payload
    // alongside the tool's normal params so the same body can be signed
    // and shipped over both WS and HTTP transports.
    let ctxEnvelope: Record<string, unknown> | undefined;
    if (ctxMapExec && ctxBagExec) {
      ctxEnvelope = buildCtxEnvelope(ctxBagExec, ctxMapExec.envelopeKeys);
    }
    // PIFSP-21 — origin fields flow through the same envelope so entity
    // backends see `_context.source = "mcp_client"` (+ mcpUserId +
    // mcpClientId) alongside whatever the CTX.2 envelopeKeys produced.
    // Origin wins over session-context values on key collision — source
    // identity is authoritative at dispatch-time.
    //
    // MCPF-followup: per-entity opt-in via
    // `PlatosEntityMcpConfig.injectMcpContext` (default false). Entity
    // backends whose tool functions don't accept unexpected kwargs would
    // crash on `TypeError: <fn>() got an unexpected keyword argument
    // '_context'` — this used to be unconditional. Operators flip the
    // flag once their backend is on a platools-py version that handles
    // the envelope (or has a wrapper that pops `_context` before the
    // handler runs). CTX.2 envelopeKeys (agent contextMapping) is
    // unaffected — that path is already opt-in via the agent config.
    if (
      origin &&
      (origin.source || origin.mcpUserId || origin.mcpClientId) &&
      toolEntry.entityMcpInjectContext === true
    ) {
      ctxEnvelope = {
        ...(ctxEnvelope ?? {}),
        ...(origin.source ? { source: origin.source } : {}),
        ...(origin.mcpUserId ? { mcpUserId: origin.mcpUserId } : {}),
        ...(origin.mcpClientId ? { mcpClientId: origin.mcpClientId } : {}),
      };
    }

    // PIFSP-22 gap-3 — OIDC entity token forwarding. When the MCP user
    // authenticated via entity-delegated OIDC, look up their session and
    // attach the entity-issued access token as X-Platos-Entity-Token.
    // The entity backend validates this token with its own auth system —
    // it knows who the real user is without trusting Platos' claim.
    // Fail-open: a missing/expired token means the entity sees no token
        // header and must handle that gracefully (e.g. 401 → require re-auth).
    let entityAccessToken: string | undefined;
    if (origin?.mcpUserId && origin.mcpUserId.startsWith("mcp:oidc:")) {
      try {
        const oidcSession = await this.prisma.mcpOidcSession.findFirst({
          where: {
            environmentId: scope.environmentId,
            entityId: toolEntry.entityPk,
            mcpUserId: origin.mcpUserId,
            revokedAt: null,
          },
          select: { credential: { select: { name: true } } },
        });
        if (oidcSession?.credential?.name && this.mcpCredentials) {
          entityAccessToken = await this.mcpCredentials.resolveCredentialReference(
            {
              organizationId: scope.organizationId,
              projectId: scope.projectId,
              environmentId: scope.environmentId,
            },
            oidcSession.credential.name,
          );
        }
      } catch {
        // Fail-open — never let a session lookup break tool dispatch.
      }
    }
    const argumentsWithCtx = ctxEnvelope
      ? { ...call.params, _context: ctxEnvelope }
      : call.params;

    // Build the MCP request body
    const body = JSON.stringify({
      method: "tools/call",
      params: {
        name: call.tool,
        arguments: argumentsWithCtx,
      },
    });

    const timestamp = new Date().toISOString();
    // PPR-71: per-request nonce closes the replay window within skew.
    // Signing string is now `{ts}.{nonce}.{body}` — the SDK accepts the
    // legacy `{ts}.{body}` form for one release (PPR-71 back-compat). See
    // docs/tool-gateway.md §HMAC.
    const nonce = crypto.randomBytes(16).toString("hex");
    const signature = this.sign(body, serviceSecret, timestamp, nonce);

    // PPR-30: pre-generate the callId here so we can embed it in the
    // `__platos` envelope *and* hand it to `dispatchToolCall` as the outer
    // wire-frame `call_id`. Keeps the SDK's `currentCallId()` /
    // `ctx.callId` in lockstep with the platform's per-call id without the
    // SDK having to synthesize it from the outer message.
    const callId = crypto.randomUUID();

    // Primary: if the entity has an active WS connection in this env, dispatch
    // via WS. Otherwise fall through to HTTP callback.
    if (
      this.wsService &&
      this.wsService.isEntityConnected(toolEntry.sourceEntityId, scope.environmentId)
    ) {
      try {
        const paramsWithScope: Record<string, unknown> = {
          ...argumentsWithCtx,
          __platos: {
            organizationId: scope.organizationId,
            projectId: scope.projectId,
            environmentId: scope.environmentId,
            entityId: toolEntry.sourceEntityId,
            userId: scope.userId,
            ...(scope.userToken ? { userToken: scope.userToken } : {}),
            agentId: scope.agentId || "default",
            threadId: scope.sessionId || "",
            callId,
            timestamp,
            nonce,
            signature,
            // PIFSP-22 gap-3 — entity-issued token for OIDC identity delegation.
            ...(entityAccessToken ? { entityToken: entityAccessToken } : {}),
          },
        };
        const res = await this.wsService.dispatchToolCall(
          toolEntry.sourceEntityId,
          scope.environmentId,
          call.tool,
          paramsWithScope,
          30_000,
          callId,
        );
        const latencyMs = Date.now() - startTime;
        await this.recordHealth(toolEntry.toolId, toolEntry.sourceEntityId, scope.environmentId, "success", latencyMs);
        return {
          result: { tool: call.tool, status: "success", result: res.result, latencyMs },
          toolId: toolEntry.toolId,
          entityId: toolEntry.sourceEntityId,
          entityPk: toolEntry.entityPk,
        };
      } catch (err: any) {
        const latencyMs = Date.now() - startTime;
        const errorMsg = err?.message || "WS dispatch failed";
        const isTimeout = errorMsg.includes("timed out");
        const status = isTimeout ? "timeout" : "failed";
        await this.recordHealth(toolEntry.toolId, toolEntry.sourceEntityId, scope.environmentId, status, latencyMs);
        return {
          result: { tool: call.tool, status, error: errorMsg, latencyMs },
          toolId: toolEntry.toolId,
          entityId: toolEntry.sourceEntityId,
          entityPk: toolEntry.entityPk,
        };
      }
    }

    // Fallback: HTTP callback. Used when the entity registered an explicit
    // callback_url but doesn't maintain a WebSocket (legacy MCP backends).
    // EOBD.10 follow-up — callback_url was entity-supplied via
    // `tool_register` (tool-sync-ws.service.ts). A misconfigured or
    // compromised entity could register `http://169.254.169.254/...`
    // and every tool call would POST to AWS IMDS. Validate at dispatch.
    {
      const cbCheck = await validatePublicUrl(toolEntry.callbackUrl);
      if (!cbCheck.ok) {
        throw new Error(
          `entity callback URL blocked: ${describeUrlValidationError(cbCheck.error)}`,
        );
      }
    }
    try {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 30000);

      // EOBD.40 — propagate traceparent to the entity backend so a
      // customer using OTel on their side can join our agent turn span
      // to their tool handler span. Format: `00-<traceId>-<spanId>-01`
      // (sampled). spanId here is a fresh per-request id so the entity
      // can parent its work to *this* HTTP call specifically.
      const traceparent =
        scope.traceId && /^[0-9a-f]{32}$/i.test(scope.traceId)
          ? `00-${scope.traceId}-${crypto.randomBytes(8).toString("hex")}-01`
          : undefined;
      const response = await fetchWithValidatedRedirects(toolEntry.callbackUrl, 3, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-Platos-Signature": signature,
          "X-Platos-Organization-Id": scope.organizationId,
          "X-Platos-Project-Id": scope.projectId,
          "X-Platos-Environment-Id": scope.environmentId,
          "X-Platos-Entity-Id": toolEntry.sourceEntityId,
          "X-Platos-User-Id": scope.userId,
          ...(scope.userToken ? { "X-Platos-User-Token": scope.userToken } : {}),
          "X-Platos-Agent-Id": scope.agentId || "default",
          "X-Platos-Thread-Id": scope.sessionId || "",
          "X-Platos-Call-Id": callId,
          "X-Platos-Timestamp": timestamp,
          "X-Platos-Nonce": nonce,
          // PIFSP-22 gap-3 — entity-issued token for OIDC identity delegation.
          // The entity verifies this with its own auth system (Google, email, etc.)
          // to identify the real user without trusting Platos' claims alone.
          ...(entityAccessToken ? { "X-Platos-Entity-Token": entityAccessToken } : {}),
          ...(traceparent ? { traceparent } : {}),
        },
        body,
        signal: controller.signal,
      });

      clearTimeout(timeout);

      const latencyMs = Date.now() - startTime;

      if (!response.ok) {
        const errorText = await response.text().catch(() => "Unknown error");
        await this.recordHealth(toolEntry.toolId, toolEntry.sourceEntityId, scope.environmentId, "failed", latencyMs);
        // Surface entity-backend rate limits as a structured tool result so
        // the LLM can react (wait, retry, or pick a different tool) instead
        // of crashing the turn. Honour the Retry-After header when present.
        if (response.status === 429) {
          const retryHeader = response.headers.get("retry-after");
          const retryAfterSeconds = retryHeader && /^\d+$/.test(retryHeader)
            ? parseInt(retryHeader, 10)
            : 30;
          const rateLimitPayload = {
            error: "rate_limit",
            message: `Tool '${call.tool}' rate limited by entity backend. Try again in ${retryAfterSeconds} seconds.`,
            retryAfterSeconds,
          };
          return {
            result: {
              tool: call.tool,
              status: "failed",
              error: `rate_limit: retry in ${retryAfterSeconds}s`,
              result: rateLimitPayload,
              latencyMs,
            },
            toolId: toolEntry.toolId,
            entityId: toolEntry.sourceEntityId,
            entityPk: toolEntry.entityPk,
          };
        }
        return {
          result: { tool: call.tool, status: "failed", error: `HTTP ${response.status}: ${errorText}`, latencyMs },
          toolId: toolEntry.toolId,
          entityId: toolEntry.sourceEntityId,
          entityPk: toolEntry.entityPk,
        };
      }

      const result = await response.json();
      await this.recordHealth(toolEntry.toolId, toolEntry.sourceEntityId, scope.environmentId, "success", latencyMs);

      return {
        result: { tool: call.tool, status: "success", result, latencyMs },
        toolId: toolEntry.toolId,
        entityId: toolEntry.sourceEntityId,
        entityPk: toolEntry.entityPk,
      };
    } catch (error: unknown) {
      const latencyMs = Date.now() - startTime;
      const isTimeout = error instanceof Error && error.name === "AbortError";
      const status = isTimeout ? "timeout" : "failed";
      const errorMsg = error instanceof Error ? error.message : "Unknown error";

      await this.recordHealth(toolEntry.toolId, toolEntry.sourceEntityId, scope.environmentId, status, latencyMs);
      return {
        result: { tool: call.tool, status, error: errorMsg, latencyMs },
        toolId: toolEntry.toolId,
        entityId: toolEntry.sourceEntityId,
        entityPk: toolEntry.entityPk,
      };
    }
  }

  /**
   * MCP-as-connected-entity dispatch (design §3.2 / §4) — the outbound path for
   * a `connectionKind === "mcp"` entity. Platos is the CLIENT here: it resolves
   * the per-user URL + headers, then calls the external server through a pooled
   * official-SDK `Client`. There is no HMAC handshake, no callback URL, no
   * `_context` envelope, and no OIDC-token block — those are all wire-only.
   *
   * The per-user isolation invariant is enforced twice, belt-and-suspenders:
   *   1. `resolveUrl` / `resolveHeaders` THROW `McpCredentialError` when a
   *      template references `{{endUserId}}` and no end user is resolved — the
   *      throw is caught here and surfaced as a structured failure with ZERO
   *      bytes upstream (no pool `getClient`, no `callTool`).
   *   2. A final post-substitution scan on the resolved URL + every resolved
   *      header value: if the literal `{{endUserId}}` survived (a substitution
   *      bug), refuse before touching the pool/transport. We NEVER fall back to
   *      `scope.userId`, an org id, or any shared identity (AC3 + AC4).
   * A pooled `Client` is therefore only ever built from fully-substituted
   * url+headers, and the pool key includes both (§3.3), so two users can never
   * share a session even if a wrong value slipped through.
   *
   * Never throws — always returns the standard `{ result, toolId, entityId,
   * entityPk }` shape so the `execute()` wrapper records health + audit (with
   * `entityPk` now dereferencing a real `Entity`). Redaction: it
   * never logs resolved headers or a resolved URL, per the McpCredentialService
   * contract (AC7).
   */
  private async mcpDispatch(
    entity: { id: string; externalId: string },
    mcpClient:
      | {
          transport: string;
          url?: string | null;
          headersTemplate?: unknown;
          credential?: { name: string } | null;
        }
      | null,
    toolEntry: OrgToolEntry,
    call: ToolCallRequest,
    scope: RequestScope,
    origin: ToolCallOrigin | undefined,
    startTime: number,
  ): Promise<{
    result: ToolCallResult;
    toolId?: string;
    entityId?: string;
    entityPk?: string;
  }> {
    const ids = {
      toolId: toolEntry.toolId,
      entityId: toolEntry.sourceEntityId,
      entityPk: toolEntry.entityPk,
    };
    // Every return path records health (like the wire path) + carries the ids so
    // the audit row is attributed. `extra` supplies error/result.
    const done = async (
      status: "success" | "failed" | "timeout",
      extra: { error?: string; result?: unknown },
    ) => {
      const latencyMs = Date.now() - startTime;
      await this.recordHealth(
        ids.toolId,
        ids.entityId,
        scope.environmentId,
        status,
        latencyMs,
      ).catch(() => {});
      return { result: { tool: call.tool, status, latencyMs, ...extra }, ...ids };
    };

    // The pool + credential resolver are ToolGatewayModule providers; missing
    // only in a bare test fixture. Fail structured rather than NPE.
    if (!this.mcpCredentials || !this.mcpPool) {
      return await done("failed", {
        error: "MCP transport not wired in this process",
      });
    }

    try {
      if (!mcpClient) {
        return await done("failed", {
          error: "MCP entity has no transport configuration (mcpClient row missing)",
        });
      }
      const transport = mcpClient.transport;
      if (transport !== "remote-http" && transport !== "remote-sse") {
        if (transport === "stdio") {
          return await done("failed", {
            error: "stdio transport dispatch not yet implemented (K.10)",
          });
        }
        if (typeof transport === "string" && transport.startsWith("hosted-")) {
          return await done("failed", {
            error: `hosted transport dispatch not yet implemented: ${transport}`,
          });
        }
        return await done("failed", {
          error: `unsupported MCP transport: ${transport}`,
        });
      }
      // Capture into a local so the non-null narrowing is robust (variable, not
      // property, narrowing) across the resolver call below.
      const urlTemplate = mcpClient.url;
      if (!urlTemplate) {
        return await done("failed", {
          error: "mcpClient.url missing for remote transport",
        });
      }

      // Per-user identity from the origin. NEVER `scope.userId` — a missing id
      // must fail closed, not silently reuse the operator/session identity.
      const endUserId = origin?.endUserId ?? null;
      const scopeTuple = {
        organizationId: scope.organizationId,
        projectId: scope.projectId,
        environmentId: scope.environmentId,
      };

      // Fail-closed resolution (§3.2). Both may THROW McpCredentialError on a
      // templated-but-unlinked `{{endUserId}}` (or a `{{secret}}` that can't be
      // resolved) — caught below, surfaced structured, zero bytes upstream. The
      // secret (if any) is fetched lazily per-env via ScopedEnvService.
      const resolvedUrl = this.mcpCredentials.resolveUrl(urlTemplate, endUserId);
      const resolvedHeaders = await this.mcpCredentials.resolveHeaders(
        mcpClient,
        scopeTuple,
        endUserId,
      );

      // Belt-and-suspenders dispatch-boundary scan (§3.2). If `{{endUserId}}`
      // survived substitution anywhere, refuse before ANY pool/transport touch.
      // The predicate lives beside the resolver (ONE source of truth for the
      // token literal) and has its own unit test (design Commit 2 / GAP-6).
      if (hasResidualEndUserTemplate(resolvedUrl, resolvedHeaders)) {
        return await done("failed", { error: "tool requires a linked user" });
      }

      // Cheap early SSRF reject; the pool re-validates + address-pins every hop
      // of every request too (defense in depth). Never surfaces header/secret.
      const urlCheck = await validatePublicUrl(resolvedUrl);
      if (!urlCheck.ok) {
        return await done("failed", {
          error: `MCP server URL blocked: ${describeUrlValidationError(urlCheck.error)}`,
        });
      }

      // Only fully-substituted url+headers reach the pool; the key includes both
      // so per-user sessions never collide (§3.3).
      const sdkClient = await this.mcpPool.getClient({
        server: { id: entity.id },
        resolvedUrl,
        resolvedHeaders,
        transportKind: transport,
      });
      const callRes: any = await sdkClient.callTool(
        {
          name: call.tool,
          arguments: (call.params ?? {}) as Record<string, unknown>,
        },
        undefined,
        { timeout: env.MCP_CALL_TIMEOUT_MS ?? 30_000 },
      );

      // The SDK returns `{ content, isError? }` for a tool-level error rather
      // than throwing; a transport/protocol error throws (caught below). Pass
      // the full result through either way so the LLM sees the content.
      const isErr =
        callRes && typeof callRes === "object" && callRes.isError === true;
      return await done(isErr ? "failed" : "success", {
        result: callRes,
        ...(isErr ? { error: "MCP tool returned an error result" } : {}),
      });
    } catch (err: any) {
      // Covers the fail-closed McpCredentialError throw ("tool requires a linked
      // end user"), secret-resolution failures, and transport/timeout errors.
      const msg = err?.message ? String(err.message) : "MCP dispatch failed";
      const isTimeout = /timed?\s*out|timeout/i.test(msg);
      return await done(isTimeout ? "timeout" : "failed", { error: msg });
    }
  }

  /**
   * Execute multiple tool calls in parallel.
   * Each call runs independently — one failure doesn't affect others.
   *
   * `origin` (design Commit 4) is forwarded into every `execute()` so the
   * turn-loop + skill entry points can carry the resolved end-user identity all
   * the way to `mcpDispatch`. Optional + defaulted, so the many 2-arg wire call
   * sites are unaffected. Without this forward, every `{{endUserId}}` MCP tool
   * invoked from a live turn or a skill would fail closed — a functional
   * regression, not just an isolation gap.
   */
  async executeBatch(
    calls: ToolCallRequest[],
    scope: RequestScope,
    origin?: ToolCallOrigin,
    resolvedRoute?: ToolRouteConstraint,
  ): Promise<ToolCallResult[]> {
    return Promise.all(
      calls.map((call) => this.execute(call, scope, origin, resolvedRoute)),
    );
  }

  /**
   * Record tool health metrics after a call.
   */
  private async recordHealth(
    toolId: string,
    entityExternalId: string,
    environmentId: string,
    status: string,
    latencyMs: number,
  ): Promise<void> {
    try {
      await this.prisma.toolHealth.upsert({
        where: {
          environmentId_toolId_entityExternalId: {
            environmentId,
            toolId,
            entityExternalId,
          },
        },
        update: {
          lastCalledAt: new Date(),
          lastStatus: status,
          failCount: status === "success" ? 0 : { increment: 1 },
          totalCalls: { increment: 1 },
          totalFailures: status !== "success" ? { increment: 1 } : undefined,
          // Simple running average for latency
          avgLatencyMs: latencyMs,
        },
        create: {
          toolId,
          entityExternalId,
          environmentId,
          lastCalledAt: new Date(),
          lastStatus: status,
          failCount: status === "success" ? 0 : 1,
          totalCalls: 1,
          totalFailures: status !== "success" ? 1 : 0,
          avgLatencyMs: latencyMs,
        },
      });
    } catch (error) {
      console.error("[Platos ToolHealth] Failed to record:", error);
    }
  }

  /**
   * HMAC-SHA256 signature for authenticating tool calls to entity backends.
   *
   * PPR-71: signing string includes a per-request nonce — `{ts}.{nonce}.{body}`.
   * The SDK pairs this with a per-entity LRU of seen nonces so a captured
   * request inside the skew window can't be replayed. Legacy `{ts}.{body}`
   * form is accepted by the SDK for one release to allow rolling deploys.
   */
  private sign(body: string, secret: string, timestamp: string, nonce: string): string {
    const message = `${timestamp}.${nonce}.${body}`;
    return crypto.createHmac("sha256", secret).update(message).digest("hex");
  }
}
