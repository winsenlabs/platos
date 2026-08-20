import { ModelRateSource, Prisma } from "@platos/tenancy-database";
import { describe, expect, test, vi } from "vitest";
import { CostService } from "./cost.service";

const observedAt = new Date("2026-07-31T00:00:00.000Z");

function priceRow() {
  return {
    id: "price-id",
    modelId: "model-id",
    effectiveFrom: observedAt,
    inputRate: new Prisma.Decimal("0.0000002"),
    outputRate: new Prisma.Decimal("0.0000012"),
    cacheReadRate: new Prisma.Decimal("0.00000002"),
    cacheWriteRate: new Prisma.Decimal("0.0000005"),
    inputSource: ModelRateSource.VERIFIED_PROVIDER,
    outputSource: ModelRateSource.VERIFIED_PROVIDER,
    cacheReadSource: ModelRateSource.VERIFIED_PROVIDER,
    cacheWriteSource: ModelRateSource.VERIFIED_PROVIDER,
    inputObservedAt: observedAt,
    outputObservedAt: observedAt,
    cacheReadObservedAt: observedAt,
    cacheWriteObservedAt: observedAt,
    inputSourceRef: "https://example.test/pricing",
    outputSourceRef: "https://example.test/pricing",
    cacheReadSourceRef: "https://example.test/pricing",
    cacheWriteSourceRef: "https://example.test/pricing",
    model: { key: "gpt-5.6-luna", provider: "openai", name: "gpt-5.6-luna" },
  };
}

function makeService(rows = [priceRow()]) {
  const prisma = { modelPrice: { findMany: vi.fn().mockResolvedValue(rows) } };
  const redis = {};
  return { service: new CostService(prisma as any, redis as any), prisma };
}

describe("CostService canonical pricing", () => {
  test("uses all four independent canonical rates", async () => {
    const { service } = makeService();
    const priced = await service.priceUsage(
      "openai:gpt-5.6-luna",
      1_000_000,
      0,
      1_000_000,
      0
    );

    expect(priced.costCents).toBe(50);
    expect(priced.price.cacheWrite.source).toBe(ModelRateSource.VERIFIED_PROVIDER);
  });

  test("unknown models fail explicitly instead of using an estimate", async () => {
    const { service } = makeService([]);
    await expect(service.calculateCost("openai:unknown", 100, 100)).rejects.toMatchObject({
      code: "MODEL_PRICING_UNAVAILABLE",
    });
  });
});
