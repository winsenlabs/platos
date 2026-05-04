import { Body, Controller, Headers, HttpException, HttpStatus, Post } from "@nestjs/common";
import { createHmac, timingSafeEqual } from "node:crypto";
import { ToolExecutorService } from "../tool-gateway/tool-executor.service";
import { ScopedEnvService } from "../providers/scoped-env.service";
import { AgentTaskService } from "../agent-runtime/agent-task.service";
import type { RequestScope } from "../auth/scope.guard";

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
 *   X-Platos-Signature: HMAC-SHA256(body, TRIGGER_INTERNAL_SECRET)
 *   X-Platos-Timestamp: ISO8601 (must be <5min ago)
 *   { organizationId, projectId, environmentId, userId, agentId, tool, params }
 *
 * Response:
 *   { status: "success" | "failed", result?: unknown, error?: string, latencyMs: number }
 *
 * BLOCK 2: wire into tool-gateway for actual execution.
 */

// TODO(env.ts) consider migration — module-load-time const; env proxy
// would trigger full schema parse before main.ts has a chance to surface
// structured errors. Kept as direct process.env read.
const INTERNAL_SECRET = process.env.TRIGGER_INTERNAL_SECRET || "dev-internal-secret-change-me";
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
  ) {}

  /**
   * EOBD.39 — invalidate the scoped-env cache for a (scope, varName) or the
   * whole scope. Called by the webapp after a SecretStore write so the
   * agent picks up new keys within one request cycle instead of waiting
   * up to 30s for the positive-cache TTL to roll over.
   *
   * Same HMAC + timestamp guard as /execute-tool — this endpoint is
   * internal-only and the webapp signs the call with
   * TRIGGER_INTERNAL_SECRET.
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
    const expected = createHmac("sha256", INTERNAL_SECRET)
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
    const expected = createHmac("sha256", INTERNAL_SECRET)
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
}
