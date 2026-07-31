import { describe, it, expect } from "vitest";
import { CostService } from "./cost.service";
import {
  VERIFIED_PRICES,
  verifiedPriceFor,
  applyVerifiedPrice,
} from "./verified-prices";

/**
 * PRECISION — per-model cache rates + verified provider overrides.
 *
 * Two bugs are pinned here, both measured against provider pricing pages on
 * 2026-07-31:
 *
 *  1. Cache rates were applied as a per-PROVIDER multiplier
 *     (`CACHE_RATES.openai = { read: 0.5, write: 1.0 }`) even though the catalog
 *     already carried per-model figures. Real gpt-5.6-luna is read 0.1x and
 *     write 2.5x — writes cost MORE than fresh input, the opposite of the
 *     assumption. The two errors compound rather than cancel on a cache-heavy
 *     turn.
 *  2. The upstream catalog is wrong on individual rows: LiteLLM has
 *     gpt-5.6-luna 5x high while having its sibling gpt-5.6-sol exactly right.
 */

/** Build a CostService with an injected catalog (via the Redis stub). */
function svcWithCatalog(catalog: Record<string, unknown> | null) {
  const redis: any = {
    get: async (k: string) =>
      k === "cost:model_catalog" && catalog ? JSON.stringify(catalog) : null,
    set: async () => "OK",
    hincrby: async () => 1,
    hincrbyfloat: async () => 1,
    hget: async () => null,
    hgetall: async () => ({}),
    expire: async () => 1,
    pipeline: () => ({
      hincrby() { return this; },
      hincrbyfloat() { return this; },
      expire() { return this; },
      hset() { return this; },
      exec: async () => [],
    }),
  };
  return new CostService({} as any, redis);
}

describe("verified price table", () => {
  it("every entry cites a provider source and a verification date", () => {
    // The table is only trustworthy if each row can be re-checked. An entry
    // without provenance is indistinguishable from a guess.
    for (const e of VERIFIED_PRICES) {
      expect(e.source).toMatch(/^https?:\/\//);
      expect(e.verifiedOn).toMatch(/^\d{4}-\d{2}-\d{2}$/);
      expect(e.providerQuote.length).toBeGreaterThan(10);
    }
  });

  it("holds the measured gpt-5.6-luna figures", () => {
    const luna = verifiedPriceFor(["gpt-5.6-luna"]);
    expect(luna).not.toBeNull();
    expect(luna!.input).toBe(2e-7); // $0.20 / 1M
    expect(luna!.cacheRead).toBe(2e-8); // $0.02 / 1M — 0.1x input
    expect(luna!.cacheWrite).toBe(5e-7); // $0.50 / 1M — 2.5x input
    expect(luna!.output).toBe(1.2e-6); // $1.20 / 1M
  });

  it("cache WRITE costs more than fresh input on this model", () => {
    // Guards the counter-intuitive fact. CACHE_RATES assumed write == 1.0x
    // input; if someone 'corrects' this row toward that assumption, this fails.
    const luna = verifiedPriceFor(["gpt-5.6-luna"])!;
    expect(luna.cacheWrite!).toBeGreaterThan(luna.input!);
    expect(luna.cacheWrite! / luna.input!).toBeCloseTo(2.5, 5);
    expect(luna.cacheRead! / luna.input!).toBeCloseTo(0.1, 5);
  });

  it("matches on any lookup-key variant", () => {
    expect(verifiedPriceFor(["openai:gpt-5.6-luna", "gpt-5.6-luna"])).not.toBeNull();
    expect(verifiedPriceFor(["nope", "also-nope"])).toBeNull();
  });

  it("merges field-level and never blanks an unverified field", () => {
    const merged = applyVerifiedPrice(
      { input_cost_per_token: 1e-6, output_cost_per_token: 6e-6, max_tokens: 400_000 } as any,
      verifiedPriceFor(["gpt-5.6-luna"]),
    ) as any;
    expect(merged.input_cost_per_token).toBe(2e-7); // overridden
    expect(merged.cache_read_input_token_cost).toBe(2e-8); // added
    expect(merged.max_tokens).toBe(400_000); // untouched
  });

  it("is a no-op when there is no verified entry", () => {
    const entry = { input_cost_per_token: 5e-6 } as any;
    expect(applyVerifiedPrice(entry, null)).toBe(entry);
  });
});

describe("per-model cache rates beat the per-provider multiplier", () => {
  it("uses the catalog's own cache_read price instead of CACHE_RATES", async () => {
    // gpt-4.1: input $2.00/1M, cached input $0.50/1M → 0.25x.
    // CACHE_RATES.openai says 0.5x, which would give 1.6 cents.
    const svc = svcWithCatalog({
      "gpt-4.1": {
        input_cost_per_token: 2e-6,
        output_cost_per_token: 8e-6,
        cache_read_input_token_cost: 5e-7,
      },
    });
    const cents = await svc.calculateCostWithCache("openai:gpt-4.1", 11_000, 500, 0, 10_000);
    //   fresh 1_000/1M * 200c = 0.2
    //   read 10_000/1M * 50c  = 0.5   (was 1.0 under the 0.5x multiplier)
    //   out    500/1M * 800c  = 0.4
    expect(cents).toBeCloseTo(1.1, 3);
  });

  it("falls back to the multiplier when the catalog omits cache prices", async () => {
    // Behaviour for the long tail must not change — the multiplier is still
    // the answer when nothing better is known.
    const svc = svcWithCatalog({
      "some-oss-model": { input_cost_per_token: 2e-6, output_cost_per_token: 8e-6 },
    });
    const cents = await svc.calculateCostWithCache("openai:some-oss-model", 11_000, 500, 0, 10_000);
    expect(cents).toBeCloseTo(1.6, 3); // 0.5x multiplier path
  });

  /**
   * THE REGRESSION, using the real turn observed on test.platos:
   * in=67,647 (inclusive) / read=49,362 / write=18,267 / fresh=18.
   */
  it("prices the observed gpt-5.6-luna turn correctly", async () => {
    // No catalog at all — the verified table alone must carry it, since
    // LiteLLM's row for this model is 5x wrong and we do not want it used.
    const svc = svcWithCatalog(null);
    const cents = await svc.calculateCostWithCache(
      "openai:gpt-5.6-luna",
      67_647,
      0, // output measured separately; isolate the input side
      18_267,
      49_362,
    );
    //   fresh     18/1M * 20c = 0.00036
    //   write 18_267/1M * 50c = 0.91335
    //   read  49_362/1M *  2c = 0.09872
    expect(cents).toBeCloseTo(1.0124, 2);
  });

  it("quantifies what the old path would have charged for that turn", async () => {
    // Same turn under the conservative estimator ($1.00/1M) + 0.5x/1.0x
    // multipliers — i.e. what Platos actually billed before this change.
    const OLD_INPUT_CENTS_PER_M = 100;
    const old =
      (18 / 1e6) * OLD_INPUT_CENTS_PER_M +
      (18_267 / 1e6) * OLD_INPUT_CENTS_PER_M * 1.0 +
      (49_362 / 1e6) * OLD_INPUT_CENTS_PER_M * 0.5;
    expect(old).toBeCloseTo(4.2966, 3);

    const svc = svcWithCatalog(null);
    const now = await svc.calculateCostWithCache(
      "openai:gpt-5.6-luna", 67_647, 0, 18_267, 49_362,
    );
    // 4.24x overstated before this fix.
    expect(old / now).toBeGreaterThan(4);
    expect(old / now).toBeLessThan(4.5);
  });
});
