/**
 * EmbeddingService timeout regression (latency fix, 2026-06-01).
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
import { EmbeddingService } from "./embedding.service";

const realFetch = global.fetch;

function makeService(): EmbeddingService {
  // No ScopedEnvService / CostService — the key path resolves from env
  // (voyage), and cost recording is fire-and-forget optional.
  return new EmbeddingService();
}

describe("EmbeddingService.embed — provider timeout", () => {
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

  it("does not fall back to a container key when a scoped credential is absent", async () => {
    const get = vi.fn().mockResolvedValue(undefined);
    const svc = new EmbeddingService({ get } as any);
    const scope = {
      organizationId: "org-1",
      projectId: "project-1",
      environmentId: "environment-1",
    };

    await expect((svc as any).resolveApiKey(scope)).resolves.toBeUndefined();
    expect(get).toHaveBeenCalledWith(scope, "VOYAGE_API_KEY");
  });
});
