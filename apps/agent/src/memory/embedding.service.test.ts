/**
 * EmbeddingService timeout and scoped-cache regressions.
 *
 * A bare `await fetch` to the embedding provider with no timeout once stalled
 * a whole agent turn ~64s pre-LLM on a cold/slow provider key (the demo-site
 * slowness investigation). `fetchWithTimeout` now bounds the provider call with
 * `AbortSignal.timeout(PLATOS_EMBEDDING_TIMEOUT_MS)`. These tests pin that:
 *   - a hung provider rejects within the timeout, not after the hang resolves;
 *   - the abort surfaces as a readable "timed out" error, not a raw DOMException.
 *
 * We stub global.fetch — the EXTERNAL provider HTTP boundary — which the
 * no-mocks-for-owned-services rule explicitly permits (the embedding API is not
 * a service Platos owns). EmbeddingService itself is real.
 */
// env.ts parse-caches on FIRST access (Proxy), so these must be set at module
// load — before EmbeddingService's constructor touches `env`. Pin provider to
// voyage + supply its key + a >500ms timeout (schema floor).
process.env.PLATOS_EMBEDDING_PROVIDER = "voyage";
process.env.VOYAGE_API_KEY = process.env.VOYAGE_API_KEY || "test-voyage-key";
process.env.PLATOS_EMBEDDING_TIMEOUT_MS = "600";

import { afterEach, describe, expect, it, vi } from "vitest";
import { ModelRateSource } from "@platos/tenancy-database";
import { EmbeddingService } from "./embedding.service";

const realFetch = global.fetch;
const VECTOR = Array.from({ length: EmbeddingService.DIMENSION }, (_, index) => index / 1000);
const VECTOR_B = VECTOR.map((value) => value + 1);

const scopeA = {
  organizationId: "org-1",
  projectId: "project-1",
  environmentId: "env-a",
};
const scopeB = {
  organizationId: "org-1",
  projectId: "project-1",
  environmentId: "env-b",
};

function successfulEmbeddingResponse(vector = VECTOR): Response {
  return new Response(
    JSON.stringify({ data: [{ embedding: vector, index: 0 }], usage: { total_tokens: 1 } }),
    { status: 200, headers: { "Content-Type": "application/json" } },
  );
}

function makeCostService(resolvePrice = vi.fn(async () => ({
  input: { source: ModelRateSource.LITELLM },
  output: { source: ModelRateSource.LITELLM },
}))) {
  return {
    resolvePrice,
    priceUsageFromSnapshot: vi.fn(() => ({ costCents: 0 })),
    recordAuxiliaryCost: vi.fn(),
  };
}

function makeService(scopedEnv?: unknown): EmbeddingService {
  return new EmbeddingService(makeCostService() as any, scopedEnv as any);
}

