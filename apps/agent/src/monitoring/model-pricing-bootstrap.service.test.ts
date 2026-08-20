import { describe, expect, it, vi } from "vitest";
import { ModelPricingBootstrapService } from "./model-pricing-bootstrap.service";
import { createCredibleLiteLLMCatalog } from "./litellm-catalog-validation.test-fixture";

describe("ModelPricingBootstrapService", () => {
  it("ingests LiteLLM plus committed overrides on an empty fresh database", async () => {
    const prisma = {
      modelPrice: { findFirst: vi.fn().mockResolvedValue(null) },
    };
    const costService = {
      ingestCatalog: vi.fn().mockResolvedValue({
        modelsSeen: 2,
        pricesCreated: 2,
        unchanged: 0,
      }),
    };
    const fetchImpl = vi.fn().mockResolvedValue(
      new Response(
        JSON.stringify(createCredibleLiteLLMCatalog()),
        { status: 200, headers: { "Content-Type": "application/json" } },
      ),
    );
    const fetchedAt = new Date("2026-08-20T05:23:00.000Z");
    const service = new ModelPricingBootstrapService(prisma as any, costService as any);

    await expect(service.bootstrapIfEmpty(fetchImpl, fetchedAt)).resolves.toEqual({
      status: "bootstrapped",
      modelsSeen: 2,
      pricesCreated: 2,
      unchanged: 0,
    });
    expect(fetchImpl).toHaveBeenCalledOnce();
    expect(costService.ingestCatalog).toHaveBeenCalledWith(
      expect.objectContaining({ "gpt-4o-mini": expect.any(Object) }),
      fetchedAt,
    );
  });

  it("is idempotent when a canonical price already exists", async () => {
    const prisma = {
      modelPrice: { findFirst: vi.fn().mockResolvedValue({ id: "price-1" }) },
    };
    const costService = { ingestCatalog: vi.fn() };
    const fetchImpl = vi.fn();
    const service = new ModelPricingBootstrapService(prisma as any, costService as any);

    await expect(service.bootstrapIfEmpty(fetchImpl)).resolves.toEqual({
      status: "already_ready",
    });
    expect(fetchImpl).not.toHaveBeenCalled();
    expect(costService.ingestCatalog).not.toHaveBeenCalled();
  });

  it("fails startup when the database is empty and the canonical source is unavailable", async () => {
    const prisma = {
      modelPrice: { findFirst: vi.fn().mockResolvedValue(null) },
    };
    const service = new ModelPricingBootstrapService(
      prisma as any,
      { ingestCatalog: vi.fn() } as any,
    );
    const fetchImpl = vi.fn().mockResolvedValue(new Response("unavailable", { status: 503 }));

    await expect(service.bootstrapIfEmpty(fetchImpl)).rejects.toThrow(
      "LiteLLM bootstrap failed with HTTP 503",
    );
  });
});
