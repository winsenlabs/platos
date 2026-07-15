import { schedules, logger, metadata } from "@trigger.dev/sdk";
const env = process.env;

/**
 * Daily refresh of the LiteLLM model-price catalog.
 *
 * Source: https://github.com/BerriAI/litellm/blob/main/model_prices_and_context_window.json
 * Redis key: `cost:model_catalog` — 24h soft TTL, kept indefinitely on fetch fail.
 * Consumer: `CostService.calculateCost` (see PLAT-35 / Theme B.10).
 *
 * Failure policy: we never hard-fail the price catalog. When the upstream
 * fetch errors, we keep the previous cached entry and emit a warning
 * metric so operators can see stale-ness in the monitoring dashboard.
 */

const LITELLM_URL =
  "https://raw.githubusercontent.com/BerriAI/litellm/main/model_prices_and_context_window.json";

export interface LiteLLMModelEntry {
  max_tokens?: number;
  max_input_tokens?: number;
  max_output_tokens?: number;
  input_cost_per_token?: number;
  output_cost_per_token?: number;
  cache_read_input_token_cost?: number;
  cache_creation_input_token_cost?: number;
  litellm_provider?: string;
  mode?: string;
}

export type LiteLLMCatalog = Record<string, LiteLLMModelEntry>;

/**
 * PPR-52 — fetch the LiteLLM catalog with up-to-3 attempts using exponential
 * backoff + jitter. Transient 5xx / rate-limits / flaky networks should not
 * silently leave the catalog stale on a Monday-morning DNS hiccup.
 */
async function fetchLiteLLMCatalog(): Promise<LiteLLMCatalog> {
  const MAX_ATTEMPTS = 3;
  let lastError: string | null = null;
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    try {
      const res = await fetch(LITELLM_URL, { signal: AbortSignal.timeout(20000) });
      if (!res.ok) {
        lastError = `HTTP ${res.status}`;
      } else {
        const raw = (await res.json()) as LiteLLMCatalog;
        if (!raw || typeof raw !== "object") {
          lastError = "Response is not a JSON object";
        } else {
          return raw;
        }
      }
    } catch (err: any) {
      lastError = err?.message || "fetch failed";
    }
    if (attempt < MAX_ATTEMPTS) {
      // Exponential backoff with jitter: 500ms, 1500ms (± 250ms).
      const base = 500 * Math.pow(2, attempt - 1);
      const jitter = Math.floor(Math.random() * 500) - 250;
      const wait = Math.max(100, base + jitter);
      logger.warn("litellm-cost-refresh: fetch attempt failed, retrying", {
        attempt,
        waitMs: wait,
        error: lastError,
      });
      await new Promise((r) => setTimeout(r, wait));
    }
  }
  throw new Error(lastError || "fetch failed after retries");
}

export const litellmCostRefresh = schedules.task({
  id: "platos.cost.refresh_model_prices",
  description: "Refreshes the LiteLLM model-price catalog into Redis once per day.",
  cron: "23 5 * * *", // daily at 05:23 UTC
  maxDuration: 120,
  // EOBD.45 — singleton.
  queue: { concurrencyLimit: 1 },
  run: async () => {
    logger.info("litellm-cost-refresh: fetching", { url: LITELLM_URL });

    // PPR-52 — assert admin token is present before we fetch. No point
    // downloading ~1 MB of JSON if we can't push it to the agent. Previously
    // we would silently 403 on push and the operator only noticed via a
    // stale-catalog dashboard alert.
    const adminToken = env.PLATOS_ADMIN_TOKEN;
    if (!adminToken) {
      const error = "PLATOS_ADMIN_TOKEN not set — refuse to refresh (would 403 on push)";
      logger.error("litellm-cost-refresh: missing admin token");
      metadata.set("status", "misconfigured");
      metadata.set("error", error);
      throw new Error(error);
    }

    let catalog: LiteLLMCatalog | null = null;
    let fetchError: string | null = null;

    try {
      catalog = await fetchLiteLLMCatalog();
    } catch (err: any) {
      fetchError = err?.message || "fetch failed";
    }

    if (!catalog) {
      logger.warn("litellm-cost-refresh: using stale catalog", { error: fetchError });
      metadata.set("status", "stale");
      metadata.set("error", fetchError);
      return { status: "stale", error: fetchError };
    }

    // Write to Redis via a raw HTTP call to the agent service's admin endpoint.
    // This task runs inside trigger.dev's worker process, which doesn't have
    // direct access to the agent's ioredis client. The agent exposes an
    // admin shim at POST /api/v1/agent/monitoring/cost/catalog that accepts
    // the catalog payload and stores it with a 24h TTL.
    const AGENT_API_URL =
      env.PLATOS_AGENT_HTTP_URL || env.PLATOS_AGENT_API_URL || "http://localhost:3100";

    try {
      const res = await fetch(`${AGENT_API_URL}/api/v1/agent/monitoring/cost/catalog`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-Platos-Admin-Token": adminToken,
        },
        body: JSON.stringify({ catalog }),
        signal: AbortSignal.timeout(15000),
      });
      // PPR-52 — any non-2xx is an error. Previously we only checked `res.ok`
      // against the boolean but let stale body reads through; make the
      // failure path explicit so the task actually throws + trigger.dev's
      // retry policy can kick in.
      if (!res.ok || res.status < 200 || res.status >= 300) {
        const body = await res.text().catch(() => "");
        throw new Error(`agent accept failed: ${res.status} ${body.slice(0, 200)}`);
      }
    } catch (err: any) {
      logger.error("litellm-cost-refresh: agent push failed", { error: err?.message });
      metadata.set("status", "push_failed");
      metadata.set("error", err?.message);
      // PPR-52 — throw so trigger.dev surfaces the failure and the
      // scheduled-task dashboard shows red instead of green-stale.
      throw err;
    }

    const modelCount = Object.keys(catalog).length;
    logger.info("litellm-cost-refresh: stored", { modelCount });
    metadata.set("status", "ok");
    metadata.set("modelCount", modelCount);
    return { status: "ok", modelCount };
  },
});
