import {
  calculateCanonicalModelCost,
  ModelRateSource,
  modelPricingLookupKeys,
  type CanonicalModelPriceSnapshot,
  type Prisma,
} from "@platos/tenancy-database";
import { env } from "~/env.server";
import { platosControlDatabase } from "~/services/platosControlDatabase.server";
import { signalsEmitter } from "~/services/signals.server";
import { singleton } from "~/utils/singleton";
import { setLlmPricingRegistry } from "./utils/enrichCreatableEvents.server";

export type CurrentPrice = {
  id: string;
  modelId: string;
  effectiveFrom: Date;
  model: { key: string; name: string; provider: string };
  inputRate: Prisma.Decimal;
  outputRate: Prisma.Decimal;
  cacheReadRate: Prisma.Decimal;
  cacheWriteRate: Prisma.Decimal;
  inputSource: ModelRateSource;
  outputSource: ModelRateSource;
  cacheReadSource: ModelRateSource;
  cacheWriteSource: ModelRateSource;
  inputObservedAt: Date;
  outputObservedAt: Date;
  cacheReadObservedAt: Date;
  cacheWriteObservedAt: Date;
  inputSourceRef: string | null;
  outputSourceRef: string | null;
  cacheReadSourceRef: string | null;
  cacheWriteSourceRef: string | null;
};

export const EMPTY_PRICING_RETRY_MS = 2_000;

export class CanonicalLlmPricingRegistry {
  private prices = new Map<string, CurrentPrice>();
  private reloadInFlight: Promise<void> | null = null;
  private emptyRetryTimer: ReturnType<typeof setTimeout> | null = null;
  private resolveReady!: () => void;
  readonly isReady = new Promise<void>((resolve) => {
    this.resolveReady = resolve;
  });
  isLoaded = false;

  constructor(
    private readonly loadCurrentPrices: () => Promise<CurrentPrice[]> = () =>
      platosControlDatabase.modelPrice.findMany({
        where: { effectiveFrom: { lte: new Date() } },
        include: { model: { select: { key: true, name: true, provider: true } } },
        orderBy: { effectiveFrom: "desc" },
      }),
    private readonly emptyRetryMs = EMPTY_PRICING_RETRY_MS,
  ) {}

  async reload(): Promise<void> {
    if (this.reloadInFlight) return this.reloadInFlight;
    const reload = this.performReload().finally(() => {
      if (this.reloadInFlight === reload) this.reloadInFlight = null;
    });
    this.reloadInFlight = reload;
    return reload;
  }

  private async performReload(): Promise<void> {
    const rows = await this.loadCurrentPrices();
    if (rows.length === 0) {
      if (!this.isLoaded && this.emptyRetryTimer === null) {
        console.warn(
          `Canonical LLM pricing catalog is empty; retrying in ${this.emptyRetryMs}ms`,
        );
        this.emptyRetryTimer = setTimeout(() => {
          this.emptyRetryTimer = null;
          this.reload().catch((error) => {
            console.error("Failed to retry canonical LLM pricing registry", error);
          });
        }, this.emptyRetryMs);
      }
      return;
    }
    const next = new Map<string, CurrentPrice>();
    for (const row of rows) {
      if (!next.has(row.model.key)) next.set(row.model.key, row);
    }
    if (this.emptyRetryTimer !== null) {
      clearTimeout(this.emptyRetryTimer);
      this.emptyRetryTimer = null;
    }
    this.prices = next;
    this.isLoaded = true;
    this.resolveReady();
  }

  dispose(): void {
    if (this.emptyRetryTimer !== null) {
      clearTimeout(this.emptyRetryTimer);
      this.emptyRetryTimer = null;
    }
  }

  match(model: string): CurrentPrice | null {
    for (const key of modelPricingLookupKeys(model)) {
      const price = this.prices.get(key);
      if (price) return price;
    }
    return null;
  }

  hasCompletePrice(model: string): boolean {
    const price = this.match(model);
    return price !== null && [
      price.inputSource,
      price.outputSource,
    ].every((source) => source !== ModelRateSource.UNAVAILABLE);
  }

