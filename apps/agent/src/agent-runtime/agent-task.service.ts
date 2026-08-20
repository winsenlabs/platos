import { Injectable, Inject, Optional, Logger, forwardRef } from "@nestjs/common";
import { AgentService, type AgentStreamEvent, type AgentConfig } from "./agent.service";
import { ConversationService } from "../memory/conversation.service";
import { SafetyService } from "../monitoring/safety.service";
import { CostService } from "../monitoring/cost.service";
import { SpansService } from "../monitoring/spans.service";
import { MetricsService } from "../monitoring/metrics.service";
import { SchemaInjectorService } from "../tool-gateway/schema-injector.service";
import { ToolExecutorService } from "../tool-gateway/tool-executor.service";
import { AttachmentsService } from "./attachments.service";
import { BudgetService } from "../monitoring/budget.service";
import { RateLimitService } from "../monitoring/rate-limit.service";
import { SafetyEventService } from "../monitoring/safety-event.service";
import { ProfileCacheService } from "../memory/profile-cache.service";
import { REDIS_TOKEN } from "../shared/redis.provider";
import type Redis from "ioredis";
import type { RequestScope } from "../auth/scope.guard";
import { generateText } from "ai";
import { anthropic } from "@ai-sdk/anthropic";
import { env } from "../shared/env";
import { configureExternalTriggerSdk } from "../shared/external-trigger-config";
import { ProviderRuntimeError } from "../providers/provider-runtime.error";
import { preflightModelPricing } from "../monitoring/model-pricing-preflight";
import { freshInputTokens } from "../monitoring/usage-ledger";
import { randomUUID } from "node:crypto";

/** The one stream event AgentTaskService consumes rather than forwards. */
type SubAgentUsageEvent = Extract<AgentStreamEvent, { type: "sub_agent_usage" }>;

export const TURN_MUTEX_TTL_MS = 30_000;
export const TURN_MUTEX_HEARTBEAT_MS = 10_000;

const RENEW_TURN_MUTEX_SCRIPT = `
if redis.call("get", KEYS[1]) == ARGV[1] then
  return redis.call("pexpire", KEYS[1], ARGV[2])
end
return 0
`;

const RELEASE_TURN_MUTEX_SCRIPT = `
if redis.call("get", KEYS[1]) == ARGV[1] then
  return redis.call("del", KEYS[1])
end
return 0
`;

export interface TurnMutexHandle {
  readonly token: string;
  release(): Promise<void>;
}

/**
 * Acquire a short Redis lease and keep it alive only while this owner holds it.
 * Both renewal and release compare the random token atomically in Lua, so an
 * expired owner can never extend or delete a successor's lock.
 */
export async function acquireTurnMutex(
  redis: Redis,
  key: string,
): Promise<TurnMutexHandle | null> {
  const token = randomUUID();
  const acquired = await redis.set(key, token, "PX", TURN_MUTEX_TTL_MS, "NX");
  if (!acquired) return null;

  let stopped = false;
  let renewalInFlight = false;
  const stopHeartbeat = () => {
    if (stopped) return;
    stopped = true;
    clearInterval(heartbeat);
  };
  const heartbeat = setInterval(() => {
    if (stopped || renewalInFlight) return;
    renewalInFlight = true;
    void redis
      .eval(RENEW_TURN_MUTEX_SCRIPT, 1, key, token, TURN_MUTEX_TTL_MS)
      .then((renewed) => {
        if (Number(renewed) !== 1) stopHeartbeat();
      })
      .catch(() => undefined)
      .finally(() => {
        renewalInFlight = false;
      });
  }, TURN_MUTEX_HEARTBEAT_MS);
  heartbeat.unref?.();

  return {
    token,
    async release() {
      stopHeartbeat();
      await redis
        .eval(RELEASE_TURN_MUTEX_SCRIPT, 1, key, token)
        .catch(() => undefined);
    },
  };
}

/**
 * AgentTaskService — orchestrates a complete agent conversation turn.
 *
 * This is the high-level service that ties everything together:
 * 1. Gets or creates a thread
 * 2. Stores the user message
 * 3. Loads conversation history
 * 4. Runs safety checks on input
 * 5. Executes the agent (streaming or non-streaming)
 * 6. Runs safety checks on output
 * 7. Stores the assistant response
 * 8. Records cost
 *
 * In the full trigger.dev integration, this entire flow runs as a durable
 * trigger.dev task with checkpoint/resume. If the server restarts mid-execution,
 * the task resumes from the last checkpoint.
 *
 * The trigger.dev task definition would look like:
 * ```
 * export const agentConversation = task({
 *   id: "platos-agent-conversation",
 *   queue: { concurrencyLimit: 1 },  // one at a time per thread
 *   run: async (payload) => {
 *     const service = container.get(AgentTaskService);
 *     return service.executeConversationTurn(payload);
 *   }
 * });
 * ```
 *
 * For now, this runs directly in the NestJS process. The trigger.dev
 * integration wraps this same logic in a durable task.
 */
@Injectable()
export class AgentTaskService {
  /** Added with the compaction-model work so the chosen model is visible in logs. */
  private readonly logger = new Logger(AgentTaskService.name);

  constructor(
    @Inject(forwardRef(() => AgentService))
    private readonly agentService: AgentService,
    private readonly conversationService: ConversationService,
    private readonly safetyService: SafetyService,
    private readonly costService: CostService,
    private readonly spansService: SpansService,
    private readonly schemaInjector: SchemaInjectorService,
    private readonly toolExecutor: ToolExecutorService,
    private readonly attachmentsService: AttachmentsService,
    // Theme H — budget caps, rate limits, safety event ledger.
    private readonly budgetService: BudgetService,
    private readonly rateLimitService: RateLimitService,
    private readonly safetyEventService: SafetyEventService,
    @Inject(REDIS_TOKEN) private readonly redis: Redis,
    // EOBD.41 — hot-path Prometheus counters. Optional so unit tests
    // that boot the service without the MonitoringModule still work.
    @Optional() private readonly metrics?: MetricsService,
    // Theme M.3 — Redis projection cache for the turn-start __user_profile
    // block. Optional so the test harness still boots without MemoryModule.
    @Optional() private readonly profileCache?: ProfileCacheService,
  ) {}

