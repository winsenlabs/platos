import { Injectable, Inject, Logger } from "@nestjs/common";
import { PRISMA_TOKEN } from "../shared/database.provider";
import { REDIS_TOKEN } from "../shared/redis.provider";
import type IORedis from "ioredis";
import { AgentTaskService } from "./agent-task.service";
import { ConversationService } from "../memory/conversation.service";
import type { AgentStreamEvent, AgentConfig } from "./agent.service";
import type { RequestScope } from "../auth/scope.guard";
import { buildSessionScope } from "./session-scope";
import {
  configureExternalTriggerSdk,
  type ExternalTriggerConfig,
} from "../shared/external-trigger-config";

/**
 * Trigger.dev SDK — same lazy-require + configure pattern as
 * `runs-bridge.service.ts` / `agent.service.ts` so the agent process boots even
 * when the SDK isn't configured (local dev without TRIGGER_SECRET_KEY). The
 * module singleton is shared with RunsBridge, so `configure()` is idempotent.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
let triggerSdk: any = null;
let externalTriggerConfig: ExternalTriggerConfig = { status: "disabled" };
try {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  triggerSdk = require("@trigger.dev/sdk");
  externalTriggerConfig = configureExternalTriggerSdk(triggerSdk);
} catch {
  triggerSdk = null;
}

/**
 * Terminal trigger.dev run states — mirrors RunsBridgeService. Once a run hits
 * one of these, `awaitDurableRun` stops iterating and reads the final output.
 */
const TERMINAL_RUN_STATUSES = new Set([
  "COMPLETED",
  "FAILED",
  "CANCELED",
  "CRASHED",
  "TIMED_OUT",
  "SYSTEM_FAILURE",
]);

/**
 * The invariant-bearing dispatch decision. `executionMode` on `PlatosAgent` is
 * either "durable" or "direct"; this is the resolved decision AFTER accounting
 * for managed-trigger availability (durable is only reachable when trigger is
 * configured — otherwise every turn is "direct").
 *
 * NOTE Trigger Sessions are NOT a value here: "durable" ALWAYS routes to a
 * `platos.chat.session` SESSION internally (`driveSession`), for every entry
 * path. Sessions are an implementation of the "durable" decision, never a
 * distinct executionMode. Keeping them out of this type keeps the decision
 * transport-free (the socket/SSE/Slack tails stay with the callers).
 */
export type TurnDispatchDecision = "durable" | "direct";

/**
 * Everything the chokepoint needs to run (or dispatch) a turn, independent of
 * transport. The caller has already resolved + agentId-pinned + Postman-resolved
 * the `scope`; the chokepoint owns the durable-vs-direct decision and (for
 * durable) the trigger payload/idempotency/concurrency. It owns NO transport —
 * no Socket, no Response, no Slack. Those stay as per-path tails.
 */
export interface TurnDispatchContext {
  /** Already agentId-pinned + Postman-resolved by the caller. */
  scope: RequestScope;
  message: string;
  /** Client-supplied thread id; resolved + owner-gated inside driveSession
   *  (durable/Sessions) or streamDirect (direct). */
  threadId?: string;
  replyToMessageId?: string | null;
  /** Idempotency key — Trigger `clientMessageId` on the durable arm, and the
   *  `Idempotency-Key` on the direct arm. Threading the SAME value through both
   *  makes the dispatch-failure fallback safe against an ambiguous trigger send. */
  idempotencyKey?: string;
  // ── Pass-throughs to executeStreamingTurn (direct arm) ──────────────────
  dynamicBlocks?: Record<string, string>;
  attachmentIds?: string[];
  modelLabel?: string;
  contextType?: string;
  contextId?: string;
  systemPromptOverride?: string | null;
  outputSchema?: unknown;
  abortSignal?: AbortSignal;
  agentConfigOverride?: Partial<AgentConfig>;
  /** W.1 — per-turn meta-tool allowlist (batch executor). */
  allowedTools?: string[];
}

/** Handle returned by a successful durable trigger. */
export interface DurableDispatchHandle {
  runId?: string;
  /** The scope+owner-gated thread id the run was dispatched against. */
  threadId: string;
}

/** Collected (non-streaming) turn result — the primitive the channel needs. */
export interface CollectedTurnResult {
  text: string;
  threadId: string;
  costCents: number;
  messageId?: string;
  /**
   * Full event log — populated ONLY on the DIRECT arm (drained in-process
   * turn), matching `executeNonStreamingTurn`'s response shape so the REST
   * endpoints that return this verbatim keep their contract. Absent on the
   * durable arm (a durable run surfaces only its final text/cost, not the
   * per-event log).
   */
  events?: AgentStreamEvent[];
}

/**
 * TurnDispatchService — THE single durable-vs-direct chokepoint.
 *
 * THE INVARIANT: whether a turn runs DURABLE (on Trigger) or DIRECT (in-process)
 * is determined ENTIRELY by the agent's `executionMode`, NEVER by which entry
 * path / channel the request came through. Before this service, the WS gateway
 * read `executionMode` twice (duplicated) while the SSE/REST controller and the
 * Slack channel never read it at all — so a durable agent on Slack always ran
 * in-process. This service is the ONE place `executionMode` is read for
 * dispatch; every entry path (gateway, controller, channel) routes through it,
 * so no doorway re-decides (or forgets) the mode.
 *
 * Responsibilities:
 *   (a) resolveMode  — the single `executionMode` read (+ trigger-availability gate).
 *   (b) driveSession — the ONE durable execution mechanism: drive a Trigger
 *       `platos.chat.session` SESSION transport-free, exposed as `streamSession`
 *       (streaming) and `collectSession` (collected). `executionMode==="durable"`
 *       ALWAYS means Sessions now, for every entry path.
 *   (c) streamTurn / collectTurn — mode-routed streaming / collected primitives.
 *
 * Transport-free: no Socket, no Response, no Slack. Callers keep their tails
 * (room join + socket emit on the gateway; SSE writer on the controller;
 * chat.postMessage on the channel) DOWNSTREAM of the decision.
 *
 * DORMANT: `triggerDurable` + `awaitDurableRun` (the `platos.agent.durable-turn`
 * TASK dispatch) are NO LONGER on the chat dispatch path — "durable" routes to
 * Sessions. They are retained (uncalled by chat) pending removal; see their
 * DEPRECATED markers.
 */
