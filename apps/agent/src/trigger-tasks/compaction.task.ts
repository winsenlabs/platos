import { task, logger, metadata } from "@trigger.dev/sdk";
const env = process.env;

/**
 * LAUNCH-11 — durable conversation compaction.
 *
 * Replaces the fire-and-forget `compactIfNeeded(...)` Promise that was
 * spawned at the end of every turn in agent-task.service.ts. The old
 * shape didn't survive an agent restart and could pile up in-process
 * if many concurrent threads all crossed the compaction threshold at
 * once.
 *
 * This task is a thin wrapper — it calls back into the agent service's
 * `POST /api/v1/agent/internal/compaction` endpoint (admin-token gated)
 * which runs the existing `AgentTaskService.compactIfNeeded` logic.
 * Keeping the work in the agent process means the task doesn't need
 * direct DB / Prisma / scope plumbing in the worker sandbox.
 *
 * Concurrency cap of 5 stops a tenant flooding the worker. Idempotency
 * keys (passed by the caller, derived from `threadId + latestMessageId`)
 * prevent duplicate runs if the trigger fires twice for the same thread
 * state.
 */

export interface CompactionTaskPayload {
  threadId: string;
  scope: {
    organizationId: string;
    projectId: string;
    environmentId: string;
    userId: string;
    agentId?: string | null;
  };
  // C1 FIX — the dispatching turn already has the resolved agent config, so it
  // rides along in the payload and the callback uses it directly (instead of
  // hardcoding contextLimit/compactThreshold + a broken re-resolution). Kept
  // optional for back-compat with any in-flight runs enqueued pre-deploy.
  contextLimit?: number;
  compactThreshold?: number;
  historyMode?: string;
}

export interface CompactionTaskOutput {
  status: "ok" | "skipped" | "failed";
  reason?: string;
  threadId: string;
  messagesCompacted?: number;
  durationMs?: number;
}

export const platosCompaction = task({
  id: "platos.compaction",
  description:
    "LAUNCH-11 — runs conversation compaction (Haiku summarization of the oldest N - contextLimit messages) durably for a single thread. Replaces the in-process fire-and-forget Promise. Concurrency-bounded; idempotent on (threadId, latestMessageId).",
  queue: { concurrencyLimit: 5 },
  maxDuration: 120, // compaction is bounded by contextLimit; 2 min is generous
  run: async (payload: CompactionTaskPayload): Promise<CompactionTaskOutput> => {
    const start = Date.now();
    metadata.set("threadId", payload.threadId);
    metadata.set("scope.organizationId", payload.scope.organizationId);

    const AGENT_API_URL =
      env.PLATOS_AGENT_HTTP_URL ||
      env.PLATOS_AGENT_API_URL ||
      "http://localhost:3100";
    const adminToken = env.PLATOS_INTERNAL_AUTH_TOKEN;
    if (!adminToken) {
      logger.warn("compaction: PLATOS_INTERNAL_AUTH_TOKEN not set — skipping");
      return { status: "skipped", reason: "PLATOS_INTERNAL_AUTH_TOKEN unset", threadId: payload.threadId };
    }

    try {
      const res = await fetch(`${AGENT_API_URL}/api/v1/agent/internal/compaction`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-Platos-Internal-Auth": adminToken,
        },
        body: JSON.stringify(payload),
        signal: AbortSignal.timeout(110_000),
      });
      if (!res.ok) {
        const body = await res.text().catch(() => "");
        throw new Error(`compaction failed: ${res.status} ${body.slice(0, 200)}`);
      }
      const result = (await res.json()) as Partial<CompactionTaskOutput>;
      const out: CompactionTaskOutput = {
        status: (result.status as any) ?? "ok",
        reason: result.reason,
        threadId: payload.threadId,
        messagesCompacted: result.messagesCompacted,
        durationMs: Date.now() - start,
      };
      logger.info("compaction: done", out as any);
      metadata.set("status", out.status);
      if (out.messagesCompacted !== undefined) metadata.set("messagesCompacted", out.messagesCompacted);
      return out;
    } catch (err: any) {
      logger.error("compaction: errored", { error: err?.message ?? String(err) });
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
