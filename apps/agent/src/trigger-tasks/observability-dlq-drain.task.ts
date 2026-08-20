import { schedules, logger, metadata } from "@trigger.dev/sdk";
const env = process.env;

/**
 * EOBD.100 / WIN-133 — analytical delivery drain.
 *
 * TWO QUEUES, DELIBERATELY REPORTED APART.
 *
 * The legacy one is Redis: SpansService (and CostService, when wired) pushes
 * failed span inserts onto `platos:dlq:spans` / `platos:dlq:cost`. It is a
 * best-effort hold-queue that drops its oldest entries under pressure, and
 * permanent failures move to `platos:dlq:spans:dead` for manual review.
 *
 * The turn-shaped one is Postgres: `ObservabilityOutbox`, written in the same
 * transaction that finalizes a Turn. It never drops a row. What it cannot
 * deliver it PARKS, and `observability.parked` is a number someone has to
 * explain. Folding the two into one counter would let a bounded loss hide
 * inside an unbounded guarantee, so the payload keeps them separate.
 *
 * Both are drained by one POST to the agent's admin endpoint.
 */

export const observabilityDlqDrain = schedules.task({
  id: "platos.observability.dlq_drain",
  description:
    "Drain the analytical delivery queues: the durable ObservabilityOutbox (turn-shaped projection) and the Redis span/cost DLQ, so an outage delays telemetry instead of losing it.",
  cron: "0 * * * *",
  maxDuration: 90,
  // EOBD.45 — singleton. Two drainers racing would double-fire retries.
  queue: { concurrencyLimit: 1 },
  run: async () => {
    const AGENT_API_URL =
      env.PLATOS_AGENT_HTTP_URL ||
      env.PLATOS_AGENT_API_URL ||
      "http://localhost:3100";
    const adminToken = env.PLATOS_INTERNAL_AUTH_TOKEN;

    if (!adminToken) {
      logger.warn("observability-dlq-drain: PLATOS_INTERNAL_AUTH_TOKEN not set — skipping");
      metadata.set("status", "skipped");
      return { status: "skipped", reason: "PLATOS_INTERNAL_AUTH_TOKEN unset" };
    }

    try {
      const res = await fetch(
        `${AGENT_API_URL}/api/v1/agent/monitoring/dlq/drain`,
        {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "X-Platos-Internal-Auth": adminToken,
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
        observability?: {
          claimed?: number;
          delivered?: number;
          retried?: number;
          parked?: number;
          pruned?: number;
          skipped?: string;
        };
      };
      metadata.set("status", "ok");
      metadata.set("drained", json.drained ?? {});
      metadata.set("deadLettered", json.deadLettered ?? {});
      metadata.set("observability", json.observability ?? {});

      // A parked row is an undelivered projection for a Turn that already
      // happened. It is the one outcome here that is not self-healing, so it
      // gets a log line of its own rather than living inside a metadata blob.
      const parked = json.observability?.parked ?? 0;
      if (parked > 0) {
        logger.error("observability-dlq-drain: outbox rows parked undelivered", {
          parked,
          hint: "SELECT id, turnId, attempts, lastErrorCode FROM \"ObservabilityOutbox\" WHERE status = 'FAILED'",
        });
      }
      // Not an error: an absent or unreachable sink is a state the runtime is
      // designed for. It is still worth saying which one, every pass.
      if (json.observability?.skipped) {
        logger.warn("observability-dlq-drain: outbox drain skipped", {
          reason: json.observability.skipped,
        });
      }
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