@Injectable()
export class TurnDispatchService {
  private readonly logger = new Logger(TurnDispatchService.name);

  /** Bounds the wait for a durable run to reach terminal (matches the task's
   *  `maxDuration: 600` plus a small buffer). Configurable for tests/ops.
   *  DORMANT — only used by the retired `awaitDurableRun`. */
  private readonly durableAwaitTimeoutMs = Math.max(
    30_000,
    Number(process.env.PLATOS_DURABLE_COLLECT_TIMEOUT_MS) || 610_000,
  );

  /** Hard wall-clock bound on a single session `.out` drain inside
   *  `driveSession`. This is a SAFETY NET for a genuinely hung stream (the
   *  "warm loop deaf to appends" failure mode if the race guard is ever
   *  insufficient — the `.out` never completes), NOT a normal-operation cap.
   *  The former gateway session pump had NO wall-clock cap (it ran to `.out`
   *  completion, bounded only by the task's `timeout:"1h"`), so to preserve the
   *  demo's "streams to completion" behavior the default is GENEROUS (10m —
   *  comfortably inside the task's 1h, longer than any healthy chat turn, but
   *  bounding a true hang). Tune down via PLATOS_SESSION_DRIVE_TIMEOUT_MS. On
   *  expiry the drain is aborted and whatever text accumulated so far is
   *  returned (collected) / an error+done is emitted (streaming). */
  private readonly sessionDriveTimeoutMs = Math.max(
    15_000,
    Number(process.env.PLATOS_SESSION_DRIVE_TIMEOUT_MS) || 600_000,
  );

  /** LATENCY (audit F1) — how long after the previous turn's drain finished we
   *  still run the session race guard. Past this, the previous run has provably
   *  finalized (observed total run time ~14s, of which ~10s is post-drain
   *  finalization), so the guard's two Trigger Cloud round-trips are pure
   *  overhead and are skipped. Deliberately generous (>2x observed). Floor of
   *  15s keeps a mistuned env var from disabling the guard. */
  private readonly guardSkipMs = Math.max(
    15_000,
    Number(process.env.PLATOS_SESSION_GUARD_SKIP_MS) || 30_000,
  );

  constructor(
    @Inject(PRISMA_TOKEN) private readonly prisma: any,
    private readonly agentTaskService: AgentTaskService,
    private readonly conversationService: ConversationService,
    // The session cursor + race-guard live here now (lifted from the gateway).
    // RedisModule is @Global, so no module-import change is needed. The SAME
    // singleton client the gateway used is injected, so the scope-namespaced
    // cursor-key literal (`chatsess:cursor:...`) stays byte-identical across
    // the deploy and live cursors survive.
    @Inject(REDIS_TOKEN) private readonly redis: IORedis,
  ) {
    // Ops hygiene — the drain/collect timeouts fall back to their built-in
    // default when the env var doesn't parse (Number("foo") → NaN → default),
    // which silently hides a misconfiguration. Warn at boot so a typo'd
    // PLATOS_SESSION_DRIVE_TIMEOUT_MS=6O0000 (letter O) is visible rather than
    // mysteriously behaving like the default.
    for (const key of [
      "PLATOS_SESSION_DRIVE_TIMEOUT_MS",
      "PLATOS_DURABLE_COLLECT_TIMEOUT_MS",
    ]) {
      const raw = process.env[key];
      if (raw !== undefined && raw !== "" && (!Number.isFinite(Number(raw)) || Number(raw) <= 0)) {
        this.logger.warn(
          `[config] ${key}="${raw}" is not a positive number — ignoring it and using the built-in default.`,
        );
      }
    }
  }

  /** True only when managed trigger is configured AND the durable-turn trigger
   *  entrypoint is loadable. When false, durable is unreachable ⇒ every turn is
   *  "direct" (zero behavior change on deployments without managed trigger). */
  private triggerReady(): boolean {
    return externalTriggerConfig.status === "configured" && !!triggerSdk?.tasks?.trigger;
  }

  /**
   * (a) THE single dispatch decision. Reads `executionMode` from the active
   * AgentVersion selected by the canonically scoped AgentBinding — the ONLY place it is
   * read for dispatch across the whole agent service. Returns "direct" (never
   * "durable") when managed trigger is unconfigured or the lookup fails
   * (fail-open), so a turn is never wedged onto an unreachable substrate.
   */
  async resolveMode(agentId: string, scope: RequestScope): Promise<TurnDispatchDecision> {
    // Managed trigger not configured → durable can't actually run; everything
    // is direct. This is what makes the refactor a no-op on non-trigger
    // deployments (the gateway's two findFirsts were gated the same way).
    if (!this.triggerReady()) return "direct";
    let executionMode = "direct";
    try {
      const binding = await this.prisma.agentBinding.findFirst({
        where: {
          agentId,
          environmentId: scope.environmentId,
          agent: { projectId: scope.projectId },
          environment: {
            project: { id: scope.projectId, organizationId: scope.organizationId },
          },
        },
        select: { activeAgentVersion: { select: { memoryConfig: true } } },
      });
      const memoryConfig = binding?.activeAgentVersion?.memoryConfig;
      const runtime = memoryConfig && typeof memoryConfig === "object" && !Array.isArray(memoryConfig)
        ? (memoryConfig as Record<string, unknown>).__runtime
        : null;
      executionMode = runtime && typeof runtime === "object" && !Array.isArray(runtime)
        ? String((runtime as Record<string, unknown>).executionMode ?? "direct")
        : "direct";
    } catch {
      return "direct"; // fail-open on any DB error — never block the turn
    }
    return executionMode === "durable" ? "durable" : "direct";
  }

