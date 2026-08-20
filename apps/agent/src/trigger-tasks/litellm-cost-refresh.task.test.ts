import { describe, expect, it, vi } from "vitest";

vi.mock("@trigger.dev/sdk", () => ({
  schedules: { task: (definition: unknown) => definition },
  metadata: { set: vi.fn() },
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

import { createCredibleLiteLLMCatalog } from "../monitoring/litellm-catalog-validation.test-fixture";
import { fetchLiteLLMCatalog, pushLiteLLMCatalog } from "./litellm-cost-refresh.task";

const catalog = createCredibleLiteLLMCatalog();
const fetchedAt = new Date("2026-08-20T05:23:00.000Z");

describe("LiteLLM refresh callback", () => {
  it("accepts only a 2xx response whose parsed body has status ok", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ status: "ok", modelsSeen: 1, pricesCreated: 1 }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      }),
    );

    await expect(
      pushLiteLLMCatalog("https://agent.test", "internal-token", catalog, fetchedAt, fetchImpl),
    ).resolves.toMatchObject({ status: "ok", modelsSeen: 1 });
    const [, request] = fetchImpl.mock.calls[0] as [string, RequestInit];
    expect(request.headers).toMatchObject({
      "X-Platos-Internal-Auth": "internal-token",
    });
    expect(JSON.parse(String(request.body))).toEqual({
      catalog,
      fetchedAt: fetchedAt.toISOString(),
    });
  });

  it.each(["skipped", "forbidden", "invalid"])(
    "rejects a misleading 2xx %s body",
    async (status) => {
      const fetchImpl = vi.fn().mockResolvedValue(
        new Response(JSON.stringify({ status }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        }),
      );
      await expect(
        pushLiteLLMCatalog("https://agent.test", "internal-token", catalog, fetchedAt, fetchImpl),
      ).rejects.toThrow(`unexpected status ${status}`);
    },
  );

  it("rejects auth mismatch HTTP responses even if their body claims ok", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ status: "ok" }), {
        status: 403,
        headers: { "Content-Type": "application/json" },
      }),
    );
    await expect(
      pushLiteLLMCatalog("https://agent.test", "wrong-token", catalog, fetchedAt, fetchImpl),
    ).rejects.toThrow("HTTP 403");
  });

  it("rejects a non-JSON success response", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(new Response("accepted", { status: 200 }));
    await expect(
      pushLiteLLMCatalog("https://agent.test", "internal-token", catalog, fetchedAt, fetchImpl),
    ).rejects.toThrow("unexpected status invalid_body");
  });
});

describe("LiteLLM refresh fetch boundary", () => {
  it("retries and rejects an empty/truncated baseline", async () => {
    const fetchImpl = vi.fn(async () => Response.json({}));
    const sleep = vi.fn().mockResolvedValue(undefined);

    await expect(fetchLiteLLMCatalog(fetchImpl, sleep)).rejects.toThrow(
      "catalog is truncated",
    );
    expect(fetchImpl).toHaveBeenCalledTimes(3);
    expect(sleep).toHaveBeenCalledTimes(2);
  });

  it("retries a malformed baseline and accepts the next credible response", async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(Response.json({}))
      .mockResolvedValueOnce(Response.json(createCredibleLiteLLMCatalog()));
    const sleep = vi.fn().mockResolvedValue(undefined);

    await expect(fetchLiteLLMCatalog(fetchImpl, sleep)).resolves.toHaveProperty(
      "gpt-4o-mini",
    );
    expect(fetchImpl).toHaveBeenCalledTimes(2);
    expect(sleep).toHaveBeenCalledOnce();
  });
});
