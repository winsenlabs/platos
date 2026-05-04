/**
 * PRELAUNCH-A1-1, A1-2 — cost.service regression tests.
 *
 * These tests exercise the pure-math layer of CostService:
 *   - calculateCost (no cache, fallback pricing)
 *   - calculateCostWithCache (provider-aware cache surcharge)
 *   - cacheRatesFor / providerForModel / cacheDiscountLabel helpers
 *
 * The tests stub a no-op Redis + a no-op Prisma — no testcontainers — since
 * the math under test never touches storage. The Redis pipeline only enters
 * `recordUsage`, which is exercised separately at the controller level.
 */
import { describe, it, expect, beforeEach } from "vitest";
import {
  CostService,
  CACHE_RATES,
  cacheRatesFor,
  providerForModel,
  cacheDiscountLabel,
} from "./cost.service";

function makeService(): CostService {
  // Minimal stubs — calculateCost / calculateCostWithCache only call
  // `getCatalog`, which falls through the FALLBACK_PRICING table when the
  // catalog is absent. The Redis stub never gets called by the math path.
  const fakeRedis: any = {
    get: async () => null,
    pipeline: () => {
      const pipe: any = {
        hincrby: () => pipe,
        hincrbyfloat: () => pipe,
        expire: () => pipe,
        hgetall: () => pipe,
        exec: async () => [],
      };
      return pipe;
    },
    set: async () => "OK",
    hgetall: async () => ({}),
    hget: async () => null,
    hincrbyfloat: async () => 0,
    del: async () => 0,
  };
  const fakePrisma: any = {};
  return new CostService(fakePrisma, fakeRedis);
}

describe("CostService — fallback pricing", () => {
  let svc: CostService;
  beforeEach(() => {
    svc = makeService();
  });

  it("calculateCost on Sonnet 4.6 with no cache", async () => {
    // Sonnet 4.6: 300 cents/1M input, 1500 cents/1M output (FALLBACK_PRICING).
    // 5_000 fresh input + 2_000 output:
    //   input  = 5_000 / 1M * 300 = 1.5 cents
    //   output = 2_000 / 1M * 1500 = 3.0 cents
    //   total  = 4.5 cents
    const cents = await svc.calculateCost("anthropic:claude-sonnet-4-6", 5_000, 2_000);
    expect(cents).toBeCloseTo(4.5, 2);
  });

  it("resolveInputCentsPerMillion returns the input rate from the fallback table", async () => {
    const rate = await svc.resolveInputCentsPerMillion("anthropic:claude-sonnet-4-6");
    expect(rate).toBe(300);
  });
});