  /**
   * Execute a full conversation turn — the main entry point.
   * Yields streaming events that the WebSocket gateway or SSE sends to the frontend.
   */
  async *executeStreamingTurn(
    message: string,
    scope: RequestScope,
    options: {
      threadId?: string;
      agentId?: string;
      contextType?: string;
      contextId?: string;
      dynamicBlocks?: Record<string, string>;
      attachmentIds?: string[];
      /**
       * Theme F — per-turn system prompt override. Swapped in for `systemPrompt`
       * on the single turn this is set on (never mutates the agent config).
       */
      systemPromptOverride?: string | null;
      /**
       * LAUNCH-3 — per-request agent-config override. Whitelisted subset
       * of `AgentConfig` deep-merged onto the resolved config for this
       * single turn only. Set by the controller from the
       * `X-Platos-Config` header value (validated + size-capped there).
       * Allowed keys: model, maxSteps, contextLimit, historyMode,
       * agentRetryConfig. Temperature is not on AgentConfig so it can't
       * be overridden here.
       */
      agentConfigOverride?: Partial<AgentConfig>;
      /**
       * Theme F.5 — per-turn output schema. JSON Schema object or Zod
       * descriptor. Wins over the agent-level `outputSchema` for this turn
       * only. When set, routes the turn through `streamObject` and enforces
       * schema validity with a one-shot retry on failure.
       */
      outputSchema?: unknown;
      /**
       * EOBD.26 — external AbortSignal plumbed through from the WS/SSE
       * stop-button handler. When aborted, the streamText loop aborts
       * and the turn yields an {type:"error", code:"aborted"} event.
       */
      abortSignal?: AbortSignal;
      /**
       * EOBD.28 — idempotency key from `Idempotency-Key` header or WS
       * `client_msg_id`. Redis SETNX'd for 10 minutes. Duplicate POSTs
       * with the same key short-circuit to a cached `{already_processed
       * :true}` response so network retries don't double-charge or
       * duplicate rows.
       */
      idempotencyKey?: string;
      /**
       * W.1 — per-turn meta-tool allowlist. Plumbed through to
       * AgentService.stream which post-filters buildMetaTools output.
       * Used by the `agent_batch` durable executor.
       */
      allowedTools?: string[];
      /**
       * Per-request model routing label. When set, the runtime picks the
       * matching route from `agentConfig.modelRoutes` (falling back to the
       * default route, then routes[0]). No-op when `modelRoutes` is null/empty —
       * the legacy `model` + `providerKeyId` fields are used instead.
       */
      modelLabel?: string;
      /**
       * PRA-TC: sub-thread reply. When set, this turn is a reply inside a
       * sub-thread rooted at the given message ID. History loading uses the
       * hybrid context (main thread + system injection + sub-thread chain).
       * Both user + assistant messages are stored with threadReplyToId set.
       */
      replyToMessageId?: string | null;
    } = {},
  ): AsyncGenerator<AgentStreamEvent> {
    // Resolve the agentId. Priority:
    //   1. caller-supplied options.agentId — used when an integrator explicitly
    //      switches an agent mid-thread, or for one-off turns without a thread.
    //   2. the thread row's agentId — when the SDK sends a message via
    //      `threads.send(threadId, msg)` without including agentId in the body
    //      (the common case for any client built on top of `@platosdev/client`).
    //   3. literal "default" — last-resort fallback for legacy callers.
    //
    // Pre-fix: only (1) and (3). When the SDK didn't include agentId in the
    // POST body, the runtime fell straight to "default", which loaded a
    // generic "You are a helpful AI assistant" config and ignored the
    // thread's actual agent — root cause of "the marketing widget gets a
    // different personality than the dashboard chat".
    let agentId = options.agentId;
    if (!agentId && options.threadId) {
      try {
        const prisma = (this.conversationService as any).prisma;
        const threadRow = await prisma?.thread?.findFirst?.({
          where: {
            id: options.threadId,
            environmentId: scope.environmentId,
            environment: {
              projectId: scope.projectId,
              project: { organizationId: scope.organizationId },
            },
          },
          select: { agentId: true },
        });
        if (threadRow?.agentId) agentId = threadRow.agentId;
      } catch (err: any) {
        console.warn(
          `[agent-task] thread→agentId lookup failed for ${options.threadId}: ${err?.message ?? err}`,
        );
      }
    }
    if (!agentId) agentId = "default";
    const turnStartNs = Date.now() * 1_000_000;

    // EOBD.27 — compose the caller-supplied AbortSignal with a turn-level
    // timeout. streamText will respect the resulting signal and abort
    // the LLM stream if the turn runs longer than PLATOS_TURN_MAX_MS
    // (default 5 min).
    const turnTimeoutMs = Math.max(30_000, env.PLATOS_TURN_MAX_MS ?? 300_000);
    const composedSignal: AbortSignal = options.abortSignal
      ? (AbortSignal as any).any([options.abortSignal, AbortSignal.timeout(turnTimeoutMs)])
      : AbortSignal.timeout(turnTimeoutMs);

    // EOBD.28 — idempotency. If caller supplied a key + we've seen it
    // recently, emit a terse "already processed" event + exit.
    // idemKey holder so finally-release path below can clean it up on
    // early failure (so a legit retry after an auth error isn't locked
    // out for 600s).
    let idemKey: string | null = null;
    const earlyRedis = (this.agentService as any)?.redis;
    if (options.idempotencyKey && earlyRedis) {
      const ikey = `idem:${scope.organizationId}:${scope.projectId}:${scope.environmentId}:${options.idempotencyKey}`;
      const reserved = await earlyRedis.set(ikey, Date.now().toString(), "EX", 600, "NX");
      if (!reserved) {
        yield {
          type: "error",
          code: "already_processed",
          message:
            "Duplicate request — a turn with this Idempotency-Key was already accepted within the last 10 minutes.",
        } as any;
        yield { type: "done" } as any;
        return;
      }
      idemKey = ikey;
    }

    // 1. Get or create thread
    //
    // PRA-AC: pre-resolve the agent's clusteringId before getOrCreateThread so
    // a clustered agent can RESOLVE a sibling thread (created by another
    // cluster member) instead of silently creating a new orphan thread.
    //
    // Bug: previously we called getOrCreateThread(scope, …) with bare scope.
    // For clustered agents whose threadId points to a sibling-owned thread,
    // getThread (correctly scoped by userId only) fell back to baseWhere
    // which has no clusteringId — and createThread thus minted a NEW thread.
    // Then storeMessage(threadReplyToId=…, threadId=<newThreadId>) failed the
    // `where:{id, threadId}` parent check, throwing "Reply parent message not
    // found in this thread". Cluster members must inherit the cluster scope
    // before any thread lookup happens.
    let preClusteringId: string | null = null;
    try {
      const agentRow = await (this.conversationService as any).prisma.agentBinding.findFirst({
        where: {
          agentId,
          environmentId: scope.environmentId,
          agent: { projectId: scope.projectId },
          environment: {
            projectId: scope.projectId,
            project: { organizationId: scope.organizationId },
          },
        },
        select: { clusterId: true },
      });
      preClusteringId = agentRow?.clusterId ?? null;
    } catch {
      preClusteringId = null;
    }
    const scopeForThreadLookup: typeof scope = preClusteringId
      ? { ...scope, clusteringId: preClusteringId }
      : scope;
    const thread = await this.conversationService.getOrCreateThread(
      scopeForThreadLookup, agentId, options.threadId,
    );

    // EOBD.30 — per-thread mutex. Two concurrent messages on the same
    // thread would otherwise race on the history snapshot. The bounded
    // Redis lease is renewed while this turn owns its unique token. A
    // crashed worker loses the lease quickly, while a stale worker cannot
    // renew or delete a successor's lock.
    const redis = (this.agentService as any)?.redis;
    const mutexKey = `turn:${scope.organizationId}:${scope.projectId}:${scope.environmentId}:${thread.id}`;
    let mutex: TurnMutexHandle | null = null;
    // PRELAUNCH-A3-7 — reservation state hoisted outside the try block so
    // the finally can settle even when the try body throws before the
    // happy-path settle would have run.
    let reservationCommitted = false;
    let openTurnId: string | null = null;
    let openStepModel = "unknown";
    let turnFinalized = false;
    const reservationEstimateCents = 25;
    const reservationScopeTuple = {
      organizationId: scope.organizationId,
      projectId: scope.projectId,
      environmentId: scope.environmentId,
    };
    if (redis) {
      mutex = await acquireTurnMutex(redis, mutexKey);
      if (!mutex) {
        // Wave 11b — mutex held by a live turn; release the idempotency
        // reservation so a legit retry (once the live turn finishes) isn't
        // locked out for 600s with the same key.
        if (idemKey && earlyRedis) {
          await earlyRedis.del(idemKey).catch(() => undefined);
        }
        yield {
          type: "error",
          code: "turn_in_progress",
          message: "Another turn on this thread is still streaming. Wait for it to finish or stop it.",
        } as any;
        yield { type: "done" } as any;
        return;
      }
    } else {
      // BUG-10: Redis unavailable — do NOT silently proceed without turn
      // serialization. This would allow concurrent turns to race on the
      // history snapshot. Fail with a service-unavailable error instead.
      yield {
        type: "error",
        code: "service_unavailable",
        message: "Service temporarily unavailable (cache layer down). Please retry in a moment.",
      } as any;
      yield { type: "done" } as any;
      return;
    }

    try {
    // 1b. Open an OTel trace for this turn. The root span covers the whole
    //     turn (user message in → assistant reply out). Child spans are
    //     created for model calls and tool calls by downstream services
    //     that read scope.traceId / scope.parentSpanId. Theme E.1.
    //
    //     EOBD.40 — if the scope already carries a traceparent (ScopeGuard
    //     parsed `traceparent` off the inbound HTTP request), reuse it
    //     so the webapp's request span is the parent of this turn span.
    //     Otherwise start a fresh trace. `rootSpanId` is a new span id
    //     either way — we never overwrite the upstream parent.
    const inboundTraceId = scope.traceId;
    const inboundParentSpanId = scope.parentSpanId;
    const { traceId, rootSpanId } = inboundTraceId
      ? { traceId: inboundTraceId, rootSpanId: this.spansService.nextSpanId() }
      : this.spansService.startTrace();
    scope.traceId = traceId;
    scope.parentSpanId = rootSpanId;
    scope.agentId = scope.agentId || agentId;
    scope.sessionId = scope.sessionId || thread.id;
    // Preserve the upstream parent span so the agent.turn root span can
    // link to it. If inbound was absent, the turn root has no parent.
    const inboundParent: string | undefined = inboundParentSpanId;

    // PPR-21 — stamp turn start so normalized Turn/Step latency remains durable.
    const turnStartMs = Date.now();

    yield { type: "meta", thread_id: thread.id, agent_id: agentId };

    const scopeTuple = {
      organizationId: scope.organizationId,
      projectId: scope.projectId,
      environmentId: scope.environmentId,
    };

    // 1c. Theme H.8 — per-user message rate limit. Fail-closed on exceed;
    //     fail-open on Redis error so a flaky Redis can't lock users out.
    try {
      const rl = await this.rateLimitService.checkUserMessage(scopeTuple, scope.userId);
      if (!rl.allowed) {
        const isDay = rl.window === "day";
        const humanMessage = isDay
          ? `Daily message limit reached. Limit resets in ${Math.ceil(rl.retryAfterSeconds / 3600)} hours.`
          : rl.window === "hour"
            ? `Hourly message limit reached. Try again in ${Math.ceil(rl.retryAfterSeconds / 60)} minutes.`
            : `Rate limit reached. Try again in ${rl.retryAfterSeconds} seconds.`;
        const scopeTag: "user_per_minute" | "user_per_hour" | "user_per_day" =
          rl.window === "day"
            ? "user_per_day"
            : rl.window === "hour"
              ? "user_per_hour"
              : "user_per_minute";
        // PRELAUNCH-A3-4 — record the denial on the safety-event ledger so
        // governance timelines reflect the user-rate block.
        await this.safetyEventService.record(scopeTuple, {
          detector: "rate_limit",
          action: "block",
          severity: "medium",
          detail: `user_${rl.window} exceeded (limit ${rl.limit})`,
          meta: { bucket: scopeTag, limit: rl.limit, window: rl.window },
          agentId,
          threadId: thread.id,
          userId: scope.userId,
        });
        yield {
          type: "error",
          code: "rate_limit",
          message: humanMessage,
          retryAfterSeconds: rl.retryAfterSeconds,
          scope: scopeTag,
          limit: rl.limit,
          flags: [
            { type: "rate_limit", severity: "medium", detail: `user rate ${rl.window}` },
          ],
        };
        yield { type: "done" };
        return;
      }
    } catch {
      // Redis down — don't block turns. The next window's counters will
      // catch up once Redis recovers.
    }

    // 1d. Theme H.6 — hard-stop on exceeded budget caps. Fail-open on
    //     evaluate errors (the service swallows internally) but
    //     fail-closed when a cap is provably over. Budget check runs
    //     BEFORE we charge the user for this turn per invariant §5.3.
    try {
      const gate = await this.budgetService.evaluate(scopeTuple, {
        agentId,
        userId: scope.userId,
      });
      if (gate.blocked) {
        // Record the block as a safety event so the governance dashboard
        // can surface the denial without a separate log tail.
        // PRELAUNCH-A3-4 — DetectorKind now has a dedicated "budget"
        // value; previously this aliased onto "exfiltration" with a
        // detail-string disambiguation comment.
        await this.safetyEventService.record(scopeTuple, {
          detector: "budget",
          action: "block",
          severity: "high",
          detail: `budget cap blocked: ${gate.reason}`,
          agentId,
          threadId: thread.id,
          userId: scope.userId,
        });
        yield {
          type: "error",
          code: "budget_cap",
          message: gate.reason ?? "Budget cap reached. Contact your admin for an override.",
          flags: [
            { type: "budget", severity: "high", detail: gate.reason ?? "" },
          ],
        };
        yield { type: "done" };
        return;
      }
    } catch {
      // Fail-open on evaluate errors. The service tries hard not to throw
      // but this keeps the turn alive on any unexpected error path.
    }

    // PRELAUNCH-A3-7 — TOCTOU reservation. After the budget gate above
    // passes, reserve a conservative estimate against both the scope-wide
    // and per-user counters so a concurrent turn from the same user
    // across a different thread sees the in-flight charge in
    // BudgetService.evaluate's read of `*:reserved`. Settled at turn end
    // (success path settles; error path settles too — see finally below).
    // Estimate is a flat 25¢ (≈ a median Sonnet turn). Over-estimate is
    // self-healing: settleReservation decrements the same amount, and
    // recordUsage bumps `cost_cents` by the actual figure independently.
    // Variables hoisted above so the finally block can release on throw.
    try {
      await this.costService.beginReservation(
        scopeTuple,
        reservationEstimateCents,
        scope.userId ?? null,
      );
      reservationCommitted = true;
    } catch {
      // Fail-open: reservation is a defence in depth; the cap re-eval
      // post-record still catches over-spend.
    }

    // 2. Safety check on input
    const inputCheck = this.safetyService.checkText(message);
    if (!inputCheck.passed) {
      // Persist the high-severity signals to the safety ledger for the
      // governance dashboard. Individual flags so the dashboard timeline
      // row-count reflects the detector activity accurately.
      for (const flag of inputCheck.flags.filter((f) => f.severity === "high")) {
        await this.safetyEventService.record(scopeTuple, {
          detector:
            flag.type === "injection"
              ? "injection"
              : flag.type === "pii"
                ? "pii"
                : "exfiltration",
          action: "block",
          severity: flag.severity,
          detail: flag.detail,
          meta: flag,
          agentId,
          threadId: thread.id,
          userId: scope.userId,
        });
      }
      yield {
        type: "error",
        message: "Message flagged by safety filters",
        flags: inputCheck.flags.filter((f) => f.severity === "high"),
      };
      yield { type: "done" };
      return;
    }
    // Record low/medium events as warnings (don't block, but surface).
    for (const flag of inputCheck.flags.filter((f) => f.severity !== "high")) {
      await this.safetyEventService.record(scopeTuple, {
        detector:
          flag.type === "injection"
            ? "injection"
            : flag.type === "pii"
              ? "pii"
              : "exfiltration",
        action: "warn",
        severity: flag.severity,
        detail: flag.detail,
        meta: flag,
        agentId,
        threadId: thread.id,
        userId: scope.userId,
      });
    }

    // 3. Get agent config for this turn. Theme G.5 — honour the per-thread
    //    version lock, and on the first turn roll canary vs current. The
    //    returned `versionIdUsed` is persisted structurally on the Turn so
    //    canary metrics can pivot cost/latency by version.
    const resolved = await this.agentService.resolveConfigForThread(agentId, thread.id, scope);
    let config = resolved.config;
    const versionIdUsed = resolved.versionIdUsed;
    if (!versionIdUsed) {
      throw new Error("Runtime turn cannot persist without a selected AgentVersion");
    }

    // LAUNCH-3 — per-request `X-Platos-Config` override. Deep-merge a
    // whitelisted subset of agent config for this single turn. Used for
    // A/B testing, customer support overrides, ephemeral routing tweaks.
    // Whitelist + range checks live in the controller's
    // `parsePlatosConfigHeader` so this site trusts the shape.
    if (options.agentConfigOverride) {
      const o = options.agentConfigOverride;
      config = {
        ...config,
        ...(o.model !== undefined ? { model: o.model } : {}),
        ...(o.maxSteps !== undefined ? { maxSteps: o.maxSteps } : {}),
        ...(o.contextLimit !== undefined ? { contextLimit: o.contextLimit } : {}),
        ...(o.historyMode !== undefined ? { historyMode: o.historyMode } : {}),
        ...(o.agentRetryConfig !== undefined ? { agentRetryConfig: o.agentRetryConfig } : {}),
      };
    }

    // Per-request model routing: when modelRoutes are configured AND a label
    // (or default) can be resolved, override config.model + config.providerKeyId
    // with the route's values. All downstream code (stream, cost, spans, metrics)
    // reads config.model so this single override propagates everywhere correctly.
    // LLMs are stateless — the conversation history is model-agnostic so switching
    // route mid-thread preserves full conversation continuity.
    {
      const routes = (config.modelRoutes ?? []) as Array<{ label: string; model: string; providerKeyId?: string | null; isDefault: boolean }>;
      if (routes.length > 0) {
        const requestedLabel = options.modelLabel;
        const route = (requestedLabel ? routes.find((r) => r.label === requestedLabel) : null)
          ?? routes.find((r) => r.isDefault)
          ?? routes[0];
        if (route) {
          config = { ...config, model: route.model, providerKeyId: route.providerKeyId ?? null };
        }
      }
    }
    openStepModel = config.model;
    let pricedModel = config.model;
    let turnPrice: Awaited<ReturnType<typeof preflightModelPricing>> | null = null;

    // PRA-AC: stamp clusteringId onto scope so createThread + getThread use it.
    // This propagates into conversation.service.ts createThread (clusteringId on thread)
    // and getThread (cluster member can read sibling threads).
    const scopeWithCluster: typeof scope = config.clusteringId
      ? { ...scope, clusteringId: config.clusteringId }
      : scope;

    // 4. Load conversation history FIRST (before storing user message, so history
    //    contains only prior turns — not the current one). This prevents the
    //    duplicate-user-message bug at the assembly boundary.
    const history = await this.conversationService.loadHistory(thread.id, scopeWithCluster, config.contextLimit, options.replyToMessageId);

    // 4b. Resolve attachments (Theme D). Scope-gated — raises if any id is
    //     outside (org, project, env). Fails the turn closed rather than
    //     silently drop so a cross-scope leak is visible.
    let resolvedAttachments: Awaited<
      ReturnType<AttachmentsService["resolveAttachments"]>
    > = [];
    if (options.attachmentIds && options.attachmentIds.length > 0) {
      try {
        resolvedAttachments = await this.attachmentsService.resolveAttachments(
          options.attachmentIds,
          scope,
        );
      } catch (err: any) {
        yield {
          type: "error",
          message: `Attachment resolution failed: ${err?.message ?? String(err)}`,
        };
        yield { type: "done" };
        return;
      }
    }

    // 5. Now persist the user message so it's durable even if stream crashes.
    //    We attach the attachments to this message right after so the
    //    retention task extends their TTL beyond the grace period.
    //
    //    Theme F — per-turn `systemPromptOverride` and `outputSchema` are
    //    stamped onto the user message so the conversation history replays
    //    with the same per-turn config on fork / edit-and-rerun (see F.2/F.3).
    const userMessage = await this.conversationService.storeMessage(thread.id, scopeWithCluster, {
      role: "user",
      content: message,
      agentVersionId: versionIdUsed,
      versionBucket: resolved.bucket,
      systemPromptOverride: options.systemPromptOverride ?? undefined,
      outputSchema: (options.outputSchema as any) ?? undefined,
      threadReplyToId: options.replyToMessageId ?? null,
      // PRA-AC: attribute message to the calling agent when in a cluster.
      authorAgentId: config.clusteringId ? agentId : null,
      idempotencyKey: options.idempotencyKey,
    });
    openTurnId = userMessage.id;
    if (resolvedAttachments.length > 0 && userMessage?.id) {
      await this.attachmentsService.markAttachedToMessage(
        options.attachmentIds!,
        userMessage.id,
        scope,
      );
    }

    // 5b. Build dynamic context (compaction summary + user profile + caller blocks)
    const dynamicContext: Record<string, string> = {};
    if (thread.compactedSummary) {
      dynamicContext.__compacted_summary = thread.compactedSummary;
    }
    if (config.enableUserProfiling) {
      // Theme M.4 — profile rows live exclusively in clean Memory
      // (kind="profile"). The legacy PlatosAgentUserProfile blob was
      // dropped. Readers pay the Redis projection cache on the hot path,
      // falling back to Prisma only on cache miss.
      try {
        let profileData: Record<string, unknown> | null =
          (await this.profileCache?.get(scopeTuple, agentId, scope.userId)) ?? null;
        if (!profileData) {
          // Cache miss — reassemble from memory rows. Scope-gated to
          // (org, project, env, agentId, userId) so a forged agentId
          // can't leak another scope's data.
          const prisma = (this.conversationService as any).prisma;
          if (prisma?.memory) {
            const rows: Array<{ content: string; metadata: unknown }> =
              await prisma.memory.findMany({
                where: {
                  environmentId: scope.environmentId,
                  endUserId: thread.endUserId,
                  agentId,
                  kind: "profile",
                  archivedAt: null,
                },
                select: { content: true, metadata: true },
              });
            const data: Record<string, unknown> = {};
            for (const row of rows) {
              const meta = row.metadata as any;
              const profileKey =
                meta && typeof meta === "object" && typeof meta.profileKey === "string"
                  ? meta.profileKey
                  : null;
              if (profileKey) data[profileKey] = row.content;
            }
            profileData = data;
            await this.profileCache?.set(scopeTuple, agentId, scope.userId, data);
          }
        }
        if (profileData && Object.keys(profileData).length > 0) {
          // The synthesized narrative (profileKey "_synthesized", written by
          // MemoryExtractionService.synthesizeProfile) renders as PROSE; the
          // remaining structured key→values render as JSON beneath it.
          const { _synthesized, ...structured } = profileData as Record<string, unknown>;
          const parts: string[] = [];
          if (typeof _synthesized === "string" && _synthesized.trim().length > 0) {
            parts.push(String(_synthesized).trim());
          }
          if (Object.keys(structured).length > 0) {
            parts.push(`Known details:\n${JSON.stringify(structured, null, 2)}`);
          }
          if (parts.length > 0) {
            dynamicContext.__user_profile = `## What you know about this user\n${parts.join("\n\n")}`;
          }
        }
      } catch { /* swallow — missing memory rows shouldn't block a turn */ }
    }
    // Merge caller-provided dynamic blocks against declared templates.
    // PIFSP-19 — guard the log line with Array.isArray too: dynamicBlocks is a
    // Json? column that can hold a string scalar if a client double-encodes it.
    // A bare truthiness check lets a string through, and `.map` on a string
    // throws ("...".map is not a function). The dispatch loop below already
    // guards; this log line must match or it crashes the turn before we reach it.
    console.log(
      `[agent.task] dynamicBlocks: ${Array.isArray(config.dynamicBlocks) ? `${config.dynamicBlocks.length} block(s): ${config.dynamicBlocks.map((b: any) => b.key).join(", ")}` : "none"}`,
    );
    if (config.dynamicBlocks && Array.isArray(config.dynamicBlocks)) {
      for (const template of config.dynamicBlocks) {
        const providedContent = options.dynamicBlocks?.[template.key];
        const content = providedContent ?? template.defaultContent;
        if (content) {
          dynamicContext[template.key] = `## ${template.name}\n${content}`;
        }
      }
    }

    // 6. Stream the agent response
    let fullText = "";
    let totalInputTokens = 0;
    let totalOutputTokens = 0;
    // MC.1 — accumulate Anthropic prompt-cache telemetry emitted via the
    // stream `meta` events. `creation` tokens are billed at 1.25× input
    // rate; `read` tokens at 0.1× (90% discount). Zero for non-Anthropic
    // providers or non-cached turns.
    let totalCacheCreationTokens = 0;
    let totalCacheReadTokens = 0;
    // PRELAUNCH-A1-3 — accumulate output-side reasoning tokens. Surfaced
    // by the stream `meta` event when the model billed for reasoning
    // (OpenAI o-series, DeepSeek R1, Gemini 2.5 thinking, Perplexity
    // reasoning). Zero on non-reasoning models.
    let totalReasoningTokens = 0;
    const toolCallsLog: any[] = [];
    // WIN-134 — priced sub-agent model calls, in the order they happened. They
    // are already in Redis by the time they arrive here; this is the copy that
    // becomes Step rows on the parent's Turn so the durable ledger and the
    // rollups describe the same spend.
    const subAgentSteps: SubAgentUsageEvent[] = [];
    // Theme F.5 — when the agent returns a structured output, capture the
    // validated object + attempt count so it lands in the normalized Turn output.
    let structuredOutput: { object: unknown; attempts: number } | null = null;

    for await (const event of this.agentService.stream(
      message,
      history,
      config,
      scope,
      dynamicContext,
      resolvedAttachments,
      // Theme F — per-turn overrides (prompt + output schema). The stream
      // method handles precedence internally (per-turn wins over agent
      // config) and surfaces structured-output failures via typed events.
      // EOBD.26/27 — `abortSignal` carries the composed stop-button +
      // turn-timeout signal down into the LLM streamText call.
      {
        systemPromptOverride: options.systemPromptOverride ?? null,
        outputSchema: options.outputSchema as any,
        abortSignal: composedSignal,
        // W.1 — narrow the meta-tool matrix for per-item batch turns.
        allowedTools: options.allowedTools,
        onPricingResolved: (model, price) => {
          pricedModel = model;
          turnPrice = price;
          openStepModel = model;
        },
      },
    )) {
      if (event.type === "error" && event.code === "provider_unavailable") {
        throw new ProviderRuntimeError("provider_configuration_unavailable");
      }
      // Capture text for storage
      if (event.type === "token") {
        fullText += event.text;
      }

      // Capture tool calls for storage
      if (event.type === "tool_call") {
        toolCallsLog.push({ type: "call", name: event.name, params: event.params });
      }
      if (event.type === "tool_result") {
        toolCallsLog.push({ type: "result", name: event.name, result: event.result });
      }

      // Theme F.5 — structured output event (validated against schema).
      if (event.type === "structured_output") {
        structuredOutput = {
          object: event.object,
          attempts: event.attempts,
        };
      }

      // Capture usage for cost tracking
      if (event.type === "meta" && event.usage) {
        const usage = event.usage as {
          inputTokens?: number;
          outputTokens?: number;
          cacheCreationInputTokens?: number;
          cacheReadInputTokens?: number;
          reasoningTokens?: number;
          inputTokenDetails?: Record<string, unknown> | null;
          outputTokenDetails?: Record<string, unknown> | null;
        };
        totalInputTokens += usage.inputTokens || 0;
        totalOutputTokens += usage.outputTokens || 0;
        // MC.1 — accumulate cache fields; `meta` events fire per-step +
        // once on final finish, so take the max observed (since the final
        // finish carries the run total + individual steps carry per-step
        // deltas that may overlap). Safer to always sum and rely on the
        // finish event being the primary carrier — Vercel AI SDK only
        // emits `meta` in the `finish` chunk + once per structured-output
        // attempt, not per step.
        totalCacheCreationTokens += usage.cacheCreationInputTokens || 0;
        totalCacheReadTokens += usage.cacheReadInputTokens || 0;
        // PRELAUNCH-A1-3 — reasoning tokens.
        totalReasoningTokens += usage.reasoningTokens || 0;
      }

      // WIN-134 — ledger plumbing, not a UI event. Collected here and turned
      // into Step rows below; never forwarded.
      if (event.type === "sub_agent_usage") {
        subAgentSteps.push(event);
        continue;
      }

      // AgentService owns model streaming, but AgentTaskService owns the
      // persisted assistant message. Do not expose the provider stream's
      // completion marker yet: consumers (notably the Trigger session bridge)
      // correctly treat `done` as terminal and would discard the
      // `message_persisted` event emitted after the durable write below.
      if (event.type !== "done") {
        yield event;
      }
    }

    // 7. Safety check on output. Theme H — persist flags to the ledger
    //    so the governance dashboard reflects output-side detector hits
    //    alongside input-side ones.
    if (fullText) {
      const outputCheck = this.safetyService.checkText(fullText);
      if (outputCheck.flags.length > 0) {
        for (const flag of outputCheck.flags) {
          await this.safetyEventService.record(scopeTuple, {
            detector:
              flag.type === "injection"
                ? "injection"
                : flag.type === "pii"
                  ? "pii"
                  : "exfiltration",
            action: flag.severity === "high" ? "flag" : "warn",
            severity: flag.severity,
            detail: flag.detail,
            meta: flag,
            agentId,
            threadId: thread.id,
            userId: scope.userId,
          });
        }
        yield {
          type: "safety_flags",
          flags: outputCheck.flags,
        };
      }

      // Theme H.3 — groundedness check. Only runs when the turn produced
      // tool_result events; without sources there's nothing to ground
      // against and we skip silently rather than false-flag everything.
      const sources: string[] = toolCallsLog
        .filter((t) => t.type === "result")
        .map((t) => (typeof t.result === "string" ? t.result : JSON.stringify(t.result)));
      if (sources.length > 0) {
        const grounded = this.safetyService.checkGroundedness(fullText, sources);
        if (!grounded.grounded) {
          await this.safetyEventService.record(scopeTuple, {
            detector: "grounded",
            action: "warn",
            severity: "medium",
            detail: `${grounded.unsupportedClaims.length} claim(s) not attributable to tool sources`,
            meta: { claims: grounded.unsupportedClaims.slice(0, 5) },
            agentId,
            threadId: thread.id,
            userId: scope.userId,
          });
          yield {
            type: "safety_flags",
            flags: [
              {
                type: "grounded",
                severity: "medium",
                detail: "assistant claims not fully attributable to tool sources",
              },
            ],
          };
        }
      }
    }

    // 8. EOBD.36 — persist-first ordering. Postgres is the source of
    //    truth; Redis/CH are rebuildable from Postgres via the
    //    reconcile task. If Postgres dies mid-turn we haven't billed
    //    yet, and the user sees the error cleanly. If Redis dies AFTER
    //    storeMessage, normalized Turn/Step usage remains available to repair
    //    rebuildable counters.
    //
    //    Cost is computed locally first (no side effects), stamped on
    //    the message, THEN pushed to Redis via recordUsage.
    // PRELAUNCH-A1-1 — `totalInputTokens` is the v6 total (INCLUDES cache).
    // For the naive (no-cache) `costCents` figure we bill the fresh-token
    // slice only — otherwise we double-bill cache hits at 1.0× input on top
    // of the cache-discounted rate. `calculateCostWithCache` does the same
    // strip internally, so passing the total to it is correct.
    if (!turnPrice) throw new ProviderRuntimeError("model_pricing_unavailable");
    const pricedUsage = this.costService.priceUsageFromSnapshot(
      pricedModel,
      turnPrice,
      totalInputTokens,
      totalOutputTokens,
      totalCacheCreationTokens,
      totalCacheReadTokens,
    );
    const costCents = pricedUsage.costCents;
    const costWithCacheCents = costCents;

    // 8a. EOBD.36 — Postgres-first: persist the assistant message
    //     (source of truth) BEFORE any Redis/CH side effect. If
    //     storeMessage throws, we haven't billed, the budget counter
    //     is untouched, no span is emitted. The user gets a clean
    //     error and can retry. Previously: Redis cost bump happened
    //     first, so a Postgres outage billed the user + lost the
    //     assistant row.
    const storedAssistant = await this.conversationService.storeMessage(thread.id, scopeWithCluster, {
      role: "assistant",
      turnId: userMessage.id,
      content: fullText || undefined,
      toolCalls: toolCallsLog.length > 0 ? toolCallsLog : undefined,
      threadReplyToId: options.replyToMessageId ?? null,
      // PRA-AC: attribute assistant response to the calling agent when in a cluster.
      authorAgentId: config.clusteringId ? agentId : null,
      model: pricedModel,
      usage: {
        inputTokens: totalInputTokens,
        outputTokens: totalOutputTokens,
        cacheCreationInputTokens: totalCacheCreationTokens,
        cacheReadInputTokens: totalCacheReadTokens,
        reasoningTokens: totalReasoningTokens,
      },
      costCents: costWithCacheCents,
      pricing: pricedUsage.price,
      // WIN-134 — every sub-agent model call this turn made, as its own Step
      // on this Turn, priced at its own model's rates. Sub-agent spend used to
      // reach Redis and nothing else, so `Turn.costCents` (the canary panel)
      // reported less than the per-agent card for the same agent, and a day
      // rebuilt from Postgres was permanently short by the missing dollars.
      additionalSteps: subAgentSteps.map((step) => ({
        model: step.model,
        provider: step.provider ?? null,
        startedAt: new Date(step.startedAt),
        completedAt: new Date(step.completedAt),
        inputTokens: step.inputTokens,
        outputTokens: step.outputTokens,
        cacheCreationInputTokens: step.cacheCreationInputTokens,
        cacheReadInputTokens: step.cacheReadInputTokens,
        reasoningTokens: step.reasoningTokens,
        costCents: step.costCents,
        pricing: step.pricing,
      })),
      latencyMs: Date.now() - turnStartMs,
      structuredOutput: structuredOutput
        ? { object: structuredOutput.object, attempts: structuredOutput.attempts }
        : undefined,
    });
    turnFinalized = true;

    // 8a.ii. EOBD.71 — surface the Postgres messageId so the UI can
    //        swap its provisional `bot-<N>` client id for the real
    //        server id. Without this, rating buttons on the streaming
    //        bubble never enable until the user reloads.
    //
    //        Phase 1 review follow-up — also surface `costCents` so the
    //        non-streaming / batch path can return an accurate per-item
    //        cost (previously hard-coded to 0, which made the
    //        agent_batch `batch_complete.totalCost` always 0).
    yield {
      type: "message_persisted",
      messageId: storedAssistant.id,
      threadId: thread.id,
      costCents,
      // Surface token usage alongside cost so consumers (UI, batch/collected
      // path, cost widgets) get it off the SAME event instead of re-deriving
      // it — the counts are already computed for costCents above.
      inputTokens: totalInputTokens,
      outputTokens: totalOutputTokens,
      totalTokens: totalInputTokens + totalOutputTokens,
      ...(options.replyToMessageId ? { replyToMessageId: options.replyToMessageId } : {}),
    };

    // 8b. EOBD.36 — Redis/CH side effects run AFTER the Postgres write.
    //     All of these are rebuildable from normalized Turn/Step fields, so a
    //     Redis/CH outage here just delays
    //     dashboard freshness — the authoritative message row is safe.
    //     Every block is wrapped so one failure can't cascade.
    try {
      await this.costService.recordUsage(
        {
          organizationId: scope.organizationId,
          projectId: scope.projectId,
          environmentId: scope.environmentId,
        },
        thread.id, agentId, pricedModel,
        totalInputTokens, totalOutputTokens,
        {
          // MC.1 — push cache telemetry through to Redis fan-out.
          cacheCreationInputTokens: totalCacheCreationTokens,
          cacheReadInputTokens: totalCacheReadTokens,
          userId: scope.userId ?? null,
          // PRELAUNCH-A3-13 — deterministic idempotency key keyed off the
          // persisted message id so a retry on the same assistant row
          // doesn't double-bill. `:cost` suffix disambiguates from any
          // future `:reservation` keys under the same prefix.
          idempotencyKey: storedAssistant.id ? `${storedAssistant.id}:cost` : null,
          pricedUsage,
        },
      );
    } catch {
      // Cost counter hiccup — reconciliation can backfill from clean Turn/Step data.
    }

    // 8c. Theme H.6/H.7 — increment the per-user budget counter (so
    //     user-level caps have a live source) and check whether this
    //     charge just crossed any alert threshold. Threshold crossings
    //     are fire-and-forget to the budget-alert trigger.dev task so
    //     webhook + email delivery never blocks the turn.
    try {
      // ONE SOURCE OF TRUTH (see monitoring/usage-ledger.ts). This passed
      // `costCents`, the NAIVE figure that prices only fresh input + output and
      // ignores cache reads and writes entirely. Budgets were therefore enforced
      // against a number that understates real spend — measured 2.47c against
      // 25.70c actual on 2026-07-31, so a cap could not trip. The gap widens as
      // caching improves, so fixing prompt caching quietly disabled budgets.
      //
      // WIN-134 — the cost fan-out now happens exactly once, in
      // CostService.recordUsage above. This call records the completed TURN
      // against the user's run counter; passing the cost here as well is what
      // doubled the per-user naive total.
      await this.budgetService.recordUserSpend(scopeTuple, scope.userId, costWithCacheCents);
      const evalAfter = await this.budgetService.evaluate(scopeTuple, {
        agentId,
        userId: scope.userId,
      });
      for (const status of evalAfter.caps) {
        // PRELAUNCH-A3-5 — emit budget utilization gauge per cap. Was
        // previously dead code: the gauge was declared but never `.set()`
        // anywhere, so /metrics always returned zero.
        try {
          this.metrics?.budgetUtilizationGauge
            .labels({
              cap_id: status.cap.id,
              scope_type: status.cap.scopeType,
              period: status.cap.period,
            })
            .set(status.percent / 100);
        } catch {
          // Metrics never block turns.
        }
        const crossed = await this.budgetService.detectThresholdCrossings(scopeTuple, status);
        if (crossed.length === 0) continue;
        void this.budgetService
          .reconcileDueDeliveries({ eventIds: crossed.map((crossing) => crossing.id) })
          .then((result) => {
            if (result.failed > 0) {
              this.logger.error(`budget alert reconciliation failed for ${result.failed} event(s)`);
            }
          })
          .catch((error) => {
            this.logger.error(
              `budget alert reconciliation unavailable: ${error instanceof Error ? error.message : String(error)}`,
            );
          });
      }
    } catch {
      // Budget accounting failure should never break the turn.
    }

    // 8d. llm.inference child span carrying model + tokens + cost.
    try {
      const llmSpanId = this.spansService.nextSpanId();
      const llmEndNs = Date.now() * 1_000_000;
      await this.spansService.record(
        {
          organizationId: scope.organizationId,
          projectId: scope.projectId,
          environmentId: scope.environmentId,
          agentId,
          threadId: thread.id,
          userId: scope.userId,
          sessionContext: scope.sessionContext as
            | { user?: { name?: string; email?: string } }
            | null
            | undefined,
        },
        {
          traceId,
          spanId: llmSpanId,
          parentSpanId: rootSpanId,
          name: "llm.inference",
          kind: "client",
          startTimeUnixNano: turnStartNs,
          endTimeUnixNano: llmEndNs,
          durationMs: Math.round((llmEndNs - turnStartNs) / 1_000_000),
          status: "ok",
          attributes: {
            "platos.model": pricedModel,
            "platos.provider": pricedModel.includes(":") ? pricedModel.split(":")[0]! : "",
            "platos.input_tokens": totalInputTokens,
            "platos.output_tokens": totalOutputTokens,
            // PRELAUNCH-A1-6 — promote cache + reasoning onto the LLM span.
            "platos.cache_read_input_tokens": totalCacheReadTokens,
            "platos.cache_creation_input_tokens": totalCacheCreationTokens,
            "platos.reasoning_tokens": totalReasoningTokens,
            "platos.cost_cents": costCents,
            "platos.tool_calls": toolCallsLog.filter((t) => t.type === "call").length,
          },
        },
      );
    } catch {
      // Span write hiccup — tolerable; turn root span below still emits.
    }

    // 8e. Close out the root turn span.
    try {
      const turnEndNs = Date.now() * 1_000_000;
      await this.spansService.record(
        {
          organizationId: scope.organizationId,
          projectId: scope.projectId,
          environmentId: scope.environmentId,
          agentId,
          threadId: thread.id,
          userId: scope.userId,
          sessionContext: scope.sessionContext as
            | { user?: { name?: string; email?: string } }
            | null
            | undefined,
        },
        {
          traceId,
          spanId: rootSpanId,
          // EOBD.40 — link to the upstream parent span (webapp request)
          // when traceparent arrived on the inbound request. Without
          // this the turn root is an orphan even though it shares a
          // traceId with the parent.
          ...(inboundParent ? { parentSpanId: inboundParent } : {}),
          name: "agent.turn",
          kind: "internal",
          startTimeUnixNano: turnStartNs,
          endTimeUnixNano: turnEndNs,
          durationMs: Math.round((turnEndNs - turnStartNs) / 1_000_000),
          status: "ok",
          attributes: {
            "platos.turn.message_length": message.length,
            "platos.turn.response_length": fullText.length,
            // EOBD.31 — canonical key is `platos.cost_cents`. The
            // aggregator reads only that; removing the duplicate
            // attr here prevents double-count.
          },
        },
      );
    } catch {
      // Root span write hiccup — the clean Turn already has latency and cost.
    }

    // EOBD.41 + PRELAUNCH-A1-12 — hot-path Prometheus bumps with `kind`
    // labelling so SREs can graph cache hit rate / reasoning spend per
    // model. Fire-and-forget (prom-client is synchronous in-memory, but
    // we catch defensively).
    try {
      this.metrics?.turnsTotal.inc({ status: "success" });
      const durSeconds = (Date.now() - turnStartMs) / 1000;
      this.metrics?.turnDurationSeconds.observe({ status: "success" }, durSeconds);
      const provider = pricedModel.includes(":") ? pricedModel.split(":")[0]! : "";
      // PRELAUNCH-A1-12 — emit one counter per (direction, kind) tuple.
      // `text` is the fresh-token slice (input − cache_read − cache_write
      // for input; output − reasoning for output).
      const noCacheInput = freshInputTokens(
        totalInputTokens,
        totalCacheReadTokens,
        totalCacheCreationTokens,
      );
      const textOutputTokens = Math.max(0, totalOutputTokens - totalReasoningTokens);
      if (noCacheInput > 0) {
        this.metrics?.tokensTotal.inc(
          { direction: "input", model: pricedModel, kind: "text", provider },
          noCacheInput,
        );
      }
      if (totalCacheReadTokens > 0) {
        this.metrics?.tokensTotal.inc(
          { direction: "input", model: pricedModel, kind: "cache_read", provider },
          totalCacheReadTokens,
        );
      }
      if (totalCacheCreationTokens > 0) {
        this.metrics?.tokensTotal.inc(
          { direction: "input", model: pricedModel, kind: "cache_write", provider },
          totalCacheCreationTokens,
        );
      }
      if (textOutputTokens > 0) {
        this.metrics?.tokensTotal.inc(
          { direction: "output", model: pricedModel, kind: "text", provider },
          textOutputTokens,
        );
      }
      if (totalReasoningTokens > 0) {
        this.metrics?.tokensTotal.inc(
          { direction: "output", model: pricedModel, kind: "reasoning", provider },
          totalReasoningTokens,
        );
      }
      const toolCallCount = toolCallsLog.filter((t) => t.type === "call").length;
      if (toolCallCount > 0) {
        this.metrics?.toolCallsTotal.inc({ status: "success" }, toolCallCount);
      }
    } catch {
      // Prom-client hiccup. Never block a turn on telemetry.
    }

    // 9. Background compaction — LAUNCH-11. If the thread has grown past
    //    the configured compactThreshold AND historyMode is "compact", run
    //    a Haiku summarization over the oldest (N - contextLimit) messages
    //    and store as thread.compactedSummary. Next turn's dynamic context
    //    picks it up automatically.
    //
    //    Was a fire-and-forget Promise that didn't survive an agent
    //    restart and could pile up under load. Now triggers the durable
    //    `platos.compaction` task with an idempotency key derived from
    //    (threadId + latestMessageId) so a duplicate fire is a no-op.
    //    Falls back to the original in-process behavior when trigger.dev
    //    isn't configured (dev / docker without TRIGGER_API_URL).
    if (config.historyMode === "compact" && (await this.assessCompactionNeed(thread.id, scope, config))) {
      const triggerSdk = (() => {
        try { return require("@trigger.dev/sdk"); } catch { return null; }
      })();
      const triggerReady =
        configureExternalTriggerSdk(triggerSdk).status === "configured" &&
        !!triggerSdk?.tasks?.trigger;
      if (triggerReady) {
        // Idempotency: minute-resolution dedup on (threadId). If two turns
        // for the same thread complete in the same minute, only one
        // compaction task fires. Defense-in-depth — the
        // `compactionInFlight` mutex on the thread row also prevents
        // concurrent runs.
        const idempotencyKey = `compact:${thread.id}:${Math.floor(Date.now() / 60_000)}`;
        triggerSdk.tasks.trigger(
          "platos.compaction",
          {
            threadId: thread.id,
            scope: {
              organizationId: scope.organizationId,
              projectId: scope.projectId,
              environmentId: scope.environmentId,
              userId: scope.userId,
              agentId: scope.agentId ?? null,
            },
            // C1 FIX — carry the REAL agent config through the payload so the
            // durable callback uses it directly. Previously the callback
            // hardcoded {contextLimit:30, compactThreshold:40} and called
            // resolveConfigForThread on the wrong service (a silent no-op),
            // so compact-mode threads with a different contextLimit lost a
            // band of messages (kept neither verbatim nor summarized).
            contextLimit: config.contextLimit,
            compactThreshold: config.compactThreshold,
            historyMode: config.historyMode,
          },
          {
            idempotencyKey,
            tags: [
              `org:${scope.organizationId}`,
              `project:${scope.projectId}`,
              `env:${scope.environmentId}`,
              `thread:${thread.id}`,
            ],
          },
        ).catch((err: any) => {
          this.logger.error(`[compaction] external dispatch failed for thread ${thread.id}: ${err?.message}`);
          // Last-resort fallback so a transient trigger.dev outage doesn't
          // skip compaction entirely. In-process Promise — same shape as
          // the pre-LAUNCH-11 behavior.
          this.compactIfNeeded(thread.id, scope, config).catch((inner: any) => {
            this.logger.error(`[compaction] in-process fallback failed for thread ${thread.id}: ${inner?.message}`);
          });
        });
      } else {
        // trigger.dev not configured — keep the in-process fallback so
        // dev environments (and self-hosters who haven't wired
        // trigger.dev) still get compaction.
        this.compactIfNeeded(thread.id, scope, config).catch((err) => {
          this.logger.error(`[compaction] in-process failed for thread ${thread.id}: ${err?.message}`);
        });
      }
    }

    // 10. PIFSP-20 — Auto-name thread on first turn, fire-and-forget.
    //     history was loaded before the user message was stored, so
    //     history.length === 0 means this is genuinely the first exchange.
    if (history.length === 0 && !thread.title && fullText) {
      this.autoNameThread(thread.id, message, fullText, scope).catch((err) => {
        console.warn(`[auto-name] failed for thread ${thread.id}: ${err?.message}`);
      });
    }

    // PIFSP-2 — fire-and-forget overview.turn.completed Socket.IO event
    // so Plato Central updates within ~1s without a page reload.
    setImmediate(() => {
      try {
        const room = `scope:${scope.organizationId}:${scope.projectId}:${scope.environmentId}`;
        this.redis.publish("overview:event", JSON.stringify({
          room,
          event: "overview.turn.completed",
          data: {
            agentId: scope.agentId ?? null,
            threadId: thread.id,
            userId: scope.userId ?? null,
          },
        })).catch(() => {});
      } catch {}
    });

    // `done` is the task-level terminal event. It must follow the durable
    // assistant write and its `message_persisted` notification above.
    yield { type: "done" };

    // Wave 11b — mutex + idempotency key cleanup moved to finally below
    // so abnormal exit (throw) releases them too. Before this, idemKey
    // in particular was only released on the happy path, which meant a
    // transient auth/provider failure mid-turn locked out legitimate
    // retries for the full 600s TTL.
    } catch (error) {
      if (openTurnId && !turnFinalized) {
        try {
          await this.conversationService.failTurn(
            thread.id,
            openTurnId,
            scopeForThreadLookup,
            error,
            openStepModel,
          );
        } catch (persistenceError: any) {
          this.logger.error(
            `Failed to mark runtime turn ${openTurnId} failed: ${persistenceError?.message ?? persistenceError}`,
          );
        }
      }
      throw error;
    } finally {
      await mutex?.release();
      if (idemKey && earlyRedis) {
        await earlyRedis.del(idemKey).catch(() => undefined);
      }
      // PRELAUNCH-A3-7 — settle the budget reservation. Both success and
      // error paths reach this finally; settling here releases the in-flight
      // ¢ from the `*:reserved` counters so the next concurrent turn sees
      // a clean baseline. The actual spend is recorded independently via
      // CostService.recordUsage on success — the reservation is purely
      // a TOCTOU defence-in-depth, not the authoritative spend record.
      if (reservationCommitted) {
        await this.costService
          .settleReservation(reservationScopeTuple, reservationEstimateCents, scope.userId ?? null)
          .catch(() => undefined);
      }
      // Backfill displayName/email on the clean EndUser from resolved sessionContext.
      // scope.sessionContext is mutated by agentService.stream() so by this point
      // it contains the merged user.* fields (name, email). Fire-and-forget.
      if (scope.userId && scope.sessionContext) {
        const ctx = scope.sessionContext as Record<string, unknown>;
        const user = ctx.user as Record<string, unknown> | null;
        const displayName = (user?.name ?? user?.["user.name"]) as string | undefined;
        const email = (user?.email ?? user?.["user.email"]) as string | undefined;
        if (displayName || email) {
          this.conversationService.enrichEndUser(scope, scope.userId, { displayName, email }).catch(() => undefined);
        }
      }
    }
  }

