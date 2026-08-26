import { schedules, logger, metadata } from "@trigger.dev/sdk";
const env = process.env;

/**
 * Theme J.4 — scheduled judge-LLM eval sampler.
 *
 * Every 15 minutes, picks a small random sample of threads (per active
 * agent × active criterion) and fires their `POST /api/v1/agent/evals/dispatch`
 * endpoint. Keeping this off the hot request path means the judge LLM call
 * latency + cost is absorbed durably by trigger.dev, not a user session.
 *
 * Gated by `PLATOS_INTERNAL_AUTH_TOKEN` on the agent side (eventually) — v1 keeps
 * this conservative by sampling at most 5 pairs per tick so a misconfigured
 * criterion can't run up the bill before it's caught.
 *
 * MVP note: this task only kicks per-scope evaluation requests when the
 * agent exposes an admin sampling endpoint. The current `runJudge` method
 * is scope-gated via ScopeGuard; wiring a cross-scope sampler here is
 * deferred to Theme H (budget caps) so we don't accidentally run the judge
 * against every conversation in every env.
 */
export const evalSample = schedules.task({
  id: "platos.eval.sample",
  description:
    "Periodic judge-LLM sampler — picks recent threads + runs active criteria. Conservative default sample size.",
  cron: "40 * * * *",
  maxDuration: 300,
  // EOBD.45 — singleton. Two workers ticking would double-charge the
  // judge-LLM budget for no new signal.
  queue: { concurrencyLimit: 1 },
  run: async () => {
    const AGENT_API_URL =
      env.PLATOS_AGENT_HTTP_URL ||
      env.PLATOS_AGENT_API_URL ||
      "http://localhost:3100";
    const adminToken = env.PLATOS_INTERNAL_AUTH_TOKEN;

    if (!adminToken) {
      logger.warn("eval-sample: PLATOS_INTERNAL_AUTH_TOKEN not set — skipping");
      metadata.set("status", "skipped");
      return { status: "skipped", reason: "PLATOS_INTERNAL_AUTH_TOKEN unset" };
    }

    // The cross-scope sampling endpoint isn't wired yet — Theme H will add
    // a `POST /api/v1/agent/evals/sample` admin endpoint that enumerates
    // active (scope, agent, criterion) tuples, fans out `runJudge` calls,
    // and applies per-scope budget caps. Until then, this task is a no-op
    // placeholder that lets ops see the cron is registered.
    logger.info("eval-sample: placeholder — cross-scope sampler lands with Theme H budget caps");
    metadata.set("status", "placeholder");
    return { status: "placeholder" };
  },
});
