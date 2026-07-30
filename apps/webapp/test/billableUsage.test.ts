import { describe, expect, it } from "vitest";
import { toBillableUsage } from "~/v3/utils/enrichCreatableEvents.server";

/**
 * BILLING — cached tokens were charged twice in the OTLP cost-enrichment path.
 *
 * `gen_ai.usage.input_tokens` is the AI SDK's `usage.inputTokens`, which is
 * INCLUSIVE of the cache slice. `LlmPricingRegistry.calculateCost` sums usage
 * types additively, so the cache slice was billed once at the full input rate
 * (inside `input`) and again at the cached rate.
 */

/** Stand-in for a price tier: input 1.0x, cache-read 0.1x, cache-write 1.25x. */
const price = (u: Record<string, number>) =>
  (u["input"] ?? 0) * 1.0 +
  (u["input_cached_tokens"] ?? 0) * 0.1 +
  (u["cache_creation_input_tokens"] ?? 0) * 1.25;

describe("toBillableUsage", () => {
  it("strips the cache slice out of input", () => {
    const raw = { input: 1000, output: 50, input_cached_tokens: 800 };
    expect(toBillableUsage(raw)).toEqual({
      input: 200,
      output: 50,
      input_cached_tokens: 800,
    });
  });

  it("strips BOTH read and write slices", () => {
    const raw = {
      input: 1000,
      output: 50,
      input_cached_tokens: 600,
      cache_creation_input_tokens: 300,
    };
    expect(toBillableUsage(raw).input).toBe(100);
  });

  it("does not mutate its input", () => {
    const raw = { input: 1000, input_cached_tokens: 800 };
    const snapshot = JSON.stringify(raw);
    toBillableUsage(raw);
    expect(JSON.stringify(raw)).toBe(snapshot);
  });

  it("is a no-op when there is no cache slice (Anthropic-exclusive shape, or no caching)", () => {
    const raw = { input: 1000, output: 50 };
    expect(toBillableUsage(raw)).toEqual(raw);
  });

  it("drops `input` entirely when the whole prefix was cached", () => {
    // A fully-cached step: every input token came from cache.
    const out = toBillableUsage({ input: 800, output: 20, input_cached_tokens: 800 });
    expect(out.input).toBeUndefined();
    expect(out.input_cached_tokens).toBe(800);
  });

  it("clamps at zero rather than going negative", () => {
    // Malformed provider data — a cache slice larger than the input count. A
    // negative token count would become a negative cost and credit the account.
    const out = toBillableUsage({ input: 100, input_cached_tokens: 500 });
    expect(out.input).toBeUndefined();
    expect(Object.values(out).every((v) => v >= 0)).toBe(true);
  });

  it("leaves output and reasoning tokens alone", () => {
    const out = toBillableUsage({
      input: 1000,
      output: 200,
      reasoning_tokens: 90,
      total: 1200,
      input_cached_tokens: 900,
    });
    expect(out.output).toBe(200);
    expect(out.reasoning_tokens).toBe(90);
    expect(out.total).toBe(1200);
  });
});

describe("the overcharge this fixes, quantified", () => {
  it("was billing the cached slice twice", () => {
    // Shape of a well-cached step: 20k context, 18k of it read from cache.
    const raw = { input: 20_000, output: 500, input_cached_tokens: 18_000 };

    const wrong = price(raw); // 20000 + 1800  = 21,800
    const right = price(toBillableUsage(raw)); //  2000 + 1800  =  3,800

    expect(wrong).toBeCloseTo(21_800, 5);
    expect(right).toBeCloseTo(3_800, 5);
    // 5.7x overstated — and the error GROWS as caching improves, so the
    // prompt-caching work would have made reported cost progressively wronger.
    expect(wrong / right).toBeGreaterThan(5);
  });

  it("scaled to the real evidence trace", () => {
    // From the production trace that motivated this branch.
    const raw = {
      input: 1_684_498,
      output: 20_000,
      input_cached_tokens: 198_224,
      cache_creation_input_tokens: 12_389,
    };
    const billable = toBillableUsage(raw);
    // Fresh tokens are the reported input MINUS the cache slice.
    expect(billable.input).toBe(1_684_498 - 198_224 - 12_389);
    expect(billable.input).toBe(1_473_885);
    // The double-billed amount is the whole cache slice at the full input rate.
    const overcharged = price(raw) - price(billable);
    expect(overcharged).toBeCloseTo(198_224 + 12_389, 5);
  });
});