  /**
   * Inline compaction — summarize messages older than contextLimit when the
   * thread crosses compactThreshold. MVP uses Haiku via generateText; future
   * iterations will move this to a trigger.dev durable task (Phase 2 polish).
   *
   * PPR-57 — every query below filters by the full scope tuple in addition
   * to `threadId`. Previously the compaction job read + wrote thread rows
   * using only `{ threadId }` on the assumption that the parent handler had
   * already scope-gated the turn — but `compactIfNeeded` runs detached in a
   * `.catch()` fire-and-forget, so a misrouted threadId (or a stale id from
   * an archived thread in another scope) could read messages and overwrite
   * `compactedSummary` across scope boundaries. Fail-closed: if the thread
   * isn't in the caller's scope, we skip silently (matching the parent
   * handler's contract, which also treats an unresolvable thread as a
   * no-op rather than throwing into the fire-and-forget).
   */
  /**
   * LAUNCH-11 — public wrapper so the durable `platos.compaction` trigger
   * task can call back via `/api/v1/agent/internal/compaction`. The task
   * runs in a separate worker process, calls the agent's internal HTTP
   * endpoint, which delegates to this method. Fire-and-forget callers in
   * this file still use this method directly.
   */
  async runCompaction(
    threadId: string,
    scope: RequestScope,
    config: AgentConfig,
  ): Promise<void> {
    return this.compactIfNeeded(threadId, scope, config);
  }

