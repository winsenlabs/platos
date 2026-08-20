import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("~/env.server", () => ({
  env: {
    LLM_COST_TRACKING_ENABLED: false,
    LLM_PRICING_RELOAD_INTERVAL_MS: 60_000,
    LLM_PRICING_READY_TIMEOUT_MS: 0,
  },
}));
vi.mock("~/services/platosControlDatabase.server", () => ({
  platosControlDatabase: { modelPrice: { findMany: vi.fn() } },
}));
vi.mock("~/services/signals.server", () => ({
  signalsEmitter: { on: vi.fn() },
}));

import { ModelRateSource, Prisma } from "@platos/tenancy-database";
import {
  CanonicalLlmPricingRegistry,
  type CurrentPrice,
} from "~/v3/llmPricingRegistry.server";

const observedAt = new Date("2026-08-20T05:23:00.000Z");

function currentPrice(input: {
  id: string;
  key: string;
  provider: string;
  inputRate: number;
  outputRate: number;
  cacheReadRate?: number;
  cacheWriteRate?: number;
  cacheReadSource?: ModelRateSource;
  cacheWriteSource?: ModelRateSource;
}): CurrentPrice {
  return {
    id: input.id,
    modelId: `model-${input.id}`,
    effectiveFrom: observedAt,
    model: { key: input.key, name: input.key, provider: input.provider },
    inputRate: new Prisma.Decimal(input.inputRate),
    outputRate: new Prisma.Decimal(input.outputRate),
    cacheReadRate: new Prisma.Decimal(input.cacheReadRate ?? 0),
    cacheWriteRate: new Prisma.Decimal(input.cacheWriteRate ?? 0),
    inputSource: ModelRateSource.LITELLM,
    outputSource: ModelRateSource.LITELLM,
    cacheReadSource: input.cacheReadSource ?? ModelRateSource.LITELLM,
    cacheWriteSource: input.cacheWriteSource ?? ModelRateSource.LITELLM,
    inputObservedAt: observedAt,
    outputObservedAt: observedAt,
    cacheReadObservedAt: observedAt,
    cacheWriteObservedAt: observedAt,
    inputSourceRef: "https://example.test/catalog",
    outputSourceRef: "https://example.test/catalog",
    cacheReadSourceRef:
      (input.cacheReadSource ?? ModelRateSource.LITELLM) === ModelRateSource.UNAVAILABLE
        ? null
        : "https://example.test/catalog",
    cacheWriteSourceRef:
      (input.cacheWriteSource ?? ModelRateSource.LITELLM) === ModelRateSource.UNAVAILABLE
        ? null
        : "https://example.test/catalog",
  };
}

describe("CanonicalLlmPricingRegistry", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("keeps an empty initial load unready and retries promptly until populated", async () => {
    vi.useFakeTimers();
    const price = currentPrice({
      id: "retry",
      key: "gpt-4o-mini",
      provider: "openai",
      inputRate: 1e-6,
      outputRate: 2e-6,
    });
    const loader = vi.fn().mockResolvedValueOnce([]).mockResolvedValueOnce([price]);
    const registry = new CanonicalLlmPricingRegistry(loader, 25);
    const ready = vi.fn();
    void registry.isReady.then(ready);

    await registry.reload();
    expect(registry.isLoaded).toBe(false);
    expect(registry.match("openai:gpt-4o-mini")).toBeNull();
    expect(ready).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(25);
    expect(loader).toHaveBeenCalledTimes(2);
    expect(registry.isLoaded).toBe(true);
    expect(registry.match("openai:gpt-4o-mini")?.id).toBe("retry");
    expect(ready).toHaveBeenCalledOnce();
    registry.dispose();
  });

  it("preserves the last non-empty catalog when a later reload is empty", async () => {
    vi.useFakeTimers();
    const price = currentPrice({
      id: "preserved",
      key: "gpt-4o-mini",
      provider: "openai",
      inputRate: 1e-6,
      outputRate: 2e-6,
    });
    const loader = vi.fn().mockResolvedValueOnce([price]).mockResolvedValueOnce([]);
    const registry = new CanonicalLlmPricingRegistry(loader, 25);

    await registry.reload();
    await registry.reload();

    expect(registry.isLoaded).toBe(true);
    expect(registry.match("openai:gpt-4o-mini")?.id).toBe("preserved");
    registry.dispose();
  });

  it("delegates inclusive cache-aware cost math to the canonical helper", async () => {
    const price = currentPrice({
      id: "openai",
      key: "gpt-4o-mini",
      provider: "openai",
      inputRate: 1e-6,
      outputRate: 2e-6,
      cacheReadRate: 1e-7,
      cacheWriteRate: 1.25e-6,
    });
    const registry = new CanonicalLlmPricingRegistry(async () => [price]);
    await registry.reload();

    expect(
      registry.calculateCost("openai:gpt-4o-mini", {
        input: 1_000,
        output: 50,
        input_cached_tokens: 600,
        cache_creation_input_tokens: 300,
      }),
    ).toMatchObject({
      matchedModelId: price.modelId,
      inputCost: 0.000535,
      outputCost: 0.0001,
      totalCost: 0.000635,
    });
  });

  it("tries Azure pricing before the differing bare OpenAI alias", async () => {
    const azure = currentPrice({
      id: "azure",
      key: "azure/gpt-4o-mini",
      provider: "azure",
      inputRate: 9e-7,
      outputRate: 3.6e-6,
    });
    const openai = currentPrice({
      id: "openai",
      key: "gpt-4o-mini",
      provider: "openai",
      inputRate: 2e-7,
      outputRate: 8e-7,
    });
    const registry = new CanonicalLlmPricingRegistry(async () => [azure, openai]);
    await registry.reload();

    expect(registry.match("azure:gpt-4o-mini")?.id).toBe("azure");
    expect(registry.match("openai:gpt-4o-mini")?.id).toBe("openai");
  });

  it("reports input/output-complete models while rejecting a used unavailable cache rate", async () => {
    const price = currentPrice({
      id: "partial-cache",
      key: "openai/partial-cache",
      provider: "openai",
      inputRate: 1e-6,
      outputRate: 2e-6,
      cacheReadSource: ModelRateSource.UNAVAILABLE,
      cacheWriteSource: ModelRateSource.UNAVAILABLE,
    });
    const registry = new CanonicalLlmPricingRegistry(async () => [price]);
    await registry.reload();

    expect(registry.hasCompletePrice("openai:partial-cache")).toBe(true);
    expect(
      registry.calculateCost("openai:partial-cache", { input: 100, output: 10 }),
    ).not.toBeNull();
    expect(
      registry.calculateCost("openai:partial-cache", {
        input: 100,
        output: 10,
        input_cached_tokens: 50,
      }),
    ).toBeNull();
  });
});
