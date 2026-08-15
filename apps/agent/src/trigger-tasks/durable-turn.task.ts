import { task, logger, metadata } from "@trigger.dev/sdk";
// Type-only (erased at build). Same source of truth for the carried scope as
// the live session path — so a future re-wire to this task can't reintroduce
// the boundary-drop bug class. See session-scope.ts.
import type { SessionScope } from "../agent-runtime/session-scope";

/**
 * @deprecated DORMANT — chat dispatch now runs `executionMode==="durable"` on
 * Trigger SESSIONS (`platos.chat.session` — see `chat-session.task.ts`), driven
 * by `TurnDispatchService.driveSession`. Nothing dispatches THIS task anymore
 * (the chokepoint's `triggerDurable` is uncalled by the chat path; the gateway's
 * former `tryDispatchDurable` was removed). The task file + its
 * `/internal/durable-turn` callback are retained (dormant, still functional)
 * pending removal — verify no non-chat caller depends on them before deleting.
 * Do NOT wire new dispatch to `platos.agent.durable-turn`.
 *
 * REFACTOR (control-plane + trigger substrate) — durable agent turn.
 *
 * The `durable` half of the per-agent `executionMode`. When a
 * `PlatosAgent.executionMode === "durable"`, the dispatch branch triggers
 * this task instead of running the turn in-process. The turn then survives
 * agent restarts/redeploys and can suspend for human-in-the-loop.
 *
 * Variant (A) — thin shell (this file): the task calls back into the agent
 * process (`POST /api/v1/agent/internal/durable-turn`, admin-token gated —
 * same pattern as compaction.task.ts) which runs the existing
 * `AgentTaskService.executeStreamingTurn` logic. Keeping the loop in the
 * agent process means the worker needs no DB/Prisma/scope/gateway plumbing.
 * Progress is surfaced via trigger `metadata` → `runs.subscribeToRun` →
 * RunsBridgeService → the thread's Socket.io room (the exact path agent_batch
 * already uses).
 *
 * Variant (B) — run-in-worker (later, needs the @trigger.dev/sdk swap +
 * Sessions/chat.agent): the loop executes inside the worker and only calls
 * back for entity tools via `/internal/execute-tool`.
 *
 * Per-tenant fairness: the caller passes `concurrencyKey: "org-<id>"` at
 * `.trigger()` time (Model A logical isolation). Idempotency:
 * `turn-<threadId>-<clientMessageId>`.
 *
 * NOTE: `/api/v1/agent/internal/durable-turn` is added in the callbacks step
 * of the refactor; until then this task compiles but is inert.
 */
export interface DurableTurnPayload {
  threadId: string;
  agentId: string;
  message: string;
  replyToMessageId?: string | null;
  clientMessageId?: string | null;
  // SessionScope + the re-stamped agentId/threadId — same carried set as the
  // live session path (userToken, entityId, principal, userIdentities,
  // sessionContext), so a re-wire to this (dormant) task can't reintroduce the
  // boundary-drop bug class.
  scope: SessionScope & { agentId?: string; threadId?: string };
}

export interface DurableTurnOutput {
  status: "ok" | "skipped" | "failed";
  reason?: string;
  threadId: string;
  /**
   * Final assembled assistant text for the turn. Carried on the run's
   * terminal `output` so NON-STREAMING callers (the channel collected-result
   * path via TurnDispatchService.collectTurn) can await the run to terminal
   * and read the reply without a socket/SSE stream. The internal callback
   * (`/internal/durable-turn`) already returns `text: fullText`; this field
   * is what surfaces it through `runs.subscribeToRun`/`runs.retrieve`.
   */
  text?: string;
  messageId?: string;
  costCents?: number;
  durationMs?: number;
}

export const durableTurn = task({
  id: "platos.agent.durable-turn",
  description:
    "Durable agent turn — runs an executionMode=durable turn that survives restarts/redeploys and can suspend for approvals. Thin shell that calls back into the agent's /internal/durable-turn; streams progress via metadata to RunsBridgeService.",
  queue: { name: "platos-durable-turn", concurrencyLimit: 100 },
  maxDuration: 600, // a durable turn (incl. tool steps) is bounded generously at 10m
  retry: { maxAttempts: 1 }, // turns are not safely auto-retryable (side effects); idempotency-keyed at trigger
  run: async (payload: DurableTurnPayload): Promise<DurableTurnOutput> => {
    const start = Date.now();
    metadata.set("threadId", payload.threadId);
    metadata.set("agentId", payload.agentId);
    metadata.set("scope.organizationId", payload.scope.organizationId);
    metadata.set("status", "running");

    const AGENT_API_URL =
      process.env.PLATOS_AGENT_HTTP_URL || process.env.PLATOS_AGENT_API_URL || "http://localhost:3100";
    const adminToken = process.env.PLATOS_INTERNAL_AUTH_TOKEN;
    if (!adminToken) {
      logger.warn("durable-turn: PLATOS_INTERNAL_AUTH_TOKEN not set — skipping");
      return { status: "skipped", reason: "PLATOS_INTERNAL_AUTH_TOKEN unset", threadId: payload.threadId };
    }

    try {
      const res = await fetch(`${AGENT_API_URL}/api/v1/agent/internal/durable-turn`, {
        method: "POST",
        headers: { "Content-Type": "application/json", "X-Platos-Internal-Auth": adminToken },
        body: JSON.stringify(payload),
        signal: AbortSignal.timeout(590_000),
      });
      if (!res.ok) {
        const body = await res.text().catch(() => "");
        throw new Error(`durable-turn failed: ${res.status} ${body.slice(0, 200)}`);
      }
      const result = (await res.json()) as Partial<DurableTurnOutput>;
      const out: DurableTurnOutput = {
        status: (result.status as DurableTurnOutput["status"]) ?? "ok",
        reason: result.reason,
        threadId: payload.threadId,
        // Carry the callback's assembled reply onto the run output so a
        // non-streaming caller (channel collectTurn) can read it off the
        // terminal run. Previously dropped — the run's output had no `text`,
        // so the only way to get the reply was to stream the thread room.
        text: typeof result.text === "string" ? result.text : undefined,
        messageId: result.messageId,
        costCents: result.costCents,
        durationMs: Date.now() - start,
      };
      metadata.set("status", out.status);
      if (out.messageId) metadata.set("messageId", out.messageId);
      logger.info("durable-turn: done", out as unknown as Record<string, unknown>);
      return out;
    } catch (err: any) {
      logger.error("durable-turn: errored", { error: err?.message ?? String(err) });
      metadata.set("status", "failed");
      return {
        status: "failed",
        reason: err?.message ?? String(err),
        threadId: payload.threadId,
        durationMs: Date.now() - start,
      };
    }
  },
});