  /**
   * COMPACTION VOLUME GUARD — decide, cheaply, whether a compaction run is
   * worth spawning. Previously the turn-tail dispatched a durable
   * `platos.compaction` run on EVERY turn for compact-mode threads (prod
   * showed ~1 compaction run per chat turn), and the task no-op'd inside
   * when below threshold. This moves the decision to the dispatch site so a
   * run is spawned only when (a) the thread is at/over `compactThreshold`
   * AND (b) at least a batch of messages has aged out of the live window
   * since the last compaction (tracked via `compactedUpToTurnId`). Any
   * error assessing → return true (dispatch), so the guard can never
   * silently suppress compaction.
   */
  private async assessCompactionNeed(
    threadId: string,
    scope: RequestScope,
    config: AgentConfig,
  ): Promise<boolean> {
    const prisma = (this.conversationService as any).prisma;
    const thread = await prisma.thread.findFirst({
      where: {
        id: threadId,
        environmentId: scope.environmentId,
        environment: {
          projectId: scope.projectId,
          project: { organizationId: scope.organizationId },
        },
      },
      select: {
        compactedUpToTurn: { select: { sequence: true } },
        _count: { select: { turns: true } },
      },
    });
    if (!thread) throw new Error("Compaction scope check failed");
    if (thread._count.turns < config.compactThreshold) return false;
    const alreadyCompacted = thread.compactedUpToTurn?.sequence ?? 0;
    const pending = thread._count.turns - config.contextLimit - alreadyCompacted;
    return pending >= Math.max(5, Math.round(config.contextLimit / 2));
  }