  /**
   * @deprecated DORMANT — chat dispatch now uses Trigger Sessions
   * (`driveSession`), so `executionMode==="durable"` ALWAYS means a
   * `platos.chat.session` SESSION. This `platos.agent.durable-turn` TASK
   * dispatch is NO LONGER called by `streamTurn`/`collectTurn`/the gateway.
   * Retained (uncalled by chat) + its task file + `/internal/durable-turn`
   * endpoint pending removal. Do NOT wire new chat callers to it.
   *
   * (b) Dispatch the turn to the `platos.agent.durable-turn` trigger task.
   * Extracted verbatim from the gateway's former `tryDispatchDurable` so the
   * already-working dashboard durable path is byte-for-byte preserved (same
   * payload, concurrency key, scope-namespaced idempotency key, and tags).
   *
   * ALWAYS resolves the client-supplied threadId through
   * `getOrCreateThread` first (cross-tenant IDOR guard — a foreign threadId
   * resolves to a freshly minted owned thread rather than joining someone
   * else's room / run). Returns the run handle + the resolved threadId.
   *
   * THROWS on any failure (trigger unconfigured, thread resolution failure,
   * trigger send error) so callers can fail-open to the direct in-process path.
   */
  async triggerDurable(agentId: string, ctx: TurnDispatchContext): Promise<DurableDispatchHandle> {
    if (!this.triggerReady()) {
      throw new Error("managed trigger not configured");
    }
    const scope = ctx.scope;
    // SECURITY (cross-tenant IDOR) — scope+owner-gate the threadId before we
    // hand it to a durable run. getOrCreateThread → getThread filters by the
    // full scope tuple AND ownership; a non-owned threadId resolves to a fresh
    // owned thread instead.
    const resolved = await this.conversationService.getOrCreateThread(scope, agentId, ctx.threadId);
    const threadId = resolved?.id;
    if (!threadId) {
      throw new Error("durable thread resolution failed");
    }

    const clientMessageId = ctx.idempotencyKey;
    const handle = await triggerSdk.tasks.trigger(
      "platos.agent.durable-turn",
      {
        threadId,
        agentId,
        message: ctx.message,
        replyToMessageId: ctx.replyToMessageId ?? null,
        clientMessageId: clientMessageId ?? null,
        scope: {
          organizationId: scope.organizationId,
          projectId: scope.projectId,
          environmentId: scope.environmentId,
          userId: scope.userId,
          agentId,
          threadId,
        },
      },
      {
        // Model A per-tenant fairness — one shared trigger project, isolated by
        // org-scoped concurrency key.
        concurrencyKey: `org-${scope.organizationId}`,
        // SECURITY (audit L4) — scope-namespace the Trigger idempotency key so a
        // cuid collision across tenants can't dedup one org's turn against
        // another's. Write-only (Trigger dedups server-side).
        ...(clientMessageId
          ? {
              idempotencyKey: `turn-${scope.organizationId}:${scope.projectId}:${scope.environmentId}-${threadId}-${clientMessageId}`,
            }
          : {}),
        tags: [
          `org:${scope.organizationId}`,
          `project:${scope.projectId}`,
          `env:${scope.environmentId}`,
          `thread:${threadId}`,
        ],
      },
    );
    return { runId: handle?.id as string | undefined, threadId };
  }

  /**
   * Direct arm — thin passthrough so every caller streams through one API. The
   * full `TurnDispatchContext` option set is forwarded to the existing
   * `executeStreamingTurn`, so behavior is identical to a direct caller today.
   */
  streamDirect(agentId: string, ctx: TurnDispatchContext): AsyncGenerator<AgentStreamEvent> {
    return this.agentTaskService.executeStreamingTurn(ctx.message, ctx.scope, {
      threadId: ctx.threadId,
      agentId,
      contextType: ctx.contextType,
      contextId: ctx.contextId,
      dynamicBlocks: ctx.dynamicBlocks,
      attachmentIds: ctx.attachmentIds,
      abortSignal: ctx.abortSignal,
      idempotencyKey: ctx.idempotencyKey,
      modelLabel: ctx.modelLabel,
      replyToMessageId: ctx.replyToMessageId ?? undefined,
      ...(ctx.systemPromptOverride !== undefined
        ? { systemPromptOverride: ctx.systemPromptOverride }
        : {}),
      ...(ctx.outputSchema !== undefined ? { outputSchema: ctx.outputSchema } : {}),
      ...(ctx.agentConfigOverride ? { agentConfigOverride: ctx.agentConfigOverride } : {}),
      ...(ctx.allowedTools ? { allowedTools: ctx.allowedTools } : {}),
    });
  }

