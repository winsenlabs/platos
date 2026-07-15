import { schedules, logger, metadata } from "@trigger.dev/sdk";
const env = process.env;

/**
 * EOBD.100 — ClickHouse DLQ drain.
 *
 * SpansService (and CostService, when wired) pushes failed CH inserts
 * onto `platos:dlq:spans` / `platos:dlq:cost` Redis lists. This task
 * periodically drains them by POSTing to the agent's admin retry
 * endpoint, which re-attempts the ClickHouse write. Successful retries
 * leave the list empty; permanent failures (after N attempts) are
 * moved to `platos:dlq:spans:dead` for manual review.
 *
 * Runs every 2 min. Fast cron keeps drain latency low so telemetry
 * recovers quickly after a CH hiccup.
 */

export const observabilityDlqDrain = schedules.task({
  id: "platos.observability.dlq_drain",
  description:
    "Drain the ClickHouse dual-write DLQ (Redis list). Retries failed span + cost inserts so transient CH outages don't lose telemetry.",
  cron: "0 * * * *",
  maxDuration: 90,
  // EOBD.45 — singleton. Two drainers racing would double-fire retries.
  queue: { concurrencyLimit: 1 },
  run: async () => {
    const AGENT_API_URL =
      env.PLATOS_AGENT_HTTP_URL ||
      env.PLATOS_AGENT_API_URL ||
      "http://localhost:3100";
    const adminToken = env.PLATOS_ADMIN_TOKEN;

    if (!adminToken) {
      logger.warn("observability-dlq-drain: PLATOS_ADMIN_TOKEN not set — skipping");
      metadata.set("status", "skipped");
      return { status: "skipped", reason: "PLATOS_ADMIN_TOKEN unset" };
    }

    try {
      const res = await fetch(
        `${AGENT_API_URL}/api/v1/agent/monitoring/dlq/drain`,
        {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "X-Platos-Admin-Token": adminToken,
          },
          body: JSON.stringify({ maxBatch: 500 }),
          signal: AbortSignal.timeout(60_000),
        },
      );
      if (!res.ok) {
        const body = await res.text().catch(() => "");
        throw new Error(`dlq drain failed: ${res.status} ${body.slice(0, 200)}`);
      }
      const json = (await res.json()) as {
        drained?: { spans?: number; cost?: number };
        deadLettered?: { spans?: number; cost?: number };
      };
      metadata.set("status", "ok");
      metadata.set("drained", json.drained ?? {});
      metadata.set("deadLettered", json.deadLettered ?? {});
      return { status: "ok", ...json };
    } catch (err: any) {
      logger.error("observability-dlq-drain: agent call failed", {
        error: err?.message,
      });
      metadata.set("status", "failed");
      metadata.set("error", err?.message);
      throw err;
    }
  },
});
