import { describe, expect, test } from "vitest";
import { ModelRateSource } from "../generated/control";
import {
  calculateCanonicalModelCost,
  ModelPricingUnavailableError,
  modelPricingLookupKeys,
  type CanonicalModelPriceSnapshot,
} from "./model-pricing";

const at = new Date("2026-07-31T00:00:00.000Z");
const price: CanonicalModelPriceSnapshot = {
  modelPriceId: "price-id",
  modelId: "model-id",
  modelKey: "gpt-5.6-luna",
  provider: "openai",
  modelName: "gpt-5.6-luna",
  effectiveFrom: at,
  input: {
    usdPerToken: 2e-7,
    source: ModelRateSource.VERIFIED_PROVIDER,
    observedAt: at,
    sourceRef: "https://developers.openai.com/api/docs/pricing",
  },
  output: {
    usdPerToken: 1.2e-6,
    source: ModelRateSource.VERIFIED_PROVIDER,
    observedAt: at,
    sourceRef: "https://developers.openai.com/api/docs/pricing",
  },
  cacheRead: {
    usdPerToken: 2e-8,
    source: ModelRateSource.VERIFIED_PROVIDER,
    observedAt: at,
    sourceRef: "https://developers.openai.com/api/docs/pricing",
  },
  cacheWrite: {
    usdPerToken: 5e-7,
    source: ModelRateSource.VERIFIED_PROVIDER,
    observedAt: at,
    sourceRef: "https://developers.openai.com/api/docs/pricing",
  },
};

describe("canonical model pricing math", () => {
  test("probes Platos and LiteLLM model key variants in deterministic order", () => {
    expect(modelPricingLookupKeys("together:openai/gpt-oss-120b")).toEqual([
      "together:openai/gpt-oss-120b",
      "together_ai/openai/gpt-oss-120b",
      "openai/gpt-oss-120b",
      "gpt-oss-120b",
    ]);
  });

  test("tries a provider-specific alias before the bare model alias", () => {
    expect(modelPricingLookupKeys("azure:gpt-4o-mini")).toEqual([
      "azure:gpt-4o-mini",
      "azure/gpt-4o-mini",
      "gpt-4o-mini",
    ]);
  });

  test("maps a bare Voyage default to the upstream Voyage key", () => {
    expect(modelPricingLookupKeys("voyage-large-2")).toEqual([
      "voyage-large-2",
      "voyage/voyage-large-2",
    ]);
  });

  test("tries the exact Together capitalization alias before bare fallbacks", () => {
    expect(
      modelPricingLookupKeys("together:meta-llama/Llama-3.1-8B-Instruct-Turbo"),
    ).toEqual([
      "together:meta-llama/Llama-3.1-8B-Instruct-Turbo",
      "together_ai/meta-llama/Llama-3.1-8B-Instruct-Turbo",
      "together_ai/meta-llama/Meta-Llama-3.1-8B-Instruct-Turbo",
      "meta-llama/Llama-3.1-8B-Instruct-Turbo",
      "Llama-3.1-8B-Instruct-Turbo",
    ]);
  });

  test("prices cache writes independently when they cost more than fresh input", () => {
    const fresh = calculateCanonicalModelCost("openai:gpt-5.6-luna", price, {
      inputTokens: 1_000_000,
      outputTokens: 0,
    });
    const cacheWrite = calculateCanonicalModelCost("openai:gpt-5.6-luna", price, {
      inputTokens: 1_000_000,
      outputTokens: 0,
      cacheWriteInputTokens: 1_000_000,
    });
    const cacheRead = calculateCanonicalModelCost("openai:gpt-5.6-luna", price, {
      inputTokens: 1_000_000,
      outputTokens: 0,
      cacheReadInputTokens: 1_000_000,
    });

    expect(fresh).toBe(20);
    expect(cacheWrite).toBe(50);
    expect(cacheRead).toBe(2);
  });

  test("fails visibly when a used rate is unavailable", () => {
    const unpricedCacheWrite = {
      ...price,
      cacheWrite: {
        usdPerToken: 0,
        source: ModelRateSource.UNAVAILABLE,
        observedAt: at,
        sourceRef: null,
      },
    };

    expect(() =>
      calculateCanonicalModelCost("openai:gpt-5.6-luna", unpricedCacheWrite, {
        inputTokens: 10,
        outputTokens: 0,
        cacheWriteInputTokens: 10,
      })
    ).toThrow(ModelPricingUnavailableError);
  });
});
