import { schedules, logger, metadata } from "@platos/sdk/v3";
import { env } from "../shared/env";

/**
 * Theme O.1 / M.5 — scheduled memory-extraction sweep.
 *
 * Every hour, hits the agent service's admin endpoint
 * `POST /api/v1/memory/admin/extraction-sweep` which:
 *   1. Acquires a Redis SET-NX lock (`lock:memory-extraction-cron`,
 *      5-min TTL) so overlapping cron ticks exit early.
 *   2. Scans `PlatosAgentThread` for threads updated in the last
 *      90 minutes with `turnCount >= 2` (at least one user + one
 *      assistant turn), capped at 500 per run.
 *   3. Invokes `MemoryExtractionService.extractFromThread` for each
 *      thread. Per-thread errors are caught + counted, never aborting
 *      the sweep. Dedup lives in the extractor itself via the EOBD.46
 *      contentHash uniqueness — a double-fire produces zero extra rows.
 *   4. Returns aggregated counts — the task records them as metadata
 *      (a single cron-run event for operator visibility, not per-thread
 *      spam).
 *
 * Per-thread extraction policy (disabled / confidence threshold /
 * max-per-session) is resolved inside the extractor from the agent row's
 * `extractionPolicy` JSON column. When the policy is disabled the
 * extractor returns fast with `reason: "extraction-disabled"`, so we
 * never spam the judge LLM.
 *
 * Gated by `PLATOS_ADMIN_TOKEN`. Manual kicks still go through
 * `POST /api/v1/memory/extract` with a `threadId` payload.
 */
export const memoryExtraction = schedules.task({
  id: "platos.memory.extract",
  description:
    "Hourly sweep — picks threads with recent activity (updated in the last 90 minutes, turnCount >= 2) and runs Theme O memory extraction. Redis-lock singleton; 500-thread rate limit per run.",
  cron: "0 * * * *",
  maxDuration: 900,
  // EOBD.45 — singleton. Double-fire would waste LLM calls even though
  // the extractor itself is contentHash-deduped. Belt+braces: trigger
  // concurrency cap here, plus the Redis SET-NX lock server-side so a
  // split-brain worker pair (e.g. mid-deploy) still can't overlap.
  queue: { concurrencyLimit: 1 },
  run: async () => {
    const AGENT_API_URL =
      env.PLATOS_AGENT_HTTP_URL ||
      env.PLATOS_AGENT_API_URL ||
      "http://localhost:3100";
    const adminToken = env.PLATOS_ADMIN_TOKEN;
    if (!adminToken) {
      logger.warn("memory-extraction: PLATOS_ADMIN_TOKEN not set — skipping");
      metadata.set("status", "skipped");
      return { status: "skipped", reason: "PLATOS_ADMIN_TOKEN unset" };
    }

    try {
      const res = await fetch(
        `${AGENT_API_URL}/api/v1/memory/admin/extraction-sweep`,
        {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "X-Platos-Admin-Token": adminToken,
          },
          // No body; the admin endpoint discovers threads itself via Prisma.
          body: JSON.stringify({}),
          // Let the server-side 500-thread cap + per-thread budgets bound
          // the work. 15-minute timeout matches maxDuration.
          signal: AbortSignal.timeout(900_000),
        },
      );
      if (!res.ok) {
        const body = await res.text().catch(() => "");
        throw new Error(
          `extraction sweep failed: ${res.status} ${body.slice(0, 200)}`,
        );
      }
      const result = (await res.json()) as {
        status?: string;
        reason?: string;
        threadsScanned?: number;
        threadsExtracted?: number;
        memoriesCreated?: number;
        entitiesCreated?: number;
        relationshipsCreated?: number;
        skipped?: number;
        errors?: number;
        durationMs?: number;
      };
      logger.info("memory-extraction: done", result);
      metadata.set("status", result.status ?? "ok");
      if (result.reason) metadata.set("reason", result.reason);
      metadata.set("threadsScanned", result.threadsScanned ?? 0);
      metadata.set("threadsExtracted", result.threadsExtracted ?? 0);
      metadata.set("memoriesCreated", result.memoriesCreated ?? 0);
      metadata.set("entitiesCreated", result.entitiesCreated ?? 0);
      metadata.set("relationshipsCreated", result.relationshipsCreated ?? 0);
      metadata.set("skipped", result.skipped ?? 0);
      metadata.set("errors", result.errors ?? 0);
      metadata.set("durationMs", result.durationMs ?? 0);
      return result;
    } catch (err: any) {
      logger.error("memory-extraction: failed", { error: err?.message });
      metadata.set("status", "error");
      metadata.set("error", err?.message);
      return { status: "error", error: err?.message };
    }
  },
});
