import { schedules, logger } from "@trigger.dev/sdk";
import { generateObject } from "ai";
import { createAnthropic } from "@ai-sdk/anthropic";
import { z } from "zod";
import {
  reconcileReadings,
  assessReading,
  catalogDiscrepancy,
  type PriceReading,
  type Verdict,
} from "../monitoring/price-verification";

/**
 * Daily price verification.
 *
 * The upstream LiteLLM catalog is the only practical source for ~3,000 models,
 * and it is wrong on individual rows in a way freshness cannot detect: measured
 * 2026-07-31, it had `gpt-5.6-sol` exactly right ($5.00/$0.50/$30.00) and
 * `gpt-5.6-luna` 5x high, same family, same fetch. Billing off it unchecked
 * produced a 4.2x overcharge on live traffic.
 *
 * So this task re-reads the PROVIDER's own pricing page for the models we
 * actually use — a handful, not 3,000 — and reconciles.
 *
 * Design notes, both of which are deliberate:
 *
 *  - SELF-CONTAINED. It does not call back into the agent service. The sibling
 *    `litellm-cost-refresh` task does, resolving the target as
 *    `... || "http://localhost:3100"`, and since it runs on Trigger Cloud that
 *    localhost is the Trigger worker. The write never landed and the catalog sat
 *    empty for months. This task publishes through Redis directly so it has no
 *    such hidden dependency.
 *
 *  - FAIL CLOSED. Two independent reads must agree, ratios must be plausible,
 *    and a >2x move is held rather than applied. Anything held keeps the
 *    previous value and is surfaced. See price-verification.ts — the policy is
 *    unit-tested there, away from the network and the model.
 *
 * Human-verified entries in `verified-prices.ts` are NOT overwritten by this
 * task. They carry a verbatim provider quote and a verification date; a model
 * reading a web page does not outrank that. For those models the task's job is
 * to detect drift and say so.
 */

const LITELLM_URL =
  "https://raw.githubusercontent.com/BerriAI/litellm/main/model_prices_and_context_window.json";

/** Where the provider publishes standard-tier prices, per provider id. */
const PRICING_PAGES: Record<string, string> = {
  openai: "https://developers.openai.com/api/docs/pricing",
  anthropic: "https://www.anthropic.com/pricing",
  google: "https://ai.google.dev/gemini-api/docs/pricing",
  "google-vertex": "https://cloud.google.com/vertex-ai/generative-ai/pricing",
  together: "https://www.together.ai/pricing",
};

/** Redis key the cost service merges on top of the catalog. */
export const VERIFIED_OVERLAY_KEY = "cost:verified_prices";

const ReadingSchema = z.object({
  found: z.boolean().describe("true only if this exact model appears in the page's pricing table"),
  inputPerMillionUsd: z.number().nullable().describe("Standard-tier input price per 1M tokens, USD"),
  outputPerMillionUsd: z.number().nullable().describe("Standard-tier output price per 1M tokens, USD"),
  cachedInputPerMillionUsd: z
    .number()
    .nullable()
    .describe("Standard-tier CACHED INPUT (cache read) price per 1M tokens, USD"),
  cacheWritePerMillionUsd: z
    .number()
    .nullable()
    .describe("Standard-tier CACHE WRITE price per 1M tokens, USD, if listed separately"),
});

const perMillionToPerToken = (v: number | null | undefined): number | undefined =>
  v === null || v === undefined ? undefined : v / 1_000_000;

/**
 * Read one model's row off a pricing page. Deliberately narrow: it is told to
 * report `found: false` rather than approximate, because a confident wrong
 * number is the failure mode we are guarding against.
 */
async function readPrice(
  model: string,
  pageUrl: string,
  pageText: string,
  seed: number,
): Promise<PriceReading | null> {
  const anthropic = createAnthropic({ apiKey: process.env.ANTHROPIC_API_KEY ?? "" });
  const { object } = await generateObject({
    model: anthropic("claude-sonnet-5"),
    schema: ReadingSchema,
    // Two reads differ only in how the task is framed, so agreement is weak
    // evidence of stability rather than of having asked the same question twice.
    prompt: [
      seed === 0
        ? `From the pricing page below, find the row for the model named EXACTLY "${model}".`
        : `The page below is a pricing table. Locate "${model}" and report only its own row.`,
      "",
      "Rules:",
      "- STANDARD tier only. Ignore Batch, Flex, Priority, and long-context surcharge rows.",
      "- Prices are per 1,000,000 tokens in USD.",
      "- If the exact model is absent, set found=false and all prices null. Do NOT",
      "  substitute a similarly-named model and do NOT estimate.",
      "- If a field is not listed, use null rather than guessing.",
      "",
      `Source: ${pageUrl}`,
      "--- PAGE ---",
      pageText.slice(0, 120_000),
    ].join("\n"),
  });
  if (!object.found) return null;
  const reading: PriceReading = {
    input: perMillionToPerToken(object.inputPerMillionUsd),
    output: perMillionToPerToken(object.outputPerMillionUsd),
    cacheRead: perMillionToPerToken(object.cachedInputPerMillionUsd),
    cacheWrite: perMillionToPerToken(object.cacheWritePerMillionUsd),
  };
  return Object.values(reading).some((v) => v !== undefined) ? reading : null;
}

