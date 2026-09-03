import { moneyToCentsString } from "@platos/kernel";
import { describe, expect, it } from "vitest";

import { rateToDecimalString, type RateCardCatalogue } from "../domain/index.js";
import { entriesToIngest, ingestRateCard } from "./ingest-rate-card.js";
import { priceModelUsage, resolveModelPrice } from "./price-model-usage.js";
import { buildProvidersTestContext, type ProvidersTestContext } from "./testing/index.js";

const READ_AT = new Date("2026-08-01T00:00:00.000Z");
const LATER = new Date("2026-09-01T00:00:00.000Z");

const CATALOGUE: RateCardCatalogue = {
  "openai/gpt-4o": {
    input_cost_per_token: 2.5e-6,
    output_cost_per_token: 1e-5,
    cache_read_input_token_cost: 1.25e-6,
    cache_creation_input_token_cost: 3.125e-6,
    litellm_provider: "openai",
    mode: "chat",
    max_input_tokens: 128_000,
    max_output_tokens: "16384",
    supports_vision: true,
  },
  "anthropic/claude-haiku-4-5-20251001": {
    input_cost_per_token: 1e-6,
    output_cost_per_token: 5e-6,
    litellm_provider: "anthropic",
    mode: "chat",
  },
};

async function ingest(context: ProvidersTestContext, readAt = READ_AT, catalogue = CATALOGUE) {
  return ingestRateCard(context.dependencies, { catalogue, readAt });
}

describe("reading a catalogue", () => {
  // Three, not two: the two catalogue entries plus the synthesised entry for the
  // one shipped correction the catalogue does not list. See the group below.
  const INGESTED = 3;

  it("upserts a model per entry and appends one card each", async () => {
    const context = buildProvidersTestContext();
    const report = await ingest(context);
    if (!report.ok) throw new Error(`unreachable: ${report.error.code}`);
    expect(report.value.pricesAppended).toBe(INGESTED);
    expect(report.value.unchanged).toBe(0);
    expect(report.value.skipped).toEqual([]);
    expect(context.repository.allPrices()).toHaveLength(INGESTED);
  });

  it("coerces a count that arrived as a string and drops one it cannot read", async () => {
    const context = buildProvidersTestContext();
    await ingest(context);
    const model = await context.repository.findModelByKey("openai/gpt-4o" as never);
    if (!model.ok || model.value === null) throw new Error("unreachable");
    expect(model.value.maxOutputTokens).toBe(16_384);
    expect(model.value.contextWindow).toBe(128_000);
    expect(model.value.capabilities).toEqual(["mode:chat", "vision"]);
  });

  it("appends NOTHING on a second pass that changed no price fact", async () => {
    const context = buildProvidersTestContext();
    await ingest(context);
    const second = await ingest(context, LATER);
    if (!second.ok) throw new Error("unreachable");
    expect(second.value.pricesAppended).toBe(0);
    expect(second.value.unchanged).toBe(INGESTED);
    expect(context.repository.allPrices()).toHaveLength(INGESTED);
  });

  it("appends a new card when a rate actually moved", async () => {
    const context = buildProvidersTestContext();
    await ingest(context);
    const dearer: RateCardCatalogue = {
      ...CATALOGUE,
      "openai/gpt-4o": { ...CATALOGUE["openai/gpt-4o"], input_cost_per_token: 3e-6 },
    };
    const second = await ingest(context, LATER, dearer);
    if (!second.ok) throw new Error("unreachable");
    expect(second.value.pricesAppended).toBe(1);
    expect(context.repository.allPrices()).toHaveLength(INGESTED + 1);
  });

  it("skips one malformed entry and keeps reading the rest", async () => {
    const context = buildProvidersTestContext();
    const withBadKey: RateCardCatalogue = { ...CATALOGUE, " leading-space": { mode: "chat" } };
    const report = await ingest(context, READ_AT, withBadKey);
    if (!report.ok) throw new Error("unreachable");
    expect(report.value.skipped).toEqual([" leading-space"]);
    expect(report.value.pricesAppended).toBe(INGESTED);
  });

  it("refuses a document read at an invalid instant, before anything is written", async () => {
    const context = buildProvidersTestContext();
    const denied = await ingest(context, new Date("not-a-date"));
    expect(denied.ok).toBe(false);
    if (denied.ok) throw new Error("unreachable");
    expect(denied.error.code).toBe("PROVIDERS_RATE_CARD_INVALID");
    expect(context.repository.allPrices()).toEqual([]);
  });

  it("reads the whole pass inside ONE transaction", async () => {
    const context = buildProvidersTestContext();
    await ingest(context);
    expect(new Set(context.repository.transactions).size).toBe(1);
  });

  it("ignores an entry that is not an object, and a blank key", async () => {
    const context = buildProvidersTestContext();
    const junk = { "": { mode: "chat" }, nothing: null } as unknown as RateCardCatalogue;
    const entries = entriesToIngest(junk);
    expect(entries.map(([key]) => key)).not.toContain("");
    expect(entries.map(([key]) => key)).not.toContain("nothing");
  });
});