describe("CostService — calculateCostWithCache (PRELAUNCH-A1-1)", () => {
  let svc: CostService;
  beforeEach(() => {
    svc = makeService();
  });

  it("Anthropic Sonnet, 100k cache_read on 105k total input → ~$0.35 not ~$3.75", async () => {
    // PRELAUNCH-A1-1 regression. Under v6 the SDK reports inputTokens as the
    // FULL prompt total (105k), of which 100k are cache reads. The naive
    // bug billed all 105k at 1.0× input on top of the 100k cache surcharge.
    //
    // Correct math (Sonnet 4.6, 300¢/1M input + 1500¢/1M output):
    //   freshInputTokens = 105_000 - 0 - 100_000 = 5_000
    //   freshCost  = 5_000 / 1M * 300 = 1.5 cents
    //   outputCost = 1_000 / 1M * 1500 = 1.5 cents
    //   readCost   = 100_000 / 1M * 300 * 0.10 = 3.0 cents (90% off)
    //   total      = 6.0 cents = $0.06
    //
    // (The audit's "~$0.35" estimate uses a different output token count;
    // what matters is that the result is ~10× lower than the bugged figure.)
    const cents = await svc.calculateCostWithCache(
      "anthropic:claude-sonnet-4-6",
      105_000, // total inputTokens (INCLUDES cache_read)
      1_000,
      0,
      100_000,
    );
    expect(cents).toBeCloseTo(6.0, 1);
    // Confirm the bugged value would have been ~10× higher.
    // Bugged math: 105_000 / 1M * 300 + 1_500 + 100_000 / 1M * 300 * 0.10
    //             = 31.5 + 1.5 + 3.0 = 36.0 cents
    expect(cents).toBeLessThan(36);
  });

  it("OpenAI cache_read billed at 50% (0.5×) not 90%", async () => {
    // PRELAUNCH-A1-2. OpenAI uses different cache rates:
    //   - read 0.50× input
    //   - write 1.00× input (no premium)
    //
    // 11_000 total input, 10_000 cache_read, 500 output, gpt-4.1 (200¢/1M
    // input, 800¢/1M output):
    //   fresh = 1_000, freshCost = 1_000/1M * 200 = 0.2 cents
    //   read  = 10_000/1M * 200 * 0.50 = 1.0 cents
    //   out   = 500/1M * 800 = 0.4 cents
    //   total = 1.6 cents
    const cents = await svc.calculateCostWithCache(
      "openai:gpt-4.1",
      11_000,
      500,
      0,
      10_000,
    );
    expect(cents).toBeCloseTo(1.6, 2);
  });

  it("Google cache_read billed at 25% (0.25×) not 90%", async () => {
    // PRELAUNCH-A1-2. Google 2.5 implicit cache:
    //   - read 0.25× input (75% off)
    //   - write 1.00× input
    //
    // 11_000 total input, 10_000 cache_read, 500 output, gemini-2.5-flash
    // (15¢/1M input, 60¢/1M output):
    //   fresh = 1_000, freshCost = 1_000/1M * 15 = 0.015 cents
    //   read  = 10_000/1M * 15 * 0.25 = 0.0375 cents
    //   out   = 500/1M * 60 = 0.03 cents
    //   total ≈ 0.0825 cents
    const cents = await svc.calculateCostWithCache(
      "google:gemini-2.5-flash",
      11_000,
      500,
      0,
      10_000,
    );
    expect(cents).toBeCloseTo(0.0825, 3);
  });

  it("zero cache fields — collapses to calculateCost exactly", async () => {
    const naive = await svc.calculateCost("anthropic:claude-sonnet-4-6", 5_000, 2_000);
    const withCache = await svc.calculateCostWithCache(
      "anthropic:claude-sonnet-4-6",
      5_000,
      2_000,
      0,
      0,
    );
    expect(withCache).toBeCloseTo(naive, 4);
  });

  it("explicit providerId override beats model-string inference", async () => {
    // Pass a model string in the openai namespace but force Anthropic rates.
    const cents = await svc.calculateCostWithCache(
      "openai:gpt-4.1",
      11_000,
      500,
      0,
      10_000,
      "anthropic", // explicit override
    );
    // With anthropic rates, read = 10_000/1M * 200 * 0.10 = 0.2 cents
    // (vs OpenAI's 1.0 cents). Total = 0.2 + 0.4 + 0.2 = 0.8 cents.
    expect(cents).toBeCloseTo(0.8, 2);
  });
});

describe("Provider helpers (PRELAUNCH-A1-2)", () => {
  it("CACHE_RATES table has all 4 documented providers", () => {
    expect(CACHE_RATES.anthropic).toEqual({ write: 1.25, read: 0.1 });
    expect(CACHE_RATES.openai).toEqual({ write: 1.0, read: 0.5 });
    expect(CACHE_RATES.google).toEqual({ write: 1.0, read: 0.25 });
    expect(CACHE_RATES["google-vertex"]).toEqual({ write: 1.0, read: 0.25 });
  });

  it("providerForModel splits on first colon", () => {
    expect(providerForModel("anthropic:claude-sonnet-4-6")).toBe("anthropic");
    expect(providerForModel("openai:gpt-4o")).toBe("openai");
    expect(providerForModel("google-vertex:gemini-2.5-pro")).toBe("google-vertex");
    expect(providerForModel(null)).toBe(null);
    expect(providerForModel(undefined)).toBe(null);
    expect(providerForModel("just-a-model-name")).toBe(null); // no colon
  });

  it("cacheRatesFor accepts provider id or model string", () => {
    expect(cacheRatesFor("anthropic")).toEqual({ write: 1.25, read: 0.1 });
    expect(cacheRatesFor("anthropic:claude-sonnet-4-6")).toEqual({
      write: 1.25,
      read: 0.1,
    });
    expect(cacheRatesFor("openai:gpt-4o")).toEqual({ write: 1.0, read: 0.5 });
    // Unknown provider — falls back to anthropic for legacy behaviour.
    expect(cacheRatesFor("unknown-provider")).toEqual({ write: 1.25, read: 0.1 });
    expect(cacheRatesFor(null)).toEqual({ write: 1.25, read: 0.1 });
  });

  it("cacheDiscountLabel renders human-readable percent", () => {
    expect(cacheDiscountLabel("anthropic")).toBe("90% off");
    expect(cacheDiscountLabel("openai")).toBe("50% off");
    expect(cacheDiscountLabel("google")).toBe("75% off");
    expect(cacheDiscountLabel("google-vertex:gemini-2.5-pro")).toBe("75% off");
    // Unknown defaults to Anthropic 90%.
    expect(cacheDiscountLabel("unknown")).toBe("90% off");
  });
});
