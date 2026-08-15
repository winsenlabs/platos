import { schedules, logger, metadata } from "@trigger.dev/sdk";
const env = process.env;

/**
 * PPR-67 — scheduled approvals expiry sweep.
 *
 * Every 5 minutes, ping the agent's admin endpoint
 * `POST /api/v1/agent/monitoring/approvals/expiry-sweep` which invokes
 * `MonitoringApprovalsService.sweepExpiredAllScopes()`. The service
 * enumerates distinct scopes with pending approvals and flips any row
 * whose `createdAt + timeoutSeconds` deadline has passed from `pending`
 * to `timed_out`.
 *
 * Why the indirection? This task runs inside trigger.dev's worker
 * process — it doesn't share a NestJS DI container with the agent, and
 * it doesn't have a Prisma client configured. The admin endpoint owns
 * the scope + DB access.
 *
 * Failure policy: never hard-fail. If the agent is momentarily down the
 * next run picks up what was missed because `createdAt` + `timeoutSeconds`
 * are durable; a missed sweep just delays the dashboard flip by ≤5 minutes.
 *
 * Mirrors the same admin-token dance + timeout pattern as the LiteLLM
 * catalog refresh + attachment retention tasks.
 */

export const approvalsExpirySweep = schedules.task({
  id: "platos.approvals.expiry_sweep",
  description:
    "Every 5 minutes, flip stuck-pending PlatosAgentApproval rows whose timeout has elapsed to 'timed_out'.",
  cron: "20 * * * *",
  maxDuration: 60,
  // EOBD.45 — singleton. Two sweepers racing to flip the same row
  // is idempotent but wastes the admin endpoint budget.
  queue: { concurrencyLimit: 1 },
  run: async () => {
    const AGENT_API_URL =
      env.PLATOS_AGENT_HTTP_URL ||
      env.PLATOS_AGENT_API_URL ||
      "http://localhost:3100";
    const adminToken = env.PLATOS_INTERNAL_AUTH_TOKEN;

    if (!adminToken) {
      logger.warn("approvals-expiry-sweep: PLATOS_INTERNAL_AUTH_TOKEN not set — skipping");
      metadata.set("status", "skipped");
      return { status: "skipped", reason: "PLATOS_INTERNAL_AUTH_TOKEN unset" };
    }

    try {
      const res = await fetch(
        `${AGENT_API_URL}/api/v1/agent/monitoring/approvals/expiry-sweep`,
        {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "X-Platos-Internal-Auth": adminToken,
          },
          body: JSON.stringify({}),
          signal: AbortSignal.timeout(30000),
        },
      );
      if (!res.ok) {
        const body = await res.text().catch(() => "");
        throw new Error(
          `approvals expiry sweep failed: ${res.status} ${body.slice(0, 200)}`,
        );
      }
      const result = (await res.json()) as {
        scopesScanned?: number;
        totalExpired?: number;
      };
      logger.info("approvals-expiry-sweep: swept", result);
      metadata.set("status", "ok");
      metadata.set("scopesScanned", result.scopesScanned ?? 0);
      metadata.set("totalExpired", result.totalExpired ?? 0);
      return { status: "ok", ...result };
    } catch (err: any) {
      logger.error("approvals-expiry-sweep: failed", { error: err?.message });
      metadata.set("status", "error");
      metadata.set("error", err?.message);
      return { status: "error", error: err?.message };
    }
  },
});
