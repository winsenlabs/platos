import { schedules, logger, metadata } from "@trigger.dev/sdk";
import { assertCredibleLiteLLMCatalog } from "../monitoring/litellm-catalog-validation";
const env = process.env;

/**
 * Daily refresh of the LiteLLM model-price catalog.
 *
 * Source: https://github.com/BerriAI/litellm/blob/main/model_prices_and_context_window.json
 * The agent callback persists append-only ModelPrice rows in the Platos
 * control database. This Trigger Cloud task remains an HTTP-only boundary.
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

export class LiteLLMCatalogValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "LiteLLMCatalogValidationError";
  }
}

type CatalogIngestionResponse = {
  status?: string;
  modelsSeen?: number;
  pricesCreated?: number;
  unchanged?: number;
};

export async function pushLiteLLMCatalog(
  agentApiUrl: string,
  adminToken: string,
  catalog: LiteLLMCatalog,
  fetchedAt: Date = new Date(),
  fetchImpl: typeof fetch = fetch,
): Promise<CatalogIngestionResponse & { status: "ok" }> {
  assertCredibleLiteLLMCatalog(catalog);
  const res = await fetchImpl(`${agentApiUrl}/api/v1/agent/monitoring/cost/catalog`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-Platos-Internal-Auth": adminToken,
    },
    body: JSON.stringify({ catalog, fetchedAt: fetchedAt.toISOString() }),
    // Canonical ingestion processes the complete catalog transactionally
    // and may take up to two minutes on a cold database.
    signal: AbortSignal.timeout(180_000),
  });
  const body = (await res.json().catch(() => null)) as CatalogIngestionResponse | null;
  if (!res.ok || res.status < 200 || res.status >= 300) {
    throw new Error(`agent accept failed: HTTP ${res.status}`);
  }
  if (!body || body.status !== "ok") {
    throw new Error(`agent accept failed: unexpected status ${body?.status ?? "invalid_body"}`);
  }
  return body as CatalogIngestionResponse & { status: "ok" };
}

/**
 * PPR-52 — fetch the LiteLLM catalog with up to three passes using exponential
 * backoff + jitter. Transient 5xx / rate-limits / flaky networks should not
 * silently leave the catalog stale on a Monday-morning DNS hiccup.
 */
export async function fetchLiteLLMCatalog(
  fetchImpl: typeof fetch = fetch,
  sleep: (milliseconds: number) => Promise<void> = (milliseconds) =>
    new Promise((resolve) => setTimeout(resolve, milliseconds)),
): Promise<LiteLLMCatalog> {
  const MAX_PASSES = 3;
  let lastError: string | null = null;
  let catalogValidationFailed = false;
  for (let passNumber = 1; passNumber <= MAX_PASSES; passNumber++) {
    try {
      const res = await fetchImpl(LITELLM_URL, { signal: AbortSignal.timeout(20000) });
      if (!res.ok) {
        lastError = `HTTP ${res.status}`;
      } else {
        const raw = (await res.json()) as LiteLLMCatalog;
        try {
          assertCredibleLiteLLMCatalog(raw);
          return raw;
        } catch (error: any) {
          lastError = error?.message ?? "invalid LiteLLM catalog";
          catalogValidationFailed = true;
        }
      }
    } catch (err: any) {
      lastError = err?.message || "fetch failed";
    }
    if (passNumber < MAX_PASSES) {
      // Exponential backoff with jitter: 500ms, 1500ms (± 250ms).
      const base = 500 * Math.pow(2, passNumber - 1);
      const jitter = Math.floor(Math.random() * 500) - 250;
      const wait = Math.max(100, base + jitter);
      logger.warn("litellm-cost-refresh: fetch failed, retrying", {
        retryNumber: passNumber,
        waitMs: wait,
        error: lastError,
      });
      await sleep(wait);
    }
  }
  if (catalogValidationFailed) {
    throw new LiteLLMCatalogValidationError(lastError || "invalid LiteLLM catalog");
  }
  throw new Error(lastError || "fetch failed after retries");
}

export const litellmCostRefresh = schedules.task({
  id: "platos.cost.refresh_model_prices",
  description: "Refreshes canonical Platos model prices from LiteLLM once per day.",
  cron: "23 5 * * *", // daily at 05:23 UTC
  maxDuration: 300,
  // EOBD.45 — singleton.
  queue: { concurrencyLimit: 1 },
  run: async () => {
    logger.info("litellm-cost-refresh: fetching", { url: LITELLM_URL });

    // PPR-52 — assert admin token is present before we fetch. No point
    // downloading ~1 MB of JSON if we can't push it to the agent. Previously
    // we would silently 403 on push and the operator only noticed via a
    // stale-catalog dashboard alert.
    const adminToken = env.PLATOS_INTERNAL_AUTH_TOKEN;
    if (!adminToken) {
      const error = "PLATOS_INTERNAL_AUTH_TOKEN not set — refuse to refresh (would 403 on push)";
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
      if (err instanceof LiteLLMCatalogValidationError) {
        metadata.set("status", "invalid_catalog");
        metadata.set("error", err.message);
        throw err;
      }
      fetchError = err?.message || "fetch failed";
    }

    if (!catalog) {
      logger.warn("litellm-cost-refresh: using stale catalog", { error: fetchError });
      metadata.set("status", "stale");
      metadata.set("error", fetchError);
      return { status: "stale", error: fetchError };
    }

    // Push through the authenticated HTTP callback. Trigger Cloud must not
    // import Prisma or connect directly to the Platos control database.
    const AGENT_API_URL =
      env.PLATOS_AGENT_HTTP_URL || env.PLATOS_AGENT_API_URL || "http://localhost:3100";

    try {
      await pushLiteLLMCatalog(AGENT_API_URL, adminToken, catalog);
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
