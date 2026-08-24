import { Body, Controller, Headers, HttpException, HttpStatus, Post } from "@nestjs/common";
import { createHmac, timingSafeEqual } from "node:crypto";
import { ToolExecutorService } from "../tool-gateway/tool-executor.service";
import { ScopedEnvService } from "../providers/scoped-env.service";
import { AgentTaskService } from "../agent-runtime/agent-task.service";
import { ConversationService } from "../memory/conversation.service";
import { SUBAGENT_MAX_DEPTH } from "../agent-runtime/subagent-guardrails";
import type { RequestScope } from "../auth/scope.guard";
import { env } from "../shared/env";

/**
 * Internal HMAC-signed callback endpoint.
 *
 * Trigger.dev tasks don't have access to per-entity credentials or the tool
 * registry — so when a durable task needs to actually call an entity's tool,
 * it POSTs here. The agent service validates the HMAC signature, looks up the
 * tool in the registry, calls the entity's backend on behalf of the task, and
 * returns the result.
 *
 * Request:
 *   POST /internal/execute-tool
 *   X-Platos-Signature: HMAC-SHA256(body, PLATOS_COMPONENT_AUTH_SECRET)
 *   X-Platos-Timestamp: ISO8601 (must be <5min ago)
 *   { organizationId, projectId, environmentId, userId, agentId, tool, params }
 *
 * Response:
 *   { status: "success" | "failed", result?: unknown, error?: string, latencyMs: number }
 *
 * BLOCK 2: wire into tool-gateway for actual execution.
 */

const DEV_COMPONENT_AUTH_SECRET = "dev-internal-secret-change-me";
const MAX_CLOCK_SKEW_MS = 5 * 60 * 1000; // 5 min

@Controller("internal")
export class InternalExecuteToolController {
  constructor(
    private readonly toolExecutor: ToolExecutorService,
    private readonly scopedEnv: ScopedEnvService,
    // W.1 — AgentTaskService is injected from AgentRuntimeModule
    // (imported via forwardRef into TriggerBridgeModule) to service the
    // /internal/batch-turn endpoint. Used by the `agent_batch` durable
    // executor to run one agent turn per batch item.
    private readonly agentTaskService: AgentTaskService,
    // Subagent spawning — ConversationService (from MemoryModule) mints the
    // CHILD thread with parentThreadId lineage on the first /internal/subagent-turn
    // call so multi-turn history accumulates on one thread.
    private readonly conversationService: ConversationService,
  ) {}

  /**
   * EOBD.39 — invalidate the scoped-env cache for a (scope, varName) or the
   * whole scope. Called by the webapp after a SecretStore write so the
   * agent picks up new keys within one request cycle instead of waiting
   * up to 30s for the positive-cache TTL to roll over.
   *
   * Same HMAC + timestamp guard as /execute-tool — this endpoint is
   * internal-only and the webapp signs the call with
   * PLATOS_COMPONENT_AUTH_SECRET.
   */
  @Post("env/invalidate")
  async invalidateEnv(
    @Headers("x-platos-signature") signature: string | undefined,
    @Headers("x-platos-timestamp") timestamp: string | undefined,
    @Body() body: {
      organizationId: string;
      projectId: string;
      environmentId: string;
      name?: string;
    },
  ) {
    this.verifySignature(signature, timestamp, body);
    this.scopedEnv.invalidate(
      {
        organizationId: body.organizationId,
        projectId: body.projectId,
        environmentId: body.environmentId,
      },
      body.name,
    );
    return { ok: true };
  }

  private verifySignature(
    signature: string | undefined,
    timestamp: string | undefined,
    body: unknown,
  ): void {
    if (!timestamp) {
      throw new HttpException("Missing X-Platos-Timestamp", HttpStatus.UNAUTHORIZED);
    }
    const ts = Date.parse(timestamp);
    if (Number.isNaN(ts) || Math.abs(Date.now() - ts) > MAX_CLOCK_SKEW_MS) {
      throw new HttpException("Timestamp out of window", HttpStatus.UNAUTHORIZED);
    }
    if (!signature) {
      throw new HttpException("Missing X-Platos-Signature", HttpStatus.UNAUTHORIZED);
    }
    const expected = createHmac(
      "sha256",
      env.PLATOS_COMPONENT_AUTH_SECRET || DEV_COMPONENT_AUTH_SECRET,
    )
      .update(JSON.stringify(body) + timestamp)
      .digest("hex");
    const sigBuf = Buffer.from(signature, "hex");
    const expBuf = Buffer.from(expected, "hex");
    if (sigBuf.length !== expBuf.length || !timingSafeEqual(sigBuf, expBuf)) {
      throw new HttpException("Invalid signature", HttpStatus.UNAUTHORIZED);
    }
  }