  /**
   * Mode-routed STREAMING primitive (for SSE callers — the controller). The
   * decision is centralized: direct → the identical in-process token stream;
   * durable → drive a Trigger SESSION and relay its `.out` (real token-by-token
   * deltas + verbatim `message_persisted` + terminal `done`) over the same
   * stream. Fail-open: a session that is unavailable PRE-COMMIT yields nothing,
   * so we fall through to the direct in-process stream (the ONLY fallback —
   * durable no longer means the retired durable-turn task).
   *
   * For a DIRECT agent this yields EXACTLY what `executeStreamingTurn` yields —
   * zero behavior change. A DURABLE agent now streams real deltas off the
   * durable session (was: one coarse `token` off the durable-turn run), honoring
   * the invariant while matching the dashboard demo turn-for-turn.
   */
  async *streamTurn(agentId: string, ctx: TurnDispatchContext): AsyncGenerator<AgentStreamEvent> {
    const mode = await this.resolveMode(agentId, ctx.scope);
    if (mode === "direct") {
      yield* this.streamDirect(agentId, ctx);
      return;
    }
    // durable → Trigger Sessions. `streamSession` yields nothing when the
    // session is unavailable pre-commit → fail open to the direct in-process
    // stream. Once it yields its first frame the turn is committed (a dispatched
    // run is never re-run in-process), so a mid-stream failure surfaces as
    // error+done from within `streamSession`, not a fall-through.
    let yielded = false;
    for await (const evt of this.streamSession(agentId, ctx)) {
      yielded = true;
      yield evt;
    }
    if (!yielded) {
      yield* this.streamDirect(agentId, ctx);
    }
  }

  /**
   * (c) Mode-routed COLLECTED (non-streaming) primitive — the channel's need.
   * direct → drain the in-process turn (identical extraction to
   * `executeNonStreamingTurn`); durable → drive a Trigger SESSION and return
   * the reply accumulated off its durable `.out`. The channel (Slack/Connect/
   * Walle) now drives the SAME session envelope as the dashboard demo —
   * byte-identical at the turn level.
   *
   * Fail-open is scoped to PRE-COMMIT unavailability: if `collectSession`
   * returns null (flags off / SDK missing / thread won't resolve / send failed
   * before a run dispatched), no run started, so we safely fall back to the
   * in-process path (never a dropped turn). A run that dispatched but then
   * FAILED during execution is NOT re-run in-process (that would double-execute
   * side effects) — `collectSession` returns the collected text (empty on
   * failure); the session's own persistence/error handling stands.
   */
  async collectTurn(agentId: string, ctx: TurnDispatchContext): Promise<CollectedTurnResult> {
    const mode = await this.resolveMode(agentId, ctx.scope);
    if (mode === "direct") {
      return this.collectDirect(agentId, ctx);
    }
    // durable → Trigger Sessions (the ONE durable mechanism).
    let sessionResult: CollectedTurnResult | null = null;
    try {
      sessionResult = await this.collectSession(agentId, ctx);
    } catch (err: any) {
      // Unexpected throw (driveSession fails open with null, not a throw) —
      // treat as pre-commit and fall open to the direct in-process turn.
      this.logger.warn(
        `durable session failed (collectTurn), falling back to direct: ${err?.message ?? err}`,
      );
      return this.collectDirect(agentId, ctx);
    }
    if (sessionResult) return sessionResult;
    // Session unavailable pre-commit → the ONLY fallback is direct in-process.
    return this.collectDirect(agentId, ctx);
  }

  /**
   * Drain the in-process streaming turn into a collected result. Same
   * extraction as `AgentTaskService.executeNonStreamingTurn`, but sourced from
   * `streamDirect` so the full option set (agentConfigOverride, outputSchema,
   * dynamicBlocks, …) is honored uniformly.
   */
  private async collectDirect(agentId: string, ctx: TurnDispatchContext): Promise<CollectedTurnResult> {
    const events: AgentStreamEvent[] = [];
    for await (const event of this.streamDirect(agentId, ctx)) {
      events.push(event);
    }
    const text = events
      .filter((e) => e.type === "token")
      .map((e) => (e as { text: string }).text)
      .join("");
    const meta = events.find((e) => e.type === "meta") as { thread_id?: string } | undefined;
    const persisted = events.find((e) => (e as any).type === "message_persisted") as
      | { costCents?: number; messageId?: string }
      | undefined;
    return {
      text,
      threadId: meta?.thread_id ?? ctx.threadId ?? "",
      costCents: typeof persisted?.costCents === "number" ? persisted.costCents : 0,
      messageId: persisted?.messageId,
      events,
    };
  }

  // ─────────────────────────────────────────────────────────────────────────
  // Trigger SESSIONS — the ONE durable execution mechanism.
  //
  // `executionMode==="durable"` ALWAYS means a `platos.chat.session` SESSION
  // now, for every entry path. This block is the `tryDispatchSession` drive
  // lifted VERBATIM out of the gateway (connections.gateway.ts) and made
  // transport-free: the socket-emit tail was replaced by an `onPart` callback.
  // `streamSession` (streaming — gateway/SSE) and `collectSession` (collected —
  // channel) are the two primitives over the shared `driveSession` core. The
  // working demo session path is preserved byte-identically in observable
  // behavior (same frame shapes, same cursor key, same 30d EX, same race guard,
  // same fresh-AgentChat-per-message).
  // ─────────────────────────────────────────────────────────────────────────

  /** Lazy `@trigger.dev/sdk/chat` load — the chat family is ESM+CJS dual and
   *  loadable via require() from this bundle (the demo proves it). Returns null
   *  when unavailable so `driveSession` fails open to the direct path. */
  private loadAgentChat(): any | null {
    try {
      // eslint-disable-next-line @typescript-eslint/no-var-requires
      const chatSdk = require("@trigger.dev/sdk/chat");
      return chatSdk?.AgentChat ?? null;
    } catch {
      return null;
    }
  }

