import { Injectable, Inject, Logger } from "@nestjs/common";
import { PRISMA_TOKEN } from "../shared/database.provider";
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
 * NOTE the gateway's Trigger-Sessions path ("session") is NOT a value here: it
 * is a socket-coupled rollout SUB-strategy of "durable" that lives entirely in
 * the gateway. It is layered on top of a "durable" decision, never a distinct
 * executionMode. Keeping it out of this type keeps the chokepoint transport-free.
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
  /** Client-supplied thread id; resolved + owner-gated inside triggerDurable. */
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
 *   (b) triggerDurable — dispatch to `platos.agent.durable-turn` (payload/idem/tags).
 *   (c) streamTurn / collectTurn — mode-routed streaming / collected primitives.
 *
 * Transport-free: no Socket, no Response, no Slack. Callers keep their tails
 * (room join + RunsBridge subscribe on the gateway; SSE writer on the
 * controller; chat.postMessage on the channel) DOWNSTREAM of the decision.
 */
@Injectable()
export class TurnDispatchService {
  private readonly logger = new Logger(TurnDispatchService.name);

  /** Bounds the wait for a durable run to reach terminal (matches the task's
   *  `maxDuration: 600` plus a small buffer). Configurable for tests/ops. */
  private readonly durableAwaitTimeoutMs = Math.max(
    30_000,
    Number(process.env.PLATOS_DURABLE_COLLECT_TIMEOUT_MS) || 610_000,
  );

  constructor(
    @Inject(PRISMA_TOKEN) private readonly prisma: any,
    private readonly agentTaskService: AgentTaskService,
    private readonly conversationService: ConversationService,
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
   * durable → dispatch to Trigger and surface the run result over the same
   * stream (a `meta` with the resolved thread id, the assembled reply as a
   * single `token`, then `message_persisted` + `done`). Fail-open: a durable
   * DISPATCH failure falls through to the direct in-process stream.
   *
   * For a DIRECT agent this yields EXACTLY what `executeStreamingTurn` yields —
   * zero behavior change. Durable SSE is coarse-grained (no token-by-token
   * relay — durable tokens flow through the thread room, not the run channel)
   * but honors the invariant: a durable agent dispatches to Trigger.
   */
  async *streamTurn(agentId: string, ctx: TurnDispatchContext): AsyncGenerator<AgentStreamEvent> {
    const mode = await this.resolveMode(agentId, ctx.scope);
    if (mode === "direct") {
      yield* this.streamDirect(agentId, ctx);
      return;
    }
    let handle: DurableDispatchHandle;
    try {
      handle = await this.triggerDurable(agentId, ctx);
    } catch (err: any) {
      // DISPATCH failure → fail-open to the in-process path (no run started).
      this.logger.warn(
        `durable dispatch failed (streamTurn), falling back to direct: ${err?.message ?? err}`,
      );
      yield* this.streamDirect(agentId, ctx);
      return;
    }
    yield { type: "meta", thread_id: handle.threadId } as AgentStreamEvent;
    const result = await this.awaitDurableRun(handle.runId);
    if (result.text) {
      yield { type: "token", text: result.text } as AgentStreamEvent;
    }
    yield {
      type: "message_persisted",
      messageId: result.messageId,
      threadId: handle.threadId,
      costCents: result.costCents,
    } as unknown as AgentStreamEvent;
    yield { type: "done" } as AgentStreamEvent;
  }

  /**
   * (c) Mode-routed COLLECTED (non-streaming) primitive — the channel's need.
   * direct → drain the in-process turn (identical extraction to
   * `executeNonStreamingTurn`); durable → dispatch to Trigger and await the run
   * to terminal, reading `output.text`.
   *
   * Fail-open is scoped to DISPATCH failure: if `triggerDurable` throws, no run
   * started, so we safely fall back to the in-process path (never a dropped
   * turn). A run that dispatched but then FAILED during execution is NOT
   * re-run in-process (that would double-execute side effects) — it returns the
   * collected text (empty on failure); the durable run's own error handling
   * surfaces the failure to the thread room.
   */
  async collectTurn(agentId: string, ctx: TurnDispatchContext): Promise<CollectedTurnResult> {
    const mode = await this.resolveMode(agentId, ctx.scope);
    if (mode === "direct") {
      return this.collectDirect(agentId, ctx);
    }
    let handle: DurableDispatchHandle;
    try {
      handle = await this.triggerDurable(agentId, ctx);
    } catch (err: any) {
      // DISPATCH failure → fail-open to in-process (no run started ⇒ safe).
      this.logger.warn(
        `durable dispatch failed (collectTurn), falling back to direct: ${err?.message ?? err}`,
      );
      return this.collectDirect(agentId, ctx);
    }
    const result = await this.awaitDurableRun(handle.runId);
    return {
      text: result.text,
      threadId: handle.threadId,
      costCents: result.costCents,
      messageId: result.messageId,
    };
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

  /**
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