  private async compactIfNeeded(
    threadId: string,
    scope: RequestScope,
    config: AgentConfig,
    abortSignal?: AbortSignal,
  ): Promise<void> {
    const prisma = (this.conversationService as any).prisma;
    const scopeWhere = {
      id: threadId,
      environmentId: scope.environmentId,
      environment: {
        projectId: scope.projectId,
        project: { organizationId: scope.organizationId },
      },
    } as const;
    const acquired = await prisma.thread.updateMany({
      where: { ...scopeWhere, compactionState: "IDLE" },
      data: { compactionState: "IN_PROGRESS" },
    });
    if (acquired.count === 0) {
      const existing = await prisma.thread.findFirst({ where: scopeWhere, select: { compactionState: true } });
      if (!existing) throw new Error("Compaction thread not found or access denied");
      return;
    }

    try {
      const thread = await prisma.thread.findFirstOrThrow({
        where: scopeWhere,
        select: {
          summary: true,
          compactedUpToTurn: { select: { sequence: true } },
          _count: { select: { turns: true } },
        },
      });
      if (thread._count.turns < config.compactThreshold) {
        const released = await prisma.thread.updateMany({
          where: { ...scopeWhere, compactionState: "IN_PROGRESS" },
          data: { compactionState: "IDLE" },
        });
        if (released.count !== 1) throw new Error("Compaction no-op could not release ownership");
        return;
      }
      const cursorSequence = thread.compactedUpToTurn?.sequence ?? 0;
      const turns = await prisma.turn.findMany({
        where: {
          threadId,
          sequence: { gt: cursorSequence },
          status: "SUCCEEDED",
        },
        orderBy: { sequence: "asc" },
        select: { id: true, sequence: true, inputText: true, outputText: true },
      });
      const toCompact = turns.slice(0, Math.max(0, turns.length - config.contextLimit));
      if (toCompact.length < 5) {
        const released = await prisma.thread.updateMany({
          where: { ...scopeWhere, compactionState: "IN_PROGRESS" },
          data: { compactionState: "IDLE" },
        });
        if (released.count !== 1) throw new Error("Compaction no-op could not release ownership");
        return;
      }
      const conversationText = toCompact.flatMap((turn: any) => [
        ...(turn.inputText ? [`USER: ${turn.inputText}`] : []),
        ...(turn.outputText ? [`ASSISTANT: ${turn.outputText}`] : []),
      ]).join("\n\n");
      const { model, modelString, source } = await this.agentService.resolveCompactionModel(config, scope);
      const compactionPrice = await preflightModelPricing(this.costService, modelString);
      const summary = await generateText({
        model,
        instructions: "You are a conversation summarizer. Produce a concise, factual summary that preserves key facts, decisions, preferences, and context, without quoting messages verbatim. Keep under 500 words.",
        messages: [{ role: "user" as const, content: conversationText }],
        abortSignal,
      });
      const compactionUsage = (summary as any).usage;
      if ((compactionUsage?.inputTokens ?? 0) > 0 || (compactionUsage?.outputTokens ?? 0) > 0) {
        const priced = this.costService.priceUsageFromSnapshot(
          modelString,
          compactionPrice,
          compactionUsage?.inputTokens ?? 0,
          compactionUsage?.outputTokens ?? 0,
          compactionUsage?.inputTokenDetails?.cacheWriteTokens ?? 0,
          compactionUsage?.inputTokenDetails?.cacheReadTokens ?? 0,
        );
        await this.costService.recordAuxiliaryCost({
          scope: { organizationId: scope.organizationId, projectId: scope.projectId, environmentId: scope.environmentId },
          kind: "compaction",
          model: modelString,
          costCents: priced.costCents,
          inputTokens: compactionUsage?.inputTokens ?? 0,
          outputTokens: compactionUsage?.outputTokens ?? 0,
          agentId: scope.agentId,
          userId: scope.userId,
        });
      }
      const lastCompacted = toCompact.at(-1)!;
      const merged = thread.summary ? `${thread.summary}\n\n---\n\n${summary.text}` : summary.text;
      await prisma.$transaction(async (tx: any) => {
        const advanced = await tx.thread.updateMany({
          where: { ...scopeWhere, compactionState: "IN_PROGRESS" },
          data: {
            summary: merged,
            compactedAt: new Date(),
            compactedUpToTurnId: lastCompacted.id,
            compactionState: "IDLE",
          },
        });
        if (advanced.count !== 1) throw new Error("Compaction cursor lost its ownership token");
      });
      this.logger.log(`[compaction] thread=${threadId} compacted=${toCompact.length} model=${modelString} source=${source}`);
    } catch (error) {
      await prisma.thread.updateMany({
        where: { ...scopeWhere, compactionState: "IN_PROGRESS" },
        data: { compactionState: "IDLE" },
      });
      throw error;
    }
  }

