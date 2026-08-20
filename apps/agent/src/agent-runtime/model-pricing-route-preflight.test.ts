import { describe, expect, it, vi } from "vitest";
import { ModelRateSource } from "@platos/tenancy-database";

const { generateTextMock } = vi.hoisted(() => ({ generateTextMock: vi.fn() }));
vi.mock("ai", async () => {
  const actual = await vi.importActual<typeof import("ai")>("ai");
  return { ...actual, generateText: generateTextMock };
});

import { AgentService } from "./agent.service";

describe("AgentService route pricing preflight", () => {
  it("rejects an unsupported primary-only Sakana route before provider invocation", async () => {
    const costService = { resolvePrice: vi.fn().mockRejectedValue(new Error("unpriced")) };
    const service = new AgentService(
      {} as any,
      {} as any,
      {} as any,
      { get: vi.fn() } as any,
      undefined,
      undefined,
      undefined,
      undefined,
      costService as any,
    );
    vi.spyOn(service as any, "resolveApiKey").mockResolvedValue("sakana-key");
    vi.spyOn(service as any, "resolveProviderRuntimeOptions").mockResolvedValue(undefined);

    await expect(
      (service as any).resolveRouteWithFallback(
        { model: "sakana:fugu", agentRetryConfig: { rules: [] }, modelRoutes: [] },
        {
          organizationId: "org-1",
          projectId: "project-1",
          environmentId: "env-1",
          userId: "user-1",
        },
        [],
      ),
    ).rejects.toMatchObject({ code: "model_pricing_unavailable" });
    expect(costService.resolvePrice).toHaveBeenCalledWith("sakana:fugu");
    expect(generateTextMock).not.toHaveBeenCalled();
  });

  it("returns and attributes the exact fallback model price selected before its ping", async () => {
    const fallbackPrice = {
      input: { source: ModelRateSource.LITELLM },
      output: { source: ModelRateSource.LITELLM },
    };
    const costService = {
      resolvePrice: vi.fn(async (model: string) => {
        if (model === "sakana:fugu") throw new Error("unpriced");
        return fallbackPrice;
      }),
      priceUsageFromSnapshot: vi.fn(() => ({ costCents: 0.01 })),
      recordAuxiliaryCost: vi.fn(),
    };
    const service = new AgentService(
      {} as any,
      {} as any,
      {} as any,
      { get: vi.fn() } as any,
      undefined,
      undefined,
      undefined,
      undefined,
      costService as any,
    );
    vi.spyOn(service as any, "resolveApiKey").mockResolvedValue("provider-key");
    vi.spyOn(service as any, "resolveProviderRuntimeOptions").mockResolvedValue(undefined);
    generateTextMock.mockResolvedValueOnce({
      usage: { inputTokens: 2, outputTokens: 1 },
    });

    const result = await (service as any).resolveRouteWithFallback(
      {
        model: "sakana:fugu",
        agentRetryConfig: {
          rules: [{ action: "fallback", fallbackToRouteLabel: "priced" }],
        },
        modelRoutes: [{ label: "priced", model: "openai:gpt-4o-mini" }],
      },
      {
        organizationId: "org-1",
        projectId: "project-1",
        environmentId: "env-1",
        userId: "user-1",
      },
      [],
    );

    expect(result).toMatchObject({
      routeLabel: "priced",
      modelString: "openai:gpt-4o-mini",
      price: fallbackPrice,
    });
    expect(costService.priceUsageFromSnapshot).toHaveBeenCalledWith(
      "openai:gpt-4o-mini",
      fallbackPrice,
      2,
      1,
    );
    expect(costService.recordAuxiliaryCost).toHaveBeenCalledWith(
      expect.objectContaining({ model: "openai:gpt-4o-mini", kind: "route-preflight" }),
    );
  });
});