  @Post("execute-tool")
  async executeTool(
    @Headers("x-platos-signature") signature: string | undefined,
    @Headers("x-platos-timestamp") timestamp: string | undefined,
    @Body() body: {
      organizationId: string;
      projectId: string;
      environmentId: string;
      userId: string;
      agentId: string;
      tool: string;
      params: Record<string, unknown>;
      purpose?: string;
      scopeExtras?: {
        sessionId?: string;
        userToken?: string;
        entityId?: string;
        traceId?: string;
        parentSpanId?: string;
      };
      origin?: { agentId?: string; threadId?: string; callId?: string };
      // MCP-as-connected-entity (design §7) — the resolved end-user identity
      // (externalUserId) threaded through the HMAC-signed payload so a
      // connectionKind="mcp" tool invoked from a durable Trigger.dev task can
      // substitute `{{endUserId}}`. Absent ⇒ a templated mcp tool fails closed
      // at the §3.2 guard (correct — a durable task with no reconstructed end
      // user cannot silently borrow a shared identity).
      endUserId?: string;
    },
  ) {
    if (!timestamp) {
      throw new HttpException("Missing X-Platos-Timestamp", HttpStatus.UNAUTHORIZED);
    }
    const ts = Date.parse(timestamp);
    if (Number.isNaN(ts) || Math.abs(Date.now() - ts) > MAX_CLOCK_SKEW_MS) {
      throw new HttpException("Timestamp out of window", HttpStatus.UNAUTHORIZED);
    }

    if (!signature) {
      throw new HttpException("Missing X-Platos-Signature", HttpStatus.UNAUTHORIZED);
    }
    const expected = createHmac(
      "sha256",
      env.PLATOS_COMPONENT_AUTH_SECRET || DEV_COMPONENT_AUTH_SECRET,
    )
      .update(JSON.stringify(body) + timestamp)
      .digest("hex");
    const sigBuf = Buffer.from(signature, "hex");
    const expBuf = Buffer.from(expected, "hex");
    if (sigBuf.length !== expBuf.length || !timingSafeEqual(sigBuf, expBuf)) {
      throw new HttpException("Invalid signature", HttpStatus.UNAUTHORIZED);
    }

    // PPR-25 — dispatch via the scoped ToolExecutorService. The controller
    // carries no auth context of its own, so we materialize a RequestScope
    // from the HMAC-verified payload. Cross-scope calls are structurally
    // impossible because the registry lookup inside `execute` filters on
    // (org, project, env).
    const scope: RequestScope = {
      organizationId: body.organizationId,
      projectId: body.projectId,
      environmentId: body.environmentId,
      userId: body.userId,
      agentId: body.agentId,
      sessionId: body.scopeExtras?.sessionId ?? body.origin?.threadId,
      userToken: body.scopeExtras?.userToken,
      entityId: body.scopeExtras?.entityId,
      traceId: body.scopeExtras?.traceId,
      parentSpanId: body.scopeExtras?.parentSpanId,
    };
    const result = await this.toolExecutor.execute(
      { tool: body.tool, params: body.params ?? {}, purpose: body.purpose || "durable" },
      scope,
      // Reconstructed agent-turn origin (design §3.1 row vi). `endUserId` rides
      // the HMAC-verified payload; absent ⇒ templated mcp tool fails closed.
      { source: "agent_turn", endUserId: body.endUserId },
    );
    return {
      status: result.status,
      result: result.status === "success" ? result.result : undefined,
      error: result.status !== "success" ? result.error : undefined,
      latencyMs: result.latencyMs,
      auditId: result.auditId,
    };
  }