  /**
   * Non-streaming conversation turn (for REST API).
   */
  async executeNonStreamingTurn(
    message: string,
    scope: RequestScope,
    options: {
      threadId?: string;
      agentId?: string;
      attachmentIds?: string[];
      systemPromptOverride?: string | null;
      /** W.1 — meta-tool allowlist for per-item batch executions. */
      allowedTools?: string[];
      /** Per-request model routing label (forwarded to executeStreamingTurn). */
      modelLabel?: string;
    } = {},
  ) {
    const events: AgentStreamEvent[] = [];
    for await (const event of this.executeStreamingTurn(message, scope, options)) {
      events.push(event);
    }

    // Extract the final response
    const tokens = events.filter((e) => e.type === "token").map((e) => e.text as string);
    const meta = events.find((e) => e.type === "meta");
    // Phase 1 review follow-up — pull cost off the message_persisted
    // event so the non-streaming path (REST + W.1 batch-turn controller)
    // can return accurate per-turn cost. Falls back to 0 if the turn
    // short-circuited before persist (e.g. safety flag, idempotent
    // dedup, validation failure).
    const persisted = events.find((e) => (e as any).type === "message_persisted") as
      | { costCents?: number }
      | undefined;
    const costCents = typeof persisted?.costCents === "number" ? persisted.costCents : 0;

    return {
      text: tokens.join(""),
      threadId: (meta as any)?.thread_id,
      events,
      costCents,
    };
  }