  calculateCost(responseModel: string, usage: Record<string, number>) {
    const price = this.match(responseModel);
    if (!price) return null;
    const snapshot = this.toSnapshot(price);
    const inputTokens = usage.input ?? 0;
    const outputTokens = usage.output ?? 0;
    const cacheReadTokens = usage.input_cached_tokens ?? 0;
    const cacheWriteTokens = usage.cache_creation_input_tokens ?? 0;
    const freshInputTokens = inputTokens - cacheReadTokens - cacheWriteTokens;
    try {
      const costUsd = (tokenUsage: {
        inputTokens: number;
        outputTokens: number;
        cacheReadInputTokens?: number;
        cacheWriteInputTokens?: number;
      }) => calculateCanonicalModelCost(responseModel, snapshot, tokenUsage) / 100;
      const costs = {
        input: costUsd({ inputTokens: freshInputTokens, outputTokens: 0 }),
        output: costUsd({ inputTokens: 0, outputTokens }),
        input_cached_tokens: costUsd({
          inputTokens: cacheReadTokens,
          outputTokens: 0,
          cacheReadInputTokens: cacheReadTokens,
        }),
        cache_creation_input_tokens: costUsd({
          inputTokens: cacheWriteTokens,
          outputTokens: 0,
          cacheWriteInputTokens: cacheWriteTokens,
        }),
      };
      const totalCost = costUsd({
        inputTokens,
        outputTokens,
        cacheReadInputTokens: cacheReadTokens,
        cacheWriteInputTokens: cacheWriteTokens,
      });
      const inputCost = totalCost - costs.output;
      return {
        matchedModelId: price.modelId,
        matchedModelName: price.model.name,
        pricingTierId: price.id,
        pricingTierName: "canonical",
        inputCost,
        outputCost: costs.output,
        totalCost,
        costDetails: costs,
      };
    } catch {
      // Unknown/used-unavailable rates remain explicitly unpriced in OTLP.
      return null;
    }
  }

  private toSnapshot(price: CurrentPrice): CanonicalModelPriceSnapshot {
    const rate = (
      usdPerToken: Prisma.Decimal,
      source: ModelRateSource,
      observedAt: Date,
      sourceRef: string | null,
    ) => ({ usdPerToken: usdPerToken.toNumber(), source, observedAt, sourceRef });
    return {
      modelPriceId: price.id,
      modelId: price.modelId,
      modelKey: price.model.key,
      provider: price.model.provider,
      modelName: price.model.name,
      effectiveFrom: price.effectiveFrom,
      input: rate(price.inputRate, price.inputSource, price.inputObservedAt, price.inputSourceRef),
      output: rate(price.outputRate, price.outputSource, price.outputObservedAt, price.outputSourceRef),
      cacheRead: rate(
        price.cacheReadRate,
        price.cacheReadSource,
        price.cacheReadObservedAt,
        price.cacheReadSourceRef,
      ),
      cacheWrite: rate(
        price.cacheWriteRate,
        price.cacheWriteSource,
        price.cacheWriteObservedAt,
        price.cacheWriteSourceRef,
      ),
    };
  }
}

export const llmPricingRegistry = singleton("llmPricingRegistry", () => {
  if (!env.LLM_COST_TRACKING_ENABLED) return null;

  const registry = new CanonicalLlmPricingRegistry();
  setLlmPricingRegistry(registry);
  registry.reload().catch((err) => {
    console.error("Failed to initialize canonical LLM pricing registry", err);
  });

  const interval = setInterval(() => {
    registry.reload().catch((err) => {
      console.error("Failed to reload canonical LLM pricing registry", err);
    });
  }, env.LLM_PRICING_RELOAD_INTERVAL_MS);
  const dispose = () => {
    clearInterval(interval);
    registry.dispose();
  };
  signalsEmitter.on("SIGTERM", dispose);
  signalsEmitter.on("SIGINT", dispose);
  return registry;
});

export async function waitForLlmPricingReady(): Promise<void> {
  if (!llmPricingRegistry || llmPricingRegistry.isLoaded) return;
  const timeoutMs = env.LLM_PRICING_READY_TIMEOUT_MS;
  if (timeoutMs <= 0) return;
  await Promise.race([
    llmPricingRegistry.isReady,
    new Promise<void>((resolve) => setTimeout(resolve, timeoutMs)),
  ]);
}