  /**
   * W.1 — per-item turn endpoint for the `platos-agent-batch` durable
   * executor. HMAC-signed (same scheme as /execute-tool). Runs one
   * non-streaming agent turn with the supplied message + optional
   * allowedTools whitelist and returns `{ status, text, costCents, error }`.
   * The batch task loops over items and calls this once per item.
   *
   * Note: we intentionally DO NOT pass a threadId — each item runs under
   * a fresh thread minted by `AgentTaskService.executeStreamingTurn`
   * (which creates one when `options.threadId` is absent). The originating
   * parent thread is tracked via the batch metadata stream so the UI can
   * route `run_update` progress frames back to the spawning conversation
   * without polluting that thread's history with N new message rows.
   */
  @Post("batch-turn")
  async batchTurn(
    @Headers("x-platos-signature") signature: string | undefined,
    @Headers("x-platos-timestamp") timestamp: string | undefined,
    @Body() body: {
      organizationId: string;
      projectId: string;
      environmentId: string;
      userId: string;
      agentId: string;
      message: string;
      allowedTools?: string[] | null;
      // IDENTITY-CORE §B.3 (G3) — the parent-resolved end user, forwarded
      // null-preservingly by the batch task. `string` = a live id; `null` =
      // the origin thread gated closed; absent = legacy payload. All three are
      // stamped below (absent coerced to `null` ⇒ fail closed) so the override
      // is ALWAYS defined and the short-circuit never falls through.
      endUserId?: string | null;
      batch?: {
        batchRunId: string;
        index: number;
        total: number;
        parentThreadId: string;
        parentMessageId?: string | null;
      };
      scopeExtras?: {
        sessionId?: string;
        userToken?: string;
        entityId?: string;
        traceId?: string;
        parentSpanId?: string;
      };
    },
  ) {
    this.verifySignature(signature, timestamp, body);

    const scope: RequestScope = {
      organizationId: body.organizationId,
      projectId: body.projectId,
      environmentId: body.environmentId,
      userId: body.userId,
      agentId: body.agentId,
      sessionId: body.scopeExtras?.sessionId,
      userToken: body.scopeExtras?.userToken,
      entityId: body.scopeExtras?.entityId,
      traceId: body.scopeExtras?.traceId,
      parentSpanId: body.scopeExtras?.parentSpanId,
    };
    // IDENTITY-CORE §B.3 (G3) — stamp the server-only end-user override
    // UNCONDITIONALLY on the rebuilt scope (exactly like `spawnDepth` is
    // stamped on the subagent path). This scope is REBUILT field-by-field
    // above (it does NOT spread the incoming scope), so the override must be
    // added here explicitly. `resolveOriginEndUserId` short-circuits on
    // `!== undefined`, so stamping the parent's value — INCLUDING a deliberate
    // `null` (gated closed) — is what stops a fresh-per-item thread from
    // re-resolving a live walleId. Stamping "only if truthy" would reopen the
    // fail-OPEN hazard: a gated-closed parent (`null`) would leave the field
    // `undefined` and fall through to the fresh-thread path. The batch task
    // always sends the key (null-preserving), so `body.endUserId` is
    // `string | null` in practice.
    scope.resolvedEndUserId = body.endUserId ?? null;

    const startedAt = Date.now();
    try {
      const result = await this.agentTaskService.executeNonStreamingTurn(
        body.message,
        scope,
        {
          agentId: body.agentId,
          allowedTools: body.allowedTools ?? undefined,
        },
      );

      // Phase 1 review follow-up — `executeNonStreamingTurn` now surfaces
      // `costCents` off the `message_persisted` event (which mirrors the
      // value stamped on responseJson for the assistant message row). This
      // replaces the previous hard-coded 0, which made
      // `agent_batch.batch_complete.totalCost` always 0.
      return {
        status: "success" as const,
        text: result.text,
        threadId: result.threadId,
        costCents: result.costCents ?? 0,
      };
    } catch (err: any) {
      return {
        status: "failed" as const,
        error: err?.message ?? String(err),
        latencyMs: Date.now() - startedAt,
      };
    }
  }