  /**
   * (b) THE durable execution core — drive one turn on a Trigger SESSION,
   * transport-free. Lifted from the gateway's former `tryDispatchSession`
   * (connections.gateway.ts:764–920) with the socket emit replaced by `onPart`.
   *
   * Returns `null` PRE-COMMIT (session unavailable: flags off, SDK missing,
   * thread won't resolve, or the send failed before any run dispatched) so the
   * caller fails open to the ONLY fallback — the in-process direct path. Once
   * the session `.sendMessage` has (idempotently) dispatched a continuation run
   * it is COMMITTED: this never returns null after that (a started run is never
   * re-run in-process — that would double-execute side effects); it drains the
   * durable `.out`, translating each part to an `agent_event` frame via
   * `onPart` AND accumulating `fullText` + capturing cost/messageId, then
   * returns `{ text, threadId, costCents, messageId }`.
   *
   * `onPart` frames (identical to the gateway's former pump):
   *   meta            — `{ type:"meta", thread_id, threadId, durable, session }` (first)
   *   token           — `{ type:"token", text }` per `text-delta`
   *   verbatim event  — the `data-platos-event` payload (incl. `message_persisted`)
   *   error           — `{ type:"error", message }`
   *   done            — `{ type:"done" }` (terminal, synthesized after `.out` drains)
   *
   * Done-signal: `.out` async-iterator completion (the task does `turn.done()`).
   * A hard wall-clock timeout (`sessionDriveTimeoutMs`) bounds a hung drain.
   */
  private async driveSession(
    agentId: string,
    ctx: TurnDispatchContext,
    onPart?: (evt: Record<string, unknown>) => void,
  ): Promise<CollectedTurnResult | null> {
    // ── PRE-COMMIT gate (return null → caller falls open to direct) ──────────
    // executionMode is NOT read here — the caller (streamTurn/collectTurn/
    // gateway) only reaches driveSession after resolveMode decided "durable".
    // These are the SESSION sub-strategy's own gates (rollout flag, trigger
    // secret, chat SDK present), lifted from the gateway.
    if (process.env.PLATOS_CHAT_SESSIONS !== "true") return null;
    if (externalTriggerConfig.status !== "configured") return null;
    const AgentChat = this.loadAgentChat();
    if (!AgentChat) return null;

    const scope = ctx.scope;

    // SECURITY (cross-tenant IDOR) — ALWAYS resolve the threadId through
    // getOrCreateThread, which scope+owner-gates it. A non-owned threadId
    // resolves to a freshly minted (owned) thread instead. The session
    // externalId IS this resolved threadId (1:1 session↔thread), so it must
    // exist first anyway. (Same guard as `triggerDurable`.)
    let threadId: string | undefined;
    try {
      const resolved = await this.conversationService.getOrCreateThread(scope, agentId, ctx.threadId);
      threadId = resolved?.id as string | undefined;
    } catch {
      return null;
    }
    if (!threadId) return null;

    // SECURITY (audit L4) — scope-namespace the cursor key. MUST stay
    // byte-identical to the gateway's former literal so live cursors survive
    // the deploy (same Redis singleton, same platos: keyPrefix).
    const cursorKey = `chatsess:cursor:${scope.organizationId}:${scope.projectId}:${scope.environmentId}:${threadId}`;
    // LATENCY (audit F1) — wall-clock stamp of when the PREVIOUS turn's drain
    // finished, used to skip the race guard's Trigger Cloud round-trips when
    // the previous run has provably finalized. See the guard below.
    const prevDoneKey = `chatsess:prevdone:${scope.organizationId}:${scope.projectId}:${scope.environmentId}:${threadId}`;

    let chatClient: any;
    let stream: AsyncIterable<any>;
    // The authoritative continuation cursor: `onTurnComplete` fires with the
    // run's final `lastEventId` when the turn actually completes. Captured here
    // so the post-drain persist prefers it over reading it back off the client
    // (which lags / can be undefined, esp. on a timed-out drain → the next
    // turn's fresh AgentChat would hydrate from a stale cursor and replay).
    let committedCursor: string | undefined;
    try {
      let lastEventId: string | undefined;
      try {
        lastEventId = (await this.redis.get(cursorKey)) ?? undefined;
      } catch {
        lastEventId = undefined;
      }

      // RACE GUARD (the multi-turn-SDK-bug workaround). One turn per run means
      // the previous run spends ~10s finalizing after its last chunk. An append
      // during that window lands in the exiting run's inbox and is never
      // consumed, so the message is silently lost — the guard waits it out.
      //
      // LATENCY (audit F1): the guard used to pay TWO cross-region Trigger
      // Cloud round-trips (sessions.retrieve + runs.retrieve) on EVERY turn
      // after the first, and polled at a 1s interval (overshooting the actual
      // exit by up to 1s). Two safe reductions, neither of which weakens the
      // protection:
      //
      //  1. SKIP WHEN PROVABLY SAFE — we stamp wall-clock time when the
      //     previous turn's drain finished (`prevDoneKey`). If more than
      //     `guardSkipMs` has elapsed since then, the previous run has long
      //     since finalized (observed total run time ~14s; default margin is
      //     >2x that), so the guard can be skipped entirely — zero API calls.
      //     This is the relaxed-cadence case, i.e. most turns.
      //     NOTE: deliberately NOT "skip whenever the stamp exists" — the
      //     stamp marks drain completion, which is ~10s BEFORE the run
      //     actually exits. Skipping on mere existence would reintroduce the
      //     silent message loss this guard prevents.
      //  2. POLL FASTER — 250ms instead of 1000ms, bounded by a wall-clock
      //     DEADLINE (~20s) rather than an iteration count, so the ceiling
      //     stays honest no matter the API round-trip time. The wait now ends
      //     within ~250ms of the run actually exiting instead of up to 1s late.
      //
      // Missing/expired stamp ⇒ unknown ⇒ run the guard (fail safe).
      //
      // RESUME-FROM-HEAD (2026-07-28 live forensics — the "one turn behind"
      // bug): the stored Redis cursor only advances via onTurnComplete, so a
      // turn whose events were never fully consumed (approval suspension →
      // continuation ran after the caller's sendMessage returned) leaves the
      // cursor permanently behind the session head. Every later sendMessage
      // then REPLAYS the previous turn's tail first — whose replayed terminal
      // `done` ends the new caller's stream in seconds (observed: constant
      // ~6.7s runs each delivering the PREVIOUS turn's reply, one turn behind,
      // indefinitely), and the replay boundary clipped the first text-delta
      // ("Got it," arriving as "it,"). Fix: resume from the session's LIVE
      // head event id — backlog belongs to prior turns the caller already
      // handled. The stored cursor stays as the fallback.
      //
      // MERGE NOTE (why the head capture is NOT inside the guard): the F1
      // skip above turns the guard off on relaxed-cadence turns, which is
      // MOST turns. The head id comes from `sessions.retrieve`, so gating
      // that retrieve on `guardNeeded` would leave `headEventId` undefined
      // exactly when the guard is skipped, silently falling back to the stale
      // cursor and resurrecting the one-turn-behind bug — while still looking
      // correct in quick-reply testing, where the guard does run. So the
      // single cheap `sessions.retrieve` runs whenever a cursor exists, and
      // only the multi-second `runs.retrieve` POLL is gated on `guardNeeded`.
      // That keeps F1's real win (skipping the poll, up to 20s) and costs one
      // ~300ms round-trip.
      let guardNeeded = !!lastEventId;
      if (guardNeeded) {
        try {
          const prevDoneRaw = await this.redis.get(prevDoneKey);
          const prevDoneAt = prevDoneRaw ? Number(prevDoneRaw) : NaN;
          if (Number.isFinite(prevDoneAt) && Date.now() - prevDoneAt > this.guardSkipMs) {
            guardNeeded = false;
          }
        } catch {
          // Redis unavailable — fall through and run the guard (fail safe).
        }
      }
      let headEventId: string | undefined;
      if (lastEventId) {
        try {
          const sessionsSdk = triggerSdk?.sessions;
          const runsSdk = triggerSdk?.runs;
          const sess = await sessionsSdk?.retrieve(threadId).catch(() => null);
          // Always captured (see MERGE NOTE) — this is what the new turn
          // resumes from, and it must not depend on whether the guard runs.
          headEventId = ((sess as any)?.lastEventId as string | undefined) ?? undefined;
          const prevRunId = (sess as any)?.currentRunId as string | undefined;
          // Only the POLL is gated: it is the expensive part (up to 20s), and
          // it is only needed when the previous run may still be finalizing.
          if (guardNeeded && prevRunId && runsSdk?.retrieve) {
            // Deadline-bounded (Fable verify A2): a fixed iteration count made
            // the real ceiling iterations × (sleep + API RTT), so shortening
            // the sleep silently GREW the worst case. Bound the wall clock
            // instead — the ceiling is now honestly ~20s regardless of RTT,
            // and the faster poll only makes the common case exit sooner.
            const deadline = Date.now() + 20_000;
            for (;;) {
              const r: any = await runsSdk.retrieve(prevRunId).catch(() => null);
              if (
                !r ||
                r.isCompleted ||
                !["EXECUTING", "QUEUED", "DEQUEUED", "WAITING"].includes(String(r.status))
              ) {
                break;
              }
              if (Date.now() >= deadline) break;
              await new Promise((res) => setTimeout(res, 250));
            }
          }
        } catch {
          // best-effort; proceed
        }
      }

      // FRESH AgentChat per message (deliberate — do NOT cache): with the
      // one-turn-per-run worker (chat.endRun after each turn), a cached
      // instance appends into a dead run's inbox and the message never
      // dispatches. A fresh instance takes the idempotent sessions.start path
      // and spawns a continuation run. The Redis lastEventId keeps replay off.
      chatClient = new AgentChat({
        agent: "platos.chat.session",
        id: threadId,
        clientData: {
          agentId,
          threadId,
          // Single source of truth for what crosses the Trigger-session
          // boundary — see session-scope.ts. Carries userToken (turn-proof),
          // entityId, principal (trust tier), userIdentities (end-user
          // linking) and sessionContext (timezone / user.*). Every hop below
          // is typed to SessionScope so no field can silently drop again.
          scope: buildSessionScope(scope),
        },
        // Prefer the live head over the stored cursor (see RESUME-FROM-HEAD
        // above) so stale-cursor backlog can never replay into a new turn.
        ...(headEventId || lastEventId
          ? { session: { lastEventId: headEventId ?? lastEventId } }
          : {}),
        onTurnComplete: async ({ lastEventId: cursor }: { lastEventId?: string }) => {
          if (cursor) {
            committedCursor = cursor; // authoritative — prefer at post-drain persist
            await (this.redis as any)
              .set(cursorKey, cursor, "EX", 60 * 60 * 24 * 30)
              .catch(() => undefined);
          }
        },
      });

      stream = (await chatClient.sendMessage(ctx.message)) as AsyncIterable<any>;
    } catch (err: any) {
      // PRE-COMMIT failure (thread cursor / race guard / AgentChat construct /
      // the send itself throwing before a run dispatched). Nothing streamed,
      // no `onPart` fired → safe to fall open to the direct path.
      this.logger.warn(`session drive pre-commit failed (falling open to direct): ${err?.message ?? err}`);
      return null;
    }

    // ── COMMITTED: a continuation run is (idempotently) dispatched. ──────────
    // From here we NEVER return null (never re-run in-process). Emit `meta`
    // first (mirrors the gateway's former `client.emit(meta)` before the pump),
    // then translate the durable `.out` into frames + accumulated text.
    onPart?.({ type: "meta", thread_id: threadId, threadId, durable: true, session: true });

    let fullText = "";
    let costCents = 0;
    let messageId: string | undefined;

    const iterator = stream[Symbol.asyncIterator]();
    const drain = (async () => {
      for (;;) {
        const res = await iterator.next();
        if (res.done) break;
        const part = res.value;
        let evt: Record<string, unknown> | null = null;
        if (part?.type === "text-delta") {
          const delta = (part.delta as string) ?? "";
          fullText += delta;
          evt = { type: "token", text: delta };
        } else if (part?.type === "data-platos-event") {
          evt = part.data as Record<string, unknown>;
          // Capture cost/messageId off the persisted event so the COLLECTED
          // (channel) path gets them with no run-output dependency (a
          // customAgent run does not expose output text anyway).
          if (evt && (evt as any).type === "message_persisted") {
            const c = (evt as any).costCents;
            const m = (evt as any).messageId;
            if (typeof c === "number") costCents = c;
            if (typeof m === "string") messageId = m;
          }
        } else if (part?.type === "error") {
          evt = { type: "error", message: (part.errorText as string) ?? "turn failed" };
        }
        // start / finish / text-start / text-end are structural — ignored
        // (matches the gateway's former pump: only these three translate).
        if (evt) onPart?.(evt);
      }
    })();

    // Hard wall-clock timeout around the drain. On expiry: abort the iterator
    // and surface what we have. The server-side run continues (durable) — we
    // only bound the LOCAL drain.
    let timedOut = false;
    let drainErrored = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<void>((resolve) => {
      timer = setTimeout(() => {
        timedOut = true;
        resolve();
      }, this.sessionDriveTimeoutMs);
    });
    try {
      await Promise.race([drain, timeout]);
    } catch (err: any) {
      // The `.out` drain threw (stream error) — surface it like the gateway's
      // former pump catch did (error frame, then the terminal done below).
      drainErrored = true;
      onPart?.({ type: "error", message: err?.message ?? String(err) });
    } finally {
      if (timer) clearTimeout(timer);
    }
    if (timedOut) {
      try {
        // A hung Session stream can also hang its iterator's cleanup. This is
        // best-effort cancellation only; awaiting it defeats the wall-clock
        // timeout and leaves the HTTP caller blocked indefinitely.
        void iterator.return?.().catch(() => undefined);
      } catch {
        /* ignore */
      }
      // Swallow the orphaned drain so a late rejection can't crash the process.
      drain.catch(() => undefined);
      onPart?.({ type: "error", message: "durable session timed out" });
    }

    // Persist the session cursor (load-bearing: the NEXT message's fresh
    // AgentChat must be constructed hydrated or its sessions.start
    // short-circuits and the append lands in a dead run's inbox). Prefer the
    // authoritative `committedCursor` captured in onTurnComplete; fall back to
    // reading it off the client only if the turn didn't signal completion
    // (e.g. a timed-out drain) — and never overwrite a live cursor with undefined.
    // LATENCY (audit F1) — stamp when this turn's drain finished so the NEXT
    // turn can skip the race guard once the finalization window has provably
    // passed.
    //
    // CRITICAL (Fable verify BLOCKER A1): only stamp on a CLEAN completion.
    // The skip check reads this as "the run was at its ~10s finalization at
    // T" — which is only true when the turn actually completed. On a
    // timed-out or errored drain the SERVER-SIDE RUN KEEPS EXECUTING
    // (durable; we only bound the local drain), so stamping there would let
    // a later message skip the guard and append into a still-live run's
    // inbox — silently lost under maxTurns:1. `committedCursor` is set by
    // onTurnComplete, i.e. proof the turn itself finished.
    //
    // And on the non-clean paths we must DELETE the key, not merely skip the
    // write: a stale stamp from an earlier turn would be even older and would
    // trigger the skip on its own. Deleting forces the next turn through the
    // full guard (fail safe).
    const drainCompletedCleanly = !timedOut && !drainErrored && committedCursor !== undefined;
    await (drainCompletedCleanly
      ? (this.redis as any).set(prevDoneKey, String(Date.now()), "EX", 3600)
      : (this.redis as any).del(prevDoneKey)
    ).catch(() => undefined);

    const cursor =
      committedCursor ?? ((chatClient as any)?.session?.lastEventId as string | undefined);
    if (cursor) {
      await (this.redis as any)
        .set(cursorKey, cursor, "EX", 60 * 60 * 24 * 30)
        .catch(() => undefined);
    }

    // Terminal frame — synthesized after `.out` drains (the task consumes its
    // own `done`; the gateway's former pump emitted this too).
    onPart?.({ type: "done" });

    return { text: fullText, threadId, costCents, messageId };
  }

