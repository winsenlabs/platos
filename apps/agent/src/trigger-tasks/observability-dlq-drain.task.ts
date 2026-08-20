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
 *
 * WHY EVERY FIVE MINUTES, AND WHY A BIG BATCH.
 *
 * Delivery throughput is (rows per call) × (calls per hour), and it has to
 * exceed the rate turns are produced or the queue only ever grows. Hourly at 500
 * rows was 500 projections an hour: a deployment completing more than about
 * eight turns a minute accumulated a PENDING backlog it could never work off,
 * with a healthy ClickHouse, and `prune` only deletes DELIVERED rows so the
 * table grew without bound. The drain now loops internally until the queue is
 * empty or its budget is spent, and this schedule sets that budget.
 */

export const observabilityDlqDrain = schedules.task({
  id: "platos.observability.dlq_drain",
  description:
    "Drain the analytical delivery queues: the durable ObservabilityOutbox (turn-shaped projection) and the Redis span/cost DLQ, so an outage delays telemetry instead of losing it.",
  cron: "*/5 * * * *",
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
          // The agent clamps this at 5,000 and loops internally; the drain's
          // own deadline stops the pass well inside the timeout below.
          body: JSON.stringify({ maxBatch: 5_000 }),
          signal: AbortSignal.timeout(60_000),
        },
      );
      if (!res.ok) {
        const body = await res.text().catch(() => "");
        throw new Error(`dlq drain failed: ${res.status} ${body.slice(0, 200)}`);
      }
      const json = (await res.json()) as {
        status?: string;
        drained?: { spans?: number; cost?: number };
        deadLettered?: { spans?: number; cost?: number };
        observability?: {
          claimed?: number;
          delivered?: number;
          retried?: number;
          parked?: number;
          pruned?: number;
          discarded?: number;
          passes?: number;
          queue?: { pending?: number; failed?: number };
          skipped?: string;
          failure?: string;
        };
      };
      const observability = json.observability;
      metadata.set("drained", json.drained ?? {});
      metadata.set("deadLettered", json.deadLettered ?? {});
      metadata.set("observability", observability ?? {});

      // A drain that THREW is not a state the runtime is designed for. It used
      // to arrive in the same `skipped` field as "no sink configured" and got
      // the same warn, so a pass failing every hour looked exactly like a
      // deployment that has no ClickHouse.
      if (observability?.failure) {
        metadata.set("status", "failed");
        logger.error("observability-dlq-drain: outbox drain failed", {
          reason: observability.failure,
          queue: observability.queue,
        });
        throw new Error(`observability drain failed: ${observability.failure}`);
      }
      metadata.set("status", "ok");

      // A parked row is an undelivered projection for a Turn that already
      // happened. It is the one outcome here that is not self-healing, so it
      // gets a log line of its own rather than living inside a metadata blob —
      // and it is reported from the QUEUE DEPTH, not from what this pass
      // happened to park. A row parked at 09:00 used to be announced once,
      // after which every pass reported zero for it forever.
      const parked = observability?.queue?.failed ?? observability?.parked ?? 0;
      if (parked > 0) {
        logger.error("observability-dlq-drain: outbox rows parked undelivered", {
          parked,
          parkedThisPass: observability?.parked ?? 0,
          hint: "SELECT id, turnId, attempts, lastErrorCode FROM \"ObservabilityOutbox\" WHERE status = 'FAILED'",
        });
      }
      // A backlog the drain could not finish means delivery is losing to turn
      // volume — the one condition raising the schedule or the batch fixes.
      const pending = observability?.queue?.pending ?? 0;
      if (pending > 0) {
        logger.warn("observability-dlq-drain: projections still queued after the pass", {
          pending,
          delivered: observability?.delivered ?? 0,
          passes: observability?.passes ?? 0,
        });
      }
      // Not an error: an absent or unreachable sink is a state the runtime is
      // designed for. It is still worth saying which one, every pass.
      if (observability?.skipped) {
        logger.warn("observability-dlq-drain: outbox drain skipped", {
          reason: observability.skipped,
        });
      }
      return { status: json.status ?? "ok", ...json };
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