  /**
   * Subagent spawning — per-turn callback for the `platos.agent.subrun`
   * durable executor. HMAC-signed (same scheme as /batch-turn). Runs ONE
   * non-streaming agent turn against the CHILD thread and returns
   * `{ status, text, threadId, costCents, hadToolCalls }`. The subrun task
   * loops over turns on this one thread until a done-signal / maxTurns /
   * budget floor.
   *
   * Differs from /batch-turn in two security-relevant ways:
   *   1. It THREADS the child threadId through every call (batch mints a fresh
   *      thread per item) — on the first call (threadId absent) it mints the
   *      child thread with `parentThreadId` lineage; later calls reuse it, so
   *      multi-turn history accumulates on one thread.
   *   2. It stamps `scope.spawnDepth` from the HMAC-verified body so the CHILD
   *      turn's own `buildMetaTools` enforces the grandchild depth cap. The
   *      depth is server-controlled end-to-end (handler → task → here); it is
   *      NEVER read from a client token. We re-check the cap here as
   *      defense-in-depth.
   *
   * Scope is rebuilt entirely from the HMAC-verified body — the child never
   * accepts a caller-chosen scope; it is the parent's tuple copied 1:1.
   */
  @Post("subagent-turn")
  async subagentTurn(
    @Headers("x-platos-signature") signature: string | undefined,
    @Headers("x-platos-timestamp") timestamp: string | undefined,
    @Body() body: {
      organizationId: string;
      projectId: string;
      environmentId: string;
      userId: string;
      agentId: string;
      message: string;
      allowedTools?: string[] | null;
      threadId?: string | null;
      parentThreadId?: string | null;
      spawnDepth?: number;
      systemPromptOverride?: string | null;
      modelLabel?: string | null;
      scopeExtras?: {
        sessionId?: string;
        userToken?: string;
        entityId?: string;
        traceId?: string;
        parentSpanId?: string;
      };
    },
  ) {
    this.verifySignature(signature, timestamp, body);

    // Defense-in-depth: refuse to run a child past the depth cap even though
    // the spawning handler already gated it.
    const spawnDepth = typeof body.spawnDepth === "number" ? body.spawnDepth : 1;
    if (spawnDepth < 1 || spawnDepth > SUBAGENT_MAX_DEPTH) {
      return {
        status: "failed" as const,
        error: `spawnDepth ${spawnDepth} outside 1..${SUBAGENT_MAX_DEPTH}`,
      };
    }

    const scope: RequestScope = {
      organizationId: body.organizationId,
      projectId: body.projectId,
      environmentId: body.environmentId,
      userId: body.userId,
      agentId: body.agentId,
      sessionId: body.scopeExtras?.sessionId,
      userToken: body.scopeExtras?.userToken,
      entityId: body.scopeExtras?.entityId,
      traceId: body.scopeExtras?.traceId,
      parentSpanId: body.scopeExtras?.parentSpanId,
      // Runtime-stamped depth so the child turn's buildMetaTools enforces the
      // grandchild cap. NEVER from a token.
      spawnDepth,
    };

    const startedAt = Date.now();
    try {
      // Resolve/mint the child thread with parentThreadId lineage on first use.
      let childThreadId = body.threadId ?? undefined;
      if (!childThreadId) {
        const childThread = await this.conversationService.createThread(
          scope,
          body.agentId,
          undefined,
          body.parentThreadId ? { parentThreadId: body.parentThreadId } : undefined,
        );
        childThreadId = childThread.id;
      }

      const result = await this.agentTaskService.executeNonStreamingTurn(body.message, scope, {
        agentId: body.agentId,
        threadId: childThreadId,
        allowedTools: body.allowedTools ?? undefined,
        systemPromptOverride: body.systemPromptOverride ?? undefined,
        modelLabel: body.modelLabel ?? undefined,
      });

      // The subrun loop stops early when the child produced a final answer with
      // no tool calls (it stopped acting → it is done).
      const hadToolCalls = Array.isArray(result.events)
        ? result.events.some((e: any) => e?.type === "tool_call")
        : undefined;

      return {
        status: "success" as const,
        text: result.text,
        threadId: result.threadId ?? childThreadId,
        costCents: result.costCents ?? 0,
        hadToolCalls,
      };
    } catch (err: any) {
      return {
        status: "failed" as const,
        error: err?.message ?? String(err),
        latencyMs: Date.now() - startedAt,
      };
    }
  }
}
