import { beforeEach, describe, expect, it, vi } from "vitest";

const { authenticate, controlDatabase, pricingRegistry, prisma } = vi.hoisted(() => ({
  authenticate: vi.fn(),
  controlDatabase: {
    model: {
      count: vi.fn(),
      findMany: vi.fn(),
      findUnique: vi.fn(),
    },
  },
  pricingRegistry: { reload: vi.fn() },
  prisma: { user: { findUnique: vi.fn() } },
}));

vi.mock("~/db.server", () => ({ prisma }));
vi.mock("~/services/patService.server", () => ({
  authenticateApiRequestWithPAT: authenticate,
}));
vi.mock("~/services/platosControlDatabase.server", () => ({
  platosControlDatabase: controlDatabase,
}));
vi.mock("~/v3/llmPricingRegistry.server", () => ({
  llmPricingRegistry: pricingRegistry,
}));

import * as detailRoute from "~/routes/admin.api.v1.llm-models.$modelId";
import * as reloadRoute from "~/routes/admin.api.v1.llm-models.reload";
import * as seedRoute from "~/routes/admin.api.v1.llm-models.seed";
import * as modelsRoute from "~/routes/admin.api.v1.llm-models";

const request = (path: string, method = "GET") =>
  new Request(`https://platos.example${path}`, { method });

async function responseFrom(call: Promise<Response>): Promise<Response> {
  try {
    return await call;
  } catch (error) {
    if (error instanceof Response) return error;
    throw error;
  }
}

function canonicalPrice(id: string, effectiveFrom: string) {
  return {
    id,
    effectiveFrom,
    inputRate: "0.000001000000",
    outputRate: "0.000002000000",
    cacheReadRate: "0.000000100000",
    cacheWriteRate: "0.000001250000",
    inputSource: "VERIFIED_PROVIDER",
    outputSource: "LITELLM",
    cacheReadSource: "LITELLM",
    cacheWriteSource: "UNAVAILABLE",
    inputObservedAt: effectiveFrom,
    outputObservedAt: effectiveFrom,
    cacheReadObservedAt: effectiveFrom,
    cacheWriteObservedAt: effectiveFrom,
    inputSourceRef: "https://provider.example/pricing",
    outputSourceRef: "https://litellm.example/catalog",
    cacheReadSourceRef: "https://litellm.example/catalog",
    cacheWriteSourceRef: null,
  };
}

describe("admin canonical LLM model routes", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    authenticate.mockResolvedValue({ userId: "user_1" });
    prisma.user.findUnique.mockResolvedValue({ id: "user_1", admin: true });
  });

  it.each([
    { query: "?page=0&pageSize=999", page: 1, pageSize: 200 },
    { query: "?page=invalid&pageSize=invalid", page: 1, pageSize: 50 },
  ])("bounds pagination for $query", async ({ query, page, pageSize }) => {
    const price = canonicalPrice("price_current", "2026-08-20T00:00:00.000Z");
    controlDatabase.model.findMany.mockResolvedValue([
      { id: "model_1", key: "openai/gpt-canonical", provider: "openai", prices: [price] },
    ]);
    controlDatabase.model.count.mockResolvedValue(1);

    const response = await modelsRoute.loader({
      request: request(`/admin/api/v1/llm-models${query}`),
      params: {},
      context: {},
    } as any);

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      models: [
        { id: "model_1", key: "openai/gpt-canonical", provider: "openai", prices: [price] },
      ],
      total: 1,
      page,
      pageSize,
    });
    expect(controlDatabase.model.findMany).toHaveBeenCalledWith({
      include: { prices: { orderBy: { effectiveFrom: "desc" }, take: 1 } },
      orderBy: { name: "asc" },
      skip: (page - 1) * pageSize,
      take: pageSize,
    });
  });

  it("returns one canonical model with newest-to-oldest four-rate provenance history", async () => {
    const current = canonicalPrice("price_current", "2026-08-20T00:00:00.000Z");
    const historical = canonicalPrice("price_historical", "2026-07-20T00:00:00.000Z");
    const model = {
      id: "model_1",
      key: "openai/gpt-canonical",
      provider: "openai",
      prices: [current, historical],
    };
    controlDatabase.model.findUnique.mockResolvedValue(model);

    const response = await detailRoute.loader({
      request: request("/admin/api/v1/llm-models/model_1"),
      params: { modelId: "model_1" },
      context: {},
    } as any);

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ model });
    expect(controlDatabase.model.findUnique).toHaveBeenCalledWith({
      where: { id: "model_1" },
      include: { prices: { orderBy: { effectiveFrom: "desc" } } },
    });
  });

  it("returns 401 for missing authentication and 403 for a non-admin", async () => {
    authenticate.mockResolvedValueOnce(null);
    const unauthorized = await responseFrom(modelsRoute.loader({
      request: request("/admin/api/v1/llm-models"),
      params: {},
      context: {},
    } as any));
    expect(unauthorized.status).toBe(401);
    expect(await unauthorized.json()).toEqual({ error: "Invalid or Missing API key" });
    expect(controlDatabase.model.findMany).not.toHaveBeenCalled();

    prisma.user.findUnique.mockResolvedValueOnce({ id: "user_1", admin: false });
    const forbidden = await reloadRoute.action({
      request: request("/admin/api/v1/llm-models/reload", "POST"),
      params: {},
      context: {},
    } as any);
    expect(forbidden.status).toBe(403);
    expect(await forbidden.json()).toEqual({
      error: "You must be an admin to perform this action",
    });
    expect(pricingRegistry.reload).not.toHaveBeenCalled();
  });

  it("returns 404 when canonical model detail does not exist", async () => {
    controlDatabase.model.findUnique.mockResolvedValue(null);

    const response = await detailRoute.loader({
      request: request("/admin/api/v1/llm-models/missing"),
      params: { modelId: "missing" },
      context: {},
    } as any);

    expect(response.status).toBe(404);
    expect(await response.json()).toEqual({ error: "Model not found" });
  });

  it("reloads the in-process canonical pricing view", async () => {
    pricingRegistry.reload.mockResolvedValue(undefined);

    const response = await reloadRoute.action({
      request: request("/admin/api/v1/llm-models/reload", "POST"),
      params: {},
      context: {},
    } as any);

    expect(pricingRegistry.reload).toHaveBeenCalledOnce();
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      success: true,
      message: "Canonical LLM pricing view reloaded",
    });
  });

  it.each([
    {
      name: "collection mutation",
      call: () => modelsRoute.action({
        request: request("/admin/api/v1/llm-models", "POST"),
        params: {},
        context: {},
      } as any),
      error: "Canonical model metadata and append-only prices are refreshed by the authenticated LiteLLM callback",
    },
    {
      name: "price-history mutation",
      call: () => detailRoute.action({
        request: request("/admin/api/v1/llm-models/model_1", "PATCH"),
        params: { modelId: "model_1" },
        context: {},
      } as any),
      error: "Canonical ModelPrice history is append-only and cannot be changed through this route",
    },
  ])("rejects legacy $name with 405", async ({ call, error }) => {
    const response = await call();

    expect(response.status).toBe(405);
    expect(await response.json()).toEqual({ error });
  });

  it("rejects removed static seeding with 410", async () => {
    const response = await seedRoute.action({
      request: request("/admin/api/v1/llm-models/seed", "POST"),
      params: {},
      context: {},
    } as any);

    expect(response.status).toBe(410);
    expect(await response.json()).toEqual({
      error: "Static legacy model seeding was removed; use the canonical daily LiteLLM refresh",
    });
  });
});
