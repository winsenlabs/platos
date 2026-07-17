import { Injectable, Inject, Optional } from "@nestjs/common";
import { PRISMA_TOKEN } from "../shared/database.provider";
import { ToolRegistryService, type OrgToolEntry } from "./tool-registry.service";
import { ToolSyncWsService } from "./tool-sync-ws.service";
import { SpansService } from "../monitoring/spans.service";
import { ToolAuditService } from "../monitoring/tool-audit.service";
import { SafetyService } from "../monitoring/safety.service";
import { SafetyEventService } from "../monitoring/safety-event.service";
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
} from "../shared/url-validator";
import type { RequestScope } from "../auth/scope.guard";
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
    // the gate flag is set, `require_approval` triggers a real
    // persisted approval + Socket.IO event + BLPOP wait.
    @Optional() private readonly approvalsService?: MonitoringApprovalsService,
    @Optional() @Inject(REDIS_TOKEN) private readonly redis?: Redis,
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
   * Fails open on any infrastructure error so the gate is strict
   * defense-in-depth, never the failure point that loses a dispatch.
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
    if (!this.permissionGateway) return { kind: "allow" };
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
    } catch (err) {
      // Fail-open on resolver errors — the gate is defense-in-depth,
      // not the primary safety mechanism. Safety + rate-limit gates
      // above still ran.
      return { kind: "allow" };
    }
    if (resolved.state === "auto_allow") return { kind: "allow" };

    // Record the gate decision on the safety-event ledger so the
    // governance dashboard reflects every block / pending-approval.
    await this.safetyEventService?.record(
      {
        organizationId: scope.organizationId,
        projectId: scope.projectId,
        environmentId: scope.environmentId,
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
    } catch (err: any) {
      return {
        kind: "deny",
        result: {
          tool: call.tool,
          status: "failed",
          error: `Tool ${call.tool} requires approval; failed to persist approval row: ${err?.message ?? String(err)}`,
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
    } catch (err: any) {
      return {
        kind: "deny",
        result: {
          tool: call.tool,
          status: "failed",
          error: `Tool ${call.tool} approval wait failed: ${err?.message ?? String(err)}`,
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

    const inner = await this.executeInner(dispatchedCall, scope, startTime, origin);
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
          sessionContext: (scope as any).sessionContext as
            | { user?: { name?: string; email?: string } }
            | null
            | undefined,
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
  ): Promise<{
    result: ToolCallResult;
    toolId?: string;
    entityId?: string;
    entityPk?: string;
  }> {

    // Resolve the tool's callback URL within this scope. If many entities in
    // the scope expose the same tool, we pick the first — callers who need a
    // specific entity can narrow beforehand via the registry.
    let scopedTools = this.toolRegistry.getScopedTools(scope);
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
    const toolEntry = scopedTools.find((t) => t.toolName === call.tool);

    if (!toolEntry) {
      return {
        result: {
          tool: call.tool,
          status: "failed",
          error: `Tool "${call.tool}" not found or not enabled for scope org=${scope.organizationId} project=${scope.projectId} env=${scope.environmentId}`,
          latencyMs: Date.now() - startTime,
        },
      };
    }

    // Get entity's service secret for HMAC signing.
    // PIFSP-3: `customParams` was the legacy per-entity arg-injection
    // mechanism. Column dropped; the agent-config "MCP arguments" editor
    // is the new home for per-tool defaults. CTX.6 below is the only
    // arg-resolution layer left.
    let serviceSecret: string;
    try {
      const entity = await this.prisma.platosConnectedEntity.findUnique({
        where: { id: toolEntry.entityPk },
        select: { serviceSecret: true, entityId: true, organizationId: true, projectId: true },
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
      serviceSecret = entity.serviceSecret;

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
    // header and must handle that gracefully (e.g. 401 → trigger re-auth).
    let entityAccessToken: string | undefined;
    if (origin?.mcpUserId && origin.mcpUserId.startsWith("mcp:oidc:")) {
      try {
        const oidcSession = await this.prisma.platosMcpOidcSession.findUnique({
          where: { mcpUserId: origin.mcpUserId },
          select: { entityAccessToken: true, revokedAt: true, entityTokenExpiresAt: true },
        });
        if (
          oidcSession &&
          !oidcSession.revokedAt &&
          oidcSession.entityAccessToken &&
          (!oidcSession.entityTokenExpiresAt || oidcSession.entityTokenExpiresAt > new Date())
        ) {
          const { OAuthController } = await import("../oauth/oauth.controller");
          entityAccessToken = OAuthController.decryptEntityToken(oidcSession.entityAccessToken);
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
        await this.recordHealth(toolEntry.toolId, toolEntry.entityPk, scope.environmentId, "success", latencyMs);
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
        await this.recordHealth(toolEntry.toolId, toolEntry.entityPk, scope.environmentId, status, latencyMs);
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
      const response = await fetch(toolEntry.callbackUrl, {
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
        await this.recordHealth(toolEntry.toolId, toolEntry.entityPk, scope.environmentId, "failed", latencyMs);
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
      await this.recordHealth(toolEntry.toolId, toolEntry.entityPk, scope.environmentId, "success", latencyMs);

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

      await this.recordHealth(toolEntry.toolId, toolEntry.entityPk, scope.environmentId, status, latencyMs);
      return {
        result: { tool: call.tool, status, error: errorMsg, latencyMs },
        toolId: toolEntry.toolId,
        entityId: toolEntry.sourceEntityId,
        entityPk: toolEntry.entityPk,
      };
    }
  }

  /**
   * Execute multiple tool calls in parallel.
   * Each call runs independently — one failure doesn't affect others.
   */
  async executeBatch(
    calls: ToolCallRequest[],
    scope: RequestScope,
  ): Promise<ToolCallResult[]> {
    return Promise.all(calls.map((call) => this.execute(call, scope)));
  }

  /**
   * Record tool health metrics after a call.
   */
  private async recordHealth(
    toolId: string,
    entityPk: string,
    environmentId: string,
    status: string,
    latencyMs: number,
  ): Promise<void> {
    try {
      await this.prisma.platosToolHealth.upsert({
        where: {
          toolId_entityId_environmentId: { toolId, entityId: entityPk, environmentId },
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
          entityId: entityPk,
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
