import { moneyToCentsString } from "@platos/kernel";
import { describe, expect, it } from "vitest";

import { priceUsageAgainst } from "./cost.js";
import type { RateBook, RateEntry } from "./price-card.js";
import { rateFromNumber } from "./rate.js";
import { tokenUsage } from "./token-usage.js";

const OBSERVED = new Date("2026-01-01T00:00:00.000Z");

function entry(usdPerToken: number): RateEntry {
  const rate = rateFromNumber(usdPerToken);
  if (!rate.ok) throw new Error("unreachable");
  return { rate: rate.value, source: "LITELLM", observedAt: OBSERVED, sourceRef: "catalogue" };
}

function book(overrides: Partial<RateBook> = {}): RateBook {
  return {
    input: entry(3e-6),
    output: entry(1.5e-5),
    cacheRead: entry(3e-7),
    cacheWrite: entry(3.75e-6),
    ...overrides,
  };
}

function usage(draft: Parameters<typeof tokenUsage>[0]) {
  const built = tokenUsage(draft);
  if (!built.ok) throw new Error("unreachable");
  return built.value;
}

type FourWay = { input: number; output: number; cacheRead: number; cacheWrite: number };

/** The float arithmetic the extraction source performs, for comparison. */
function sourceCostCents(rates: FourWay, tokens: FourWay): number {
  const cents =
    tokens.input * rates.input * 100 +
    tokens.output * rates.output * 100 +
    tokens.cacheRead * rates.cacheRead * 100 +
    tokens.cacheWrite * rates.cacheWrite * 100;
  return Math.round(cents * 1_000_000) / 1_000_000;
}

describe("pricing a usage report", () => {
  it("charges the fresh input tokens, not the whole prompt", () => {
    const priced = priceUsageAgainst(
      "anthropic:claude-haiku-4-5-20251001",
      book(),
      usage({
        inputTokens: 1_000,
        outputTokens: 100,
        cacheReadInputTokens: 400,
        cacheWriteInputTokens: 100,
      }),
    );
    if (!priced.ok) throw new Error("unreachable");
    expect(priced.value.charged).toEqual({
      input: 500,
      output: 100,
      cacheRead: 400,
      cacheWrite: 100,
    });
    // 500x3e-6 + 100x1.5e-5 + 400x3e-7 + 100x3.75e-6 = 0.003495 USD = 0.3495c
    expect(moneyToCentsString(priced.value.amount)).toBe("0.349500");
  });

  it("lands on the same micro-cent grid as the arithmetic it replaces", () => {
    const rates = { input: 3e-6, output: 1.5e-5, cacheRead: 3e-7, cacheWrite: 3.75e-6 };
    for (const tokens of [
      { input: 500, output: 100, cacheRead: 400, cacheWrite: 100 },
      { input: 1, output: 1, cacheRead: 0, cacheWrite: 0 },
      { input: 123_456, output: 7_890, cacheRead: 1_000, cacheWrite: 2_000 },
    ]) {
      const priced = priceUsageAgainst(
        "m",
        book(),
        usage({
          inputTokens: tokens.input + tokens.cacheRead + tokens.cacheWrite,
          outputTokens: tokens.output,
          cacheReadInputTokens: tokens.cacheRead,
          cacheWriteInputTokens: tokens.cacheWrite,
        }),
      );
      if (!priced.ok) throw new Error("unreachable");
      expect(Number(moneyToCentsString(priced.value.amount))).toBeCloseTo(
        sourceCostCents(rates, tokens),
        6,
      );
    }
  });

  it("rounds a true half UP where the float form it replaces rounds it down", () => {
    // Rates of about eleven cents per million tokens. The exact sum is
    // 537_925_000 pico-USD, i.e. 53792.5 micro-cents — dead on the half. The
    // float form's accumulated representation error lands it a hair below, so
    // `Math.round` sends it down; the exact form rounds the true half up.
    const rates = { input: 1.1e-7, output: 3.3e-7, cacheRead: 7e-9, cacheWrite: 1.3e-7 };
    const tokens = { input: 1_856, output: 797, cacheRead: 265, cacheWrite: 530 };
    const priced = priceUsageAgainst(
      "m",
      {
        input: entry(rates.input),
        output: entry(rates.output),
        cacheRead: entry(rates.cacheRead),
        cacheWrite: entry(rates.cacheWrite),
      },
      usage({
        inputTokens: tokens.input + tokens.cacheRead + tokens.cacheWrite,
        outputTokens: tokens.output,
        cacheReadInputTokens: tokens.cacheRead,
        cacheWriteInputTokens: tokens.cacheWrite,
      }),
    );
    if (!priced.ok) throw new Error("unreachable");
    expect(priced.value.amount.microCents).toBe(53_793n);
    expect(Math.round(sourceCostCents(rates, tokens) * 1_000_000)).toBe(53_792);
  });

  it("sums associatively — order of the four rates cannot change the answer", () => {
    const forward = priceUsageAgainst(
      "m",
      book(),
      usage({ inputTokens: 7, outputTokens: 11, cacheReadInputTokens: 3, cacheWriteInputTokens: 1 }),
    );
    const rearranged = priceUsageAgainst(
      "m",
      {
        cacheWrite: book().cacheWrite,
        cacheRead: book().cacheRead,
        output: book().output,
        input: book().input,
      },
      usage({ inputTokens: 7, outputTokens: 11, cacheReadInputTokens: 3, cacheWriteInputTokens: 1 }),
    );
    if (!forward.ok || !rearranged.ok) throw new Error("unreachable");
    expect(forward.value.amount.microCents).toBe(rearranged.value.amount.microCents);
  });

  it("prices a zero-token report at zero without touching the rates", () => {
    const priced = priceUsageAgainst("m", book(), usage({}));
    if (!priced.ok) throw new Error("unreachable");
    expect(priced.value.amount.microCents).toBe(0n);
  });
});

describe("an unknown rate is not a free rate", () => {
  const unavailable: RateEntry = {
    rate: { picoUsdPerToken: 0n },
    source: "UNAVAILABLE",
    observedAt: OBSERVED,
    sourceRef: null,
  };

  it("refuses to price tokens consumed at a rate nobody knows", () => {
    const denied = priceUsageAgainst(
      "openai:mystery",
      book({ output: unavailable }),
      usage({ inputTokens: 10, outputTokens: 5 }),
    );
    expect(denied.ok).toBe(false);
    if (denied.ok) throw new Error("unreachable");
    expect(denied.error.code).toBe("PROVIDERS_MODEL_PRICING_UNAVAILABLE");
    expect(denied.error.details.rate).toBe("output");
    expect(denied.error.details.model).toBe("openai:mystery");
  });

  it("allows an unknown rate that nothing was charged against", () => {
    const priced = priceUsageAgainst(
      "openai:mystery",
      book({ cacheWrite: unavailable }),
      usage({ inputTokens: 10, outputTokens: 5 }),
    );
    expect(priced.ok).toBe(true);
  });
});
