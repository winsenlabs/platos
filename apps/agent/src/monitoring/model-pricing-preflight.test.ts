import { ModelRateSource } from "@platos/tenancy-database";
import { describe, expect, it, vi } from "vitest";
import { preflightModelPricing } from "./model-pricing-preflight";

const usablePrice = {
  input: { source: ModelRateSource.LITELLM },
  output: { source: ModelRateSource.LITELLM },
};

describe("preflightModelPricing", () => {
  it("returns the exact canonical snapshot for post-response attribution", async () => {
    const resolvePrice = vi.fn().mockResolvedValue(usablePrice);
    await expect(
      preflightModelPricing({ resolvePrice } as any, "openai:gpt-4o-mini"),
    ).resolves.toBe(usablePrice);
  });

  it.each([
    null,
    { resolvePrice: vi.fn().mockRejectedValue(new Error("missing")) },
    {
      resolvePrice: vi.fn().mockResolvedValue({
        input: { source: ModelRateSource.UNAVAILABLE },
        output: { source: ModelRateSource.LITELLM },
      }),
    },
  ])("maps unavailable pricing to the stable provider runtime code", async (costService) => {
    await expect(
      preflightModelPricing(costService as any, "sakana:fugu"),
    ).rejects.toMatchObject({ code: "model_pricing_unavailable" });
  });
});