describe("EmbeddingService.embed", () => {
  afterEach(() => {
    global.fetch = realFetch;
    vi.restoreAllMocks();
  });

  it("rejects with a readable timeout error when the provider hangs", async () => {
    // Provider that never resolves on its own, but honours the abort signal
    // the way real fetch does — rejecting with an AbortError when aborted.
    global.fetch = vi.fn((_url: any, init: any) => {
      return new Promise((_resolve, reject) => {
        const signal: AbortSignal | undefined = init?.signal;
        if (signal) {
          signal.addEventListener("abort", () => {
            const e = new Error("aborted");
            e.name = "TimeoutError";
            reject(e);
          });
        }
      });
    }) as any;

    const svc = makeService();
    const start = Date.now();
    await expect(svc.embed("hello world")).rejects.toThrow(/timed out after 600ms/);
    // Must reject promptly at the timeout, not hang indefinitely.
    expect(Date.now() - start).toBeLessThan(2000);
  });

  it("does not use a populated deployment key when a scoped credential is missing", async () => {
    global.fetch = vi.fn() as any;
    const scopedEnv = { getForProvider: vi.fn(async () => undefined) };
    const svc = makeService(scopedEnv);

    await expect(
      svc.embed("scoped text", {
        organizationId: "org-1",
        projectId: "project-1",
        environmentId: "env-1",
      }),
    ).rejects.toThrow(/not configured for this Environment/i);
    expect(scopedEnv.getForProvider).toHaveBeenCalledWith(
      expect.objectContaining({ environmentId: "env-1" }),
      "VOYAGE_API_KEY",
      "voyage",
    );
    expect(global.fetch).not.toHaveBeenCalled();
  });

  it("fails closed when another Environment requests text warmed in the cache", async () => {
    global.fetch = vi
      .fn()
      .mockResolvedValueOnce(successfulEmbeddingResponse())
      .mockResolvedValueOnce(successfulEmbeddingResponse(VECTOR_B)) as any;
    let environmentBHasCredential = false;
    const scopedEnv = {
      getForProvider: vi.fn(async (scope: typeof scopeA) =>
        scope.environmentId === scopeA.environmentId || environmentBHasCredential
          ? `${scope.environmentId}-key`
          : undefined,
      ),
    };
    const svc = makeService(scopedEnv);

    await expect(svc.embed("shared text", scopeA)).resolves.toEqual(VECTOR);
    await expect(svc.embed("shared text", scopeB)).rejects.toThrow(
      /not configured for this Environment/i,
    );
    environmentBHasCredential = true;
    await expect(svc.embed("shared text", scopeB)).resolves.toEqual(VECTOR_B);

    expect(scopedEnv.getForProvider).toHaveBeenCalledTimes(3);
    expect(scopedEnv.getForProvider).toHaveBeenLastCalledWith(
      scopeB,
      "VOYAGE_API_KEY",
      "voyage",
    );
    expect(global.fetch).toHaveBeenCalledTimes(2);
  });

  it("revalidates the credential but reuses a same-scope vector after key rotation", async () => {
    global.fetch = vi.fn(async () => successfulEmbeddingResponse()) as any;
    const scopedEnv = {
      getForProvider: vi
        .fn()
        .mockResolvedValueOnce("credential-before-rotation")
        .mockResolvedValueOnce("credential-after-rotation"),
    };
    const svc = makeService(scopedEnv);

    const first = await svc.embed("same scoped text", scopeA);
    const second = await svc.embed("same scoped text", scopeA);

    expect(first).toEqual(VECTOR);
    expect(second).toBe(first);
    expect(scopedEnv.getForProvider).toHaveBeenCalledTimes(2);
    expect(global.fetch).toHaveBeenCalledTimes(1);
  });

  it("does not return a same-scope cache hit after its credential becomes unavailable", async () => {
    global.fetch = vi.fn(async () => successfulEmbeddingResponse()) as any;
    const scopedEnv = {
      getForProvider: vi
        .fn()
        .mockResolvedValueOnce("credential-before-revocation")
        .mockResolvedValueOnce(undefined),
    };
    const svc = makeService(scopedEnv);

    await expect(svc.embed("revoked scoped text", scopeA)).resolves.toEqual(VECTOR);
    await expect(svc.embed("revoked scoped text", scopeA)).rejects.toThrow(
      /not configured for this Environment/i,
    );

    expect(scopedEnv.getForProvider).toHaveBeenCalledTimes(2);
    expect(global.fetch).toHaveBeenCalledTimes(1);
  });

  it("rejects unavailable pricing before calling the embedding provider", async () => {
    global.fetch = vi.fn() as any;
    const costService = makeCostService(vi.fn().mockRejectedValue(new Error("missing")));
    const svc = new EmbeddingService(costService as any);

    await expect(svc.embed("unpriced text")).rejects.toMatchObject({
      code: "model_pricing_unavailable",
    });
    expect(global.fetch).not.toHaveBeenCalled();
  });
});