  /**
   * STREAMING session primitive (gateway WS + SSE controller). Bridges
   * `driveSession`'s push-based `onPart` into a pull-based async generator that
   * yields `agent_event` frames: `meta` first, then `token` / verbatim
   * `data-platos-event` (incl. `message_persisted`) / `error`, then terminal
   * `done`.
   *
   * Yields NOTHING when the session is unavailable (flags off / SDK missing /
   * sub-thread reply / thread won't resolve / send failed pre-commit) — the
   * caller detects the empty stream and falls open to the direct in-process
   * path. Once it yields its first frame (`meta`) the turn is COMMITTED to the
   * session; a mid-stream failure surfaces as an `error`+`done`, never a
   * fall-through (a dispatched run is never re-run in-process).
   */
  async *streamSession(agentId: string, ctx: TurnDispatchContext): AsyncGenerator<AgentStreamEvent> {
    // `replyToMessageId` carve-out (§3.6) — sub-thread replies have no session
    // wire concept yet. Handled at THIS caller boundary (not a blanket gate in
    // driveSession) so the channel/SSE, which never set it, flow to sessions.
    // The gateway sub-thread case falls open to direct (NOT durable-turn).
    if (ctx.replyToMessageId) return;

    const queue: AgentStreamEvent[] = [];
    let ended = false;
    let wake: (() => void) | null = null;
    const wakeUp = () => {
      const w = wake;
      wake = null;
      w?.();
    };

    // driveSession runs independently, pushing translated frames into `queue`;
    // this generator pulls from it. `.out` is consumed as fast as it arrives
    // (buffered), independent of consumer speed — same as the gateway's former
    // non-awaited background pump.
    const runner = this.driveSession(agentId, ctx, (evt) => {
      queue.push(evt as AgentStreamEvent);
      wakeUp();
    }).then(
      () => {
        ended = true;
        wakeUp();
      },
      (err) => {
        // driveSession handles its own post-commit errors; an actual throw here
        // is unexpected. End the stream (empty queue ⇒ caller falls open).
        this.logger.warn(`streamSession drive threw: ${(err as any)?.message ?? err}`);
        ended = true;
        wakeUp();
      },
    );

    try {
      for (;;) {
        if (queue.length) {
          yield queue.shift()!;
          continue;
        }
        if (ended) break;
        await new Promise<void>((resolve) => {
          wake = resolve;
          // Re-check after registering: a frame pushed between the queue check
          // and here (single-threaded, so only if driveSession's onPart ran
          // synchronously in that window) would find `wake` already set — this
          // guard resolves immediately so we loop back and drain it.
          if (queue.length || ended) {
            wake = null;
            resolve();
          }
        });
      }
    } finally {
      await runner.catch(() => undefined);
    }
  }

