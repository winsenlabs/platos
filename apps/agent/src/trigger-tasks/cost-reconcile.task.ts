import { schedules, logger, metadata } from "@trigger.dev/sdk";
import { env } from "../shared/env";

/**
 * PPR-24 — nightly Redis ↔ Postgres cost reconcile.
 *
 * Pings the agent's admin endpoint
 * `POST /api/v1/agent/monitoring/cost/reconcile` which invokes
 * `CostService.reconcileFromPostgres()`. That method rebuilds the
 * `cost:scope:<scope>:<day>` and `cost:agent:<scope>:<agentId>:<day>`
 * Redis hashes from `PlatosAgentMessage.responseJson.cost_cents` for the
 * last ~2 days so Redis eviction / restart / pipeline drops don't drift
 * the dashboard away from the authoritative Postgres total.
 *
 * Design mirror of the LiteLLM cost-refresh + attachments-retention
 * tasks: scheduled inside trigger.dev's worker, talks HTTP to the agent
 * admin endpoint (same `X-Platos-Admin-Token` gate).
 *
 * Failure policy: never hard-fail. A missed night still reconciles on
 * the next run because Postgres is durable; a failed reconcile only
 * means the Redis view may be briefly out of sync.
 */

export const costReconcile = schedules.task({
  id: "platos.cost.reconcile",
  description:
    "Nightly Redis<->Postgres cost hash reconcile. Postgres is authoritative; Redis is the live dashboard mirror.",
  cron: "47 4 * * *", // daily at 04:47 UTC (off-peak, distinct from other schedules)
  maxDuration: 300,
  // EOBD.45 — singleton. Two trigger.dev workers ticking the same
  // cron minute would otherwise both fire this. Harmless here
  // (idempotent) but we set concurrencyLimit:1 uniformly across
  // every scheduled task so the rule is easy to remember.
  queue: { concurrencyLimit: 1 },
  run: async () => {
    const AGENT_API_URL =
      env.PLATOS_AGENT_HTTP_URL ||
      env.PLATOS_AGENT_API_URL ||
      "http://localhost:3100";
    const adminToken = env.PLATOS_ADMIN_TOKEN;

    if (!adminToken) {
      logger.warn("cost-reconcile: PLATOS_ADMIN_TOKEN not set — skipping");
      metadata.set("status", "skipped");
      return { status: "skipped", reason: "PLATOS_ADMIN_TOKEN unset" };
    }

    try {
      const res = await fetch(
        `${AGENT_API_URL}/api/v1/agent/monitoring/cost/reconcile`,
        {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "X-Platos-Admin-Token": adminToken,
          },
          // 2-day smoothing covers yesterday's tail.
          body: JSON.stringify({ daysBack: 2 }),
          signal: AbortSignal.timeout(120000),
        },
      );
      if (!res.ok) {
        const body = await res.text().catch(() => "");
        throw new Error(
          `cost reconcile failed: ${res.status} ${body.slice(0, 200)}`,
        );
      }
      const result = (await res.json()) as {
        daysReconciled?: number;
        scopesReconciled?: number;
        agentsReconciled?: number;
      };
      logger.info("cost-reconcile: done", result);
      metadata.set("status", "ok");
      metadata.set("daysReconciled", result.daysReconciled ?? 0);
      metadata.set("scopesReconciled", result.scopesReconciled ?? 0);
      metadata.set("agentsReconciled", result.agentsReconciled ?? 0);
      return { status: "ok", ...result };
    } catch (err: any) {
      logger.error("cost-reconcile: failed", { error: err?.message });
      metadata.set("status", "error");
      metadata.set("error", err?.message);
      return { status: "error", error: err?.message };
    }
  },
});