  /**
   * PIFSP-20 — Generate a 3-5 word title for a thread using Haiku.
   * Only runs on the first turn and only if the thread has no title yet.
   * Fire-and-forget: caller swallows errors so a naming failure never
   * affects the turn.
   */
  private async autoNameThread(
    threadId: string,
    userMessage: string,
    assistantReply: string,
    scope: RequestScope,
    /** PRELAUNCH-A2-8 — abort signal for the auto-name title LLM call. */
    abortSignal?: AbortSignal,
  ): Promise<void> {
    const prisma = (this.conversationService as any).prisma;
    if (!prisma?.thread) throw new Error("Thread persistence is unavailable");

    // Confirm thread is still in scope and still untitled.
    const row = await prisma.thread.findFirst({
      where: {
        id: threadId,
        environmentId: scope.environmentId,
        environment: {
          projectId: scope.projectId,
          project: { organizationId: scope.organizationId },
        },
        title: null,
      },
      select: { id: true },
    });
    if (!row) return;

    const autoNameModel = "anthropic:claude-haiku-4-5-20251001";
    const autoNamePrice = await preflightModelPricing(this.costService, autoNameModel);
    const model = anthropic("claude-haiku-4-5-20251001");
    // PRELAUNCH-A2-8 — propagate abort signal.
    const generated = await generateText({
      model,
      instructions:
        "You generate concise conversation titles. Respond with ONLY the title — no punctuation, no quotes, no explanation. 3-5 words maximum.",
      messages: [
        {
          role: "user" as const,
          content: `User: ${userMessage.slice(0, 300)}\nAssistant: ${assistantReply.slice(0, 300)}\n\nGenerate a 3-5 word title.`,
        },
      ],
      abortSignal,
    });
    const { text } = generated;
    const usage = (generated as any).usage;
    if ((usage?.inputTokens ?? 0) > 0 || (usage?.outputTokens ?? 0) > 0) {
      const priced = this.costService.priceUsageFromSnapshot(
        autoNameModel,
        autoNamePrice,
        usage?.inputTokens ?? 0,
        usage?.outputTokens ?? 0,
      );
      await this.costService.recordAuxiliaryCost({
        scope: { organizationId: scope.organizationId, projectId: scope.projectId, environmentId: scope.environmentId },
        kind: "thread-auto-name",
        model: autoNameModel,
        costCents: priced.costCents,
        inputTokens: usage?.inputTokens ?? 0,
        outputTokens: usage?.outputTokens ?? 0,
        agentId: scope.agentId,
        userId: scope.userId,
      });
    }

    const title = text.trim().replace(/[\r\n"'`]/g, "").slice(0, 100);
    if (!title) return;

    // updateMany with title: null guard is idempotent — if another worker
    // already named the thread this becomes a no-op.
    await prisma.thread.updateMany({
      where: {
        id: threadId,
        environmentId: scope.environmentId,
        environment: {
          projectId: scope.projectId,
          project: { organizationId: scope.organizationId },
        },
        title: null,
      },
      data: { title },
    });

    console.log(`[auto-name] thread ${threadId}: "${title}"`);

    // Publish lifecycle event so open Conversations tabs update live.
    const redis = (this.agentService as any)?.redis;
    if (redis) {
      redis
        .publish(
          "thread:lifecycle",
          JSON.stringify({
            type: "thread.title.generated",
            threadId,
            title,
            organizationId: scope.organizationId,
            projectId: scope.projectId,
            environmentId: scope.environmentId,
          }),
        )
        .catch(() => undefined);
    }
  }
}