describe("a correction the catalogue never mentions", () => {
  it("is still applied, through a synthesised entry", async () => {
    const context = buildProvidersTestContext();
    const report = await ingest(context);
    if (!report.ok) throw new Error("unreachable");
    // Two catalogue entries plus the one uncovered correction.
    expect(report.value.modelsSeen).toBe(3);

    const price = await resolveModelPrice(context.dependencies, {
      model: "openai:gpt-5.6-luna",
      at: LATER,
    });
    if (!price.ok) throw new Error(`unreachable: ${price.error.code}`);
    expect(price.value.rates.input.source).toBe("VERIFIED_PROVIDER");
    expect(rateToDecimalString(price.value.rates.input.rate)).toBe("0.000000200000");
  });

  it("is NOT synthesised twice when the catalogue does list it", async () => {
    const context = buildProvidersTestContext();
    const listed: RateCardCatalogue = {
      ...CATALOGUE,
      "openai/gpt-5.6-luna": { input_cost_per_token: 1e-6, litellm_provider: "openai" },
    };
    const report = await ingest(context, READ_AT, listed);
    if (!report.ok) throw new Error("unreachable");
    expect(report.value.modelsSeen).toBe(3);
  });
});

describe("resolving a price", () => {
  it("finds a card through the catalogue's own naming", async () => {
    const context = buildProvidersTestContext();
    await ingest(context);
    const price = await resolveModelPrice(context.dependencies, {
      model: "openai:gpt-4o",
      at: LATER,
    });
    if (!price.ok) throw new Error(`unreachable: ${price.error.code}`);
    expect(price.value.modelKey).toBe("openai/gpt-4o");
    expect(price.value.provider).toBe("openai");
  });

  it("prices at the card in force THEN, not the newest one", async () => {
    const context = buildProvidersTestContext();
    await ingest(context);
    const dearer: RateCardCatalogue = {
      ...CATALOGUE,
      "openai/gpt-4o": { ...CATALOGUE["openai/gpt-4o"], input_cost_per_token: 3e-6 },
    };
    await ingest(context, LATER, dearer);

    const then = await resolveModelPrice(context.dependencies, {
      model: "openai:gpt-4o",
      at: new Date("2026-08-15T00:00:00.000Z"),
    });
    if (!then.ok) throw new Error("unreachable");
    expect(rateToDecimalString(then.value.rates.input.rate)).toBe("0.000002500000");

    const now = await resolveModelPrice(context.dependencies, {
      model: "openai:gpt-4o",
      at: new Date("2026-09-15T00:00:00.000Z"),
    });
    if (!now.ok) throw new Error("unreachable");
    expect(rateToDecimalString(now.value.rates.input.rate)).toBe("0.000003000000");
  });

  it("refuses a model nothing prices, rather than pricing it at zero", async () => {
    const context = buildProvidersTestContext();
    await ingest(context);
    const denied = await resolveModelPrice(context.dependencies, { model: "openai:unknown-model" });
    expect(denied.ok).toBe(false);
    if (denied.ok) throw new Error("unreachable");
    expect(denied.error.code).toBe("PROVIDERS_MODEL_PRICING_UNAVAILABLE");
  });

  it("refuses a blank model", async () => {
    const context = buildProvidersTestContext();
    expect((await resolveModelPrice(context.dependencies, { model: "   " })).ok).toBe(false);
  });

  it("defaults the instant to now, which is the clock and not the wall", async () => {
    const context = buildProvidersTestContext();
    await ingest(context, new Date("2025-01-01T00:00:00.000Z"));
    const price = await resolveModelPrice(context.dependencies, { model: "openai:gpt-4o" });
    expect(price.ok).toBe(true);
  });
});

describe("pricing a turn", () => {
  it("charges the fresh input, the output and both cache rates", async () => {
    const context = buildProvidersTestContext();
    await ingest(context);
    const priced = await priceModelUsage(context.dependencies, {
      model: "openai:gpt-4o",
      at: LATER,
      usage: {
        inputTokens: 1_000,
        outputTokens: 200,
        cacheReadInputTokens: 400,
        cacheWriteInputTokens: 100,
      },
    });
    if (!priced.ok) throw new Error(`unreachable: ${priced.error.code}`);
    expect(priced.value.charged).toEqual({
      input: 500,
      output: 200,
      cacheRead: 400,
      cacheWrite: 100,
    });
    // 500x2.5e-6 + 200x1e-5 + 400x1.25e-6 + 100x3.125e-6 = 0.00406250 USD
    expect(moneyToCentsString(priced.value.amount)).toBe("0.406250");
  });

  it("REFUSES a turn whose cache rates the catalogue never published", async () => {
    const context = buildProvidersTestContext();
    await ingest(context);
    const denied = await priceModelUsage(context.dependencies, {
      model: "anthropic:claude-haiku-4-5-20251001",
      at: LATER,
      usage: { inputTokens: 100, outputTokens: 10, cacheReadInputTokens: 40 },
    });
    expect(denied.ok).toBe(false);
    if (denied.ok) throw new Error("unreachable");
    expect(denied.error.code).toBe("PROVIDERS_MODEL_PRICING_UNAVAILABLE");
    expect(denied.error.details.rate).toBe("cacheRead");
  });

  it("prices the same turn fine when it used no cache at all", async () => {
    const context = buildProvidersTestContext();
    await ingest(context);
    const priced = await priceModelUsage(context.dependencies, {
      model: "anthropic:claude-haiku-4-5-20251001",
      at: LATER,
      usage: { inputTokens: 100, outputTokens: 10 },
    });
    if (!priced.ok) throw new Error("unreachable");
    expect(moneyToCentsString(priced.value.amount)).toBe("0.015000");
  });

  it("refuses a usage report whose cache counts exceed its input count", async () => {
    const context = buildProvidersTestContext();
    await ingest(context);
    const denied = await priceModelUsage(context.dependencies, {
      model: "openai:gpt-4o",
      at: LATER,
      usage: { inputTokens: 10, outputTokens: 1, cacheReadInputTokens: 20 },
    });
    expect(denied.ok).toBe(false);
    if (denied.ok) throw new Error("unreachable");
    expect(denied.error.code).toBe("PROVIDERS_TOKEN_USAGE_INVALID");
  });
});
