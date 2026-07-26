import { Injectable, Inject, Logger } from "@nestjs/common";
import { PRISMA_TOKEN } from "../shared/database.provider";
import { REDIS_TOKEN } from "../shared/redis.provider";
import type IORedis from "ioredis";
import { AgentTaskService } from "./agent-task.service";
import { ConversationService } from "../memory/conversation.service";
import type { AgentStreamEvent, AgentConfig } from "./agent.service";
import type { RequestScope } from "../auth/scope.guard";

/**
 * Trigger.dev SDK — same lazy-require + configure pattern as
 * `runs-bridge.service.ts` / `agent.service.ts` so the agent process boots even
 * when the SDK isn't configured (local dev without TRIGGER_SECRET_KEY). The
 * module singleton is shared with RunsBridge, so `configure()` is idempotent.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
let triggerSdk: any = null;
try {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  triggerSdk = require("@trigger.dev/sdk");
  // TODO(env.ts) consider migration — runs at module-import time, before
  // main.ts's validateAgentEnv() surfaces structured errors. Direct
  // process.env keeps boot quiet when the SDK isn't configured (local dev).
  if (process.env.TRIGGER_SECRET_KEY && triggerSdk?.configure) {
    triggerSdk.configure({
      accessToken: process.env.TRIGGER_SECRET_KEY,
      baseURL: process.env.TRIGGER_API_URL || "http://localhost:3030",
    });
  }
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
   *  `driveSession`. Comfortably inside the task's `timeout:"1h"` but bounds a
   *  hung stream (the "warm loop deaf to appends" failure mode if the race
   *  guard is ever insufficient). On expiry the drain is aborted and whatever
   *  text accumulated so far is returned (collected) / an error+done is emitted
   *  (streaming). */
  private readonly sessionDriveTimeoutMs = Math.max(
    15_000,
    Number(process.env.PLATOS_SESSION_DRIVE_TIMEOUT_MS) || 90_000,
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
  ) {}

  /** True only when managed trigger is configured AND the durable-turn trigger
   *  entrypoint is loadable. When false, durable is unreachable ⇒ every turn is
   *  "direct" (zero behavior change on deployments without managed trigger). */
  private triggerReady(): boolean {
    return !!process.env.TRIGGER_SECRET_KEY && !!triggerSdk?.tasks?.trigger;
  }

  /**
   * (a) THE single dispatch decision. Reads `executionMode` off `PlatosAgent`
   * scoped to the full `(org, project, env, id)` tuple — the ONLY place it is
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
      const agent = await this.prisma.platosAgent.findFirst({
        where: {
          id: agentId,
          organizationId: scope.organizationId,
          projectId: scope.projectId,
          environmentId: scope.environmentId,
        },
        select: { executionMode: true },
      });
      executionMode = agent?.executionMode ?? "direct";
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
    if (!process.env.TRIGGER_SECRET_KEY) return null;
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

    let chatClient: any;
    let stream: AsyncIterable<any>;
    try {
      let lastEventId: string | undefined;
      try {
        lastEventId = (await this.redis.get(cursorKey)) ?? undefined;
      } catch {
        lastEventId = undefined;
      }

      // RACE GUARD (the multi-turn-SDK-bug workaround — KEEP VERBATIM). One
      // turn per run means the previous run spends ~10s finalizing after its
      // last chunk. An append during that window lands in the exiting run's
      // inbox and is never consumed. If the user replies within the window,
      // wait for the previous run to fully exit first. No-ops on first messages
      // (no cursor yet) and costs one retrieve on relaxed-cadence turns.
      if (lastEventId) {
        try {
          const sessionsSdk = triggerSdk?.sessions;
          const runsSdk = triggerSdk?.runs;
          const sess = await sessionsSdk?.retrieve(threadId).catch(() => null);
          const prevRunId = (sess as any)?.currentRunId as string | undefined;
          if (prevRunId && runsSdk?.retrieve) {
            for (let i = 0; i < 20; i++) {
              const r: any = await runsSdk.retrieve(prevRunId).catch(() => null);
              if (
                !r ||
                r.isCompleted ||
                !["EXECUTING", "QUEUED", "DEQUEUED", "WAITING"].includes(String(r.status))
              ) {
                break;
              }
              await new Promise((res) => setTimeout(res, 1000));
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
          scope: {
            organizationId: scope.organizationId,
            projectId: scope.projectId,
            environmentId: scope.environmentId,
            userId: scope.userId,
          },
        },
        ...(lastEventId ? { session: { lastEventId } } : {}),
        onTurnComplete: async ({ lastEventId: cursor }: { lastEventId?: string }) => {
          if (cursor) {
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
      onPart?.({ type: "error", message: err?.message ?? String(err) });
    } finally {
      if (timer) clearTimeout(timer);
    }
    if (timedOut) {
      try {
        await iterator.return?.();
      } catch {
        /* ignore */
      }
      // Swallow the orphaned drain so a late rejection can't crash the process.
      drain.catch(() => undefined);
      onPart?.({ type: "error", message: "durable session timed out" });
    }

    // Persist the session cursor DIRECTLY off the client (the reliable persist;
    // onTurnComplete alone was flaky). Load-bearing: the NEXT message's fresh
    // AgentChat must be constructed hydrated or its sessions.start
    // short-circuits and the append lands in a dead run's inbox.
    const cursor = (chatClient as any)?.session?.lastEventId as string | undefined;
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
