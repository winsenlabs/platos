import { task, logger, metadata } from "@trigger.dev/sdk";
import { env } from "../shared/env";

/**
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
  scope: {
    organizationId: string;
    projectId: string;
    environmentId: string;
    userId: string;
    agentId?: string;
    threadId?: string;
  };
}

export interface DurableTurnOutput {
  status: "ok" | "skipped" | "failed";
  reason?: string;
  threadId: string;
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
      env.PLATOS_AGENT_HTTP_URL || env.PLATOS_AGENT_API_URL || "http://localhost:3100";
    const adminToken = env.PLATOS_ADMIN_TOKEN;
    if (!adminToken) {
      logger.warn("durable-turn: PLATOS_ADMIN_TOKEN not set — skipping");
      return { status: "skipped", reason: "PLATOS_ADMIN_TOKEN unset", threadId: payload.threadId };
    }

    try {
      const res = await fetch(`${AGENT_API_URL}/api/v1/agent/internal/durable-turn`, {
        method: "POST",
        headers: { "Content-Type": "application/json", "X-Platos-Admin-Token": adminToken },
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