const bareModel = (m: string) => (m.includes(":") ? m.slice(m.indexOf(":") + 1) : m);
const providerOf = (m: string) => (m.includes(":") ? m.slice(0, m.indexOf(":")) : "anthropic");

export const priceVerify = schedules.task({
  id: "price-verify",
  description:
    "Re-reads provider pricing pages for in-use models and reconciles against the upstream catalog. Fail-closed.",
  // 06:11 UTC — after litellm-cost-refresh at 05:23, so it verifies fresh data.
  cron: "11 6 * * *",
  run: async (payload: { models?: string[] } & Record<string, unknown>) => {
    // The model list is supplied by the caller (or a manual run). Keeping it an
    // input rather than a DB query is what makes this task self-contained.
    const models: string[] = Array.isArray(payload?.models) && payload.models.length
      ? payload.models
      : [];
    if (models.length === 0) {
      logger.warn("price-verify: no models supplied; nothing to verify");
      return { verified: 0, held: 0, skipped: 0, verdicts: [] as Verdict[] };
    }

    let catalog: Record<string, any> = {};
    try {
      const res = await fetch(LITELLM_URL, { signal: AbortSignal.timeout(20_000) });
      if (res.ok) catalog = (await res.json()) as Record<string, any>;
    } catch (err: any) {
      logger.warn("price-verify: catalog fetch failed; continuing without it", {
        error: String(err?.message ?? err),
      });
    }

    const verdicts: Verdict[] = [];
    const overlay: Record<string, PriceReading> = {};

    for (const model of models) {
      const provider = providerOf(model);
      const bare = bareModel(model);
      const pageUrl = PRICING_PAGES[provider];
      if (!pageUrl) {
        verdicts.push({
          model,
          status: "no-reading",
          reason: `no pricing page configured for provider "${provider}"`,
        });
        continue;
      }

      let pageText = "";
      try {
        const res = await fetch(pageUrl, { signal: AbortSignal.timeout(25_000) });
        pageText = await res.text();
      } catch (err: any) {
        verdicts.push({
          model,
          status: "no-reading",
          reason: `pricing page unreachable: ${String(err?.message ?? err)}`,
        });
        continue;
      }

      const catalogRow = catalog[bare] ?? catalog[model];
      const catalogReading: PriceReading | undefined = catalogRow
        ? {
            input: catalogRow.input_cost_per_token,
            output: catalogRow.output_cost_per_token,
            cacheRead: catalogRow.cache_read_input_token_cost,
            cacheWrite: catalogRow.cache_creation_input_token_cost,
          }
        : undefined;

      let verdict: Verdict;
      try {
        const [a, b] = await Promise.all([
          readPrice(bare, pageUrl, pageText, 0),
          readPrice(bare, pageUrl, pageText, 1),
        ]);
        const { agreed, disagreements } = reconcileReadings(a, b);
        verdict = assessReading(model, agreed, catalogReading, catalogReading, disagreements);
      } catch (err: any) {
        verdict = {
          model,
          status: "no-reading",
          reason: `extraction failed: ${String(err?.message ?? err)}`,
          catalog: catalogReading,
        };
      }

      // Surface where the catalog disagrees with what the provider publishes.
      // This is the signal that would have caught gpt-5.6-luna on day one.
      if (verdict.proposed) {
        const gaps = catalogDiscrepancy(verdict.proposed, catalogReading);
        if (gaps.length > 0) {
          logger.warn("price-verify: CATALOG DISAGREES WITH PROVIDER", {
            model,
            gaps: gaps.map((g) => `${g.field}: catalog ${g.factor.toFixed(2)}x the provider figure`),
          });
        }
      }

      if (verdict.status === "accepted" && verdict.proposed) {
        overlay[bare] = verdict.proposed;
      }
      if (verdict.status === "held") {
        logger.warn("price-verify: HELD for review", { model, reason: verdict.reason });
      }
      verdicts.push(verdict);
    }

    // Publish only what passed every guardrail. Held and unreadable rows keep
    // whatever was already in force.
    if (Object.keys(overlay).length > 0) {
      try {
        const { Redis } = await import("ioredis");
        const redis = new Redis(process.env.REDIS_URL ?? "redis://localhost:6379");
        await redis.set(VERIFIED_OVERLAY_KEY, JSON.stringify(overlay), "EX", 7 * 86_400);
        await redis.quit();
        logger.info("price-verify: published overlay", { models: Object.keys(overlay) });
      } catch (err: any) {
        logger.error("price-verify: overlay publish failed", {
          error: String(err?.message ?? err),
        });
      }
    }

    const counts = {
      verified: verdicts.filter((v) => v.status === "accepted").length,
      unchanged: verdicts.filter((v) => v.status === "unchanged").length,
      held: verdicts.filter((v) => v.status === "held").length,
      skipped: verdicts.filter((v) => v.status === "no-reading").length,
    };
    logger.info("price-verify: done", counts);
    return { ...counts, verdicts };
  },
});