  /**
   * COLLECTED session primitive (channel — Slack/Connect/Walle). Drives the
   * session to `.out` drain and returns the accumulated `{ text, threadId,
   * costCents, messageId }`. `fullText` comes from the `.out` `text-delta`
   * parts (no run-output dependency), cost/messageId from the persisted event.
   *
   * Returns `null` when the session is unavailable pre-commit → the caller
   * (`collectTurn`) falls open to the direct in-process path. A COMMITTED turn
   * that then failed returns its (possibly empty) text — never re-run.
   */
  async collectSession(agentId: string, ctx: TurnDispatchContext): Promise<CollectedTurnResult | null> {
    const r = await this.driveSession(agentId, ctx);
    if (!r) return null;
    return {
      text: r.text,
      threadId: r.threadId,
      costCents: r.costCents ?? 0,
      messageId: r.messageId,
    };
  }

  /**
   * @deprecated DORMANT — reads the terminal output of a `platos.agent.durable-
   * turn` run. Only `triggerDurable` fed this, and chat dispatch no longer
   * dispatches that task (durable === Sessions now). Retained pending removal.
   *
   * Await a durable run to a terminal status and read its final `output`.
   * Reuses the subscribe-to-terminal pattern RunsBridgeService demonstrates
   * (`runs.subscribeToRun` → read `snap.output` on terminal), with a
   * `runs.retrieve` fallback when the terminal snapshot lacked `output.text`,
   * and a hard timeout so a stuck run can't hang the caller forever. Best-
   * effort: returns empty text on any subscription/timeout failure rather than
   * throwing (the caller's fail-open already covered dispatch; a started run is
   * never re-run in-process).
   */
  private async awaitDurableRun(
    runId?: string,
  ): Promise<{ text: string; costCents: number; messageId?: string; status: string }> {
    const empty = { text: "", costCents: 0, messageId: undefined as string | undefined, status: "unknown" };
    if (!runId || !triggerSdk?.runs) return empty;

    const deadline = Date.now() + this.durableAwaitTimeoutMs;
    let output: any = undefined;
    let status = "unknown";
    try {
      if (triggerSdk.runs.subscribeToRun) {
        const iter: AsyncIterable<any> = triggerSdk.runs.subscribeToRun(runId);
        for await (const snap of iter) {
          status = String(snap?.status ?? "UNKNOWN");
          if (snap?.output !== undefined) output = snap.output;
          if (TERMINAL_RUN_STATUSES.has(status)) break;
          if (Date.now() > deadline) break;
        }
      }
    } catch (err: any) {
      this.logger.warn(`durable run subscription failed runId=${runId}: ${err?.message ?? err}`);
    }
    // Belt-and-suspenders: the terminal snapshot may not carry `output` on
    // every SDK version — retrieve once to get the authoritative final output.
    if ((output === undefined || output?.text === undefined) && triggerSdk.runs.retrieve) {
      try {
        const r = await triggerSdk.runs.retrieve(runId);
        status = String(r?.status ?? status);
        if (r?.output !== undefined) output = r.output;
      } catch {
        /* best-effort */
      }
    }
    return {
      text: typeof output?.text === "string" ? output.text : "",
      costCents: typeof output?.costCents === "number" ? output.costCents : 0,
      messageId: typeof output?.messageId === "string" ? output.messageId : undefined,
      status,
    };
  }
}
