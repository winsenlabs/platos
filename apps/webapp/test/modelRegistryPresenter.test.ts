import { beforeEach, describe, expect, it, vi } from "vitest";

const { controlDatabase } = vi.hoisted(() => ({
  controlDatabase: {
    model: {
      findMany: vi.fn(),
      findUnique: vi.fn(),
    },
  },
}));

vi.mock("~/db.server", () => ({ prisma: {}, $replica: {} }));
vi.mock("~/services/platosControlDatabase.server", () => ({
  platosControlDatabase: controlDatabase,
}));
vi.mock("~/presenters/v3/basePresenter.server", () => ({
  BasePresenter: class {},
}));

import { ModelRegistryPresenter } from "~/presenters/v3/ModelRegistryPresenter.server";

const currentAt = new Date("2026-08-20T00:00:00.000Z");
const historicalAt = new Date("2026-07-20T00:00:00.000Z");

function price(input: {
  id: string;
  effectiveFrom: Date;
  multiplier?: number;
  inputSource?: string;
}) {
  const multiplier = input.multiplier ?? 1;
  return {
    id: input.id,
    effectiveFrom: input.effectiveFrom,
    inputRate: String(1e-6 * multiplier),
    outputRate: String(2e-6 * multiplier),
    cacheReadRate: String(1e-7 * multiplier),
    cacheWriteRate: String(1.25e-6 * multiplier),
    inputSource: input.inputSource ?? "LITELLM",
    outputSource: "LITELLM",
    cacheReadSource: "LITELLM",
    cacheWriteSource: "UNAVAILABLE",
    inputObservedAt: input.effectiveFrom,
    outputObservedAt: input.effectiveFrom,
    cacheReadObservedAt: input.effectiveFrom,
    cacheWriteObservedAt: input.effectiveFrom,
    inputSourceRef: "https://provider.example/pricing",
    outputSourceRef: "https://litellm.example/catalog",
    cacheReadSourceRef: "https://litellm.example/catalog",
    cacheWriteSourceRef: null,
  };
}

function model(prices: ReturnType<typeof price>[]) {
  return {
    id: "model_1",
    key: "openai/gpt-canonical",
    provider: "openai",
    name: "gpt-canonical",
    description: "Canonical test model",
    contextWindow: 128_000,
    maxOutputTokens: 16_000,
    capabilities: ["function_calling", "vision", "vision"],
    releaseDate: new Date("2026-06-15T00:00:00.000Z"),
    baseModelName: null,
    prices,
  };
}

describe("ModelRegistryPresenter canonical model mapping", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("maps the current canonical ModelPrice with all four rates and provenance", async () => {
    const current = price({
      id: "price_current",
      effectiveFrom: currentAt,
      inputSource: "VERIFIED_PROVIDER",
    });
    controlDatabase.model.findMany.mockResolvedValue([model([current])]);

    const presenter = new ModelRegistryPresenter({} as any);
    const result = await presenter.getModelCatalog();

    expect(controlDatabase.model.findMany).toHaveBeenCalledWith({
      where: { isHidden: false },
      include: { prices: { orderBy: { effectiveFrom: "desc" }, take: 1 } },
      orderBy: { name: "asc" },
    });
    expect(result).toEqual([
      {
        provider: "openai",
        models: [
          expect.objectContaining({
            friendlyId: "model_1",
            modelName: "gpt-canonical",
            displayId: "openai:gpt-canonical",
            features: ["function_calling", "vision"],
            inputPrice: 1e-6,
            outputPrice: 2e-6,
            cacheReadPrice: 1e-7,
            cacheWritePrice: 1.25e-6,
            priceEffectiveFrom: currentAt.toISOString(),
            priceProvenance: {
              input: {
                source: "VERIFIED_PROVIDER",
                observedAt: currentAt.toISOString(),
                sourceRef: "https://provider.example/pricing",
              },
              output: {
                source: "LITELLM",
                observedAt: currentAt.toISOString(),
                sourceRef: "https://litellm.example/catalog",
              },
              cacheRead: {
                source: "LITELLM",
                observedAt: currentAt.toISOString(),
                sourceRef: "https://litellm.example/catalog",
              },
              cacheWrite: {
                source: "UNAVAILABLE",
                observedAt: currentAt.toISOString(),
                sourceRef: null,
              },
            },
          }),
        ],
      },
    ]);
  });

  it("selects the newest price as current and maps complete historical cards", async () => {
    const current = price({ id: "price_current", effectiveFrom: currentAt });
    const historical = price({
      id: "price_historical",
      effectiveFrom: historicalAt,
      multiplier: 2,
    });
    controlDatabase.model.findUnique.mockResolvedValue(model([current, historical]));

    const presenter = new ModelRegistryPresenter({} as any);
    const result = await presenter.getModelDetail("model_1");

    expect(controlDatabase.model.findUnique).toHaveBeenCalledWith({
      where: { id: "model_1" },
      include: { prices: { orderBy: { effectiveFrom: "desc" } } },
    });
    expect(result).toMatchObject({
      inputPrice: 1e-6,
      outputPrice: 2e-6,
      cacheReadPrice: 1e-7,
      cacheWritePrice: 1.25e-6,
      priceEffectiveFrom: currentAt.toISOString(),
      pricingTiers: [
        {
          name: currentAt.toISOString(),
          isDefault: true,
          prices: { input: 1e-6, output: 2e-6, cacheRead: 1e-7, cacheWrite: 1.25e-6 },
          provenance: expect.objectContaining({
            cacheWrite: expect.objectContaining({ source: "UNAVAILABLE", sourceRef: null }),
          }),
        },
        {
          name: historicalAt.toISOString(),
          isDefault: false,
          prices: { input: 2e-6, output: 4e-6, cacheRead: 2e-7, cacheWrite: 2.5e-6 },
          provenance: expect.objectContaining({
            input: expect.objectContaining({ observedAt: historicalAt.toISOString() }),
          }),
        },
      ],
    });
  });

  it("returns null for a missing canonical model", async () => {
    controlDatabase.model.findUnique.mockResolvedValue(null);

    await expect(new ModelRegistryPresenter({} as any).getModelDetail("missing")).resolves.toBeNull();
  });
});
