import { describe, it, expect, vi } from "vitest";
import { makeRetryFetch, DEFAULT_RETRY_RULES, type RetryRule } from "./retry-fetch";

/**
 * Test harness — return a `fetch`-shaped function that yields a script of
 * preconfigured Response objects in order. Lets us assert retry counts,
 * Retry-After honoring, etc. without hitting the network.
 */
function scriptFetch(
  responses: Array<Response | (() => Response | Promise<Response>) | Error>,
): typeof fetch & { calls: number } {
  let i = 0;
  const fn = async (_input: unknown, _init?: unknown): Promise<Response> => {
    if (i >= responses.length) {
      throw new Error(`scriptFetch: exhausted (${i} calls)`);
    }
    const next = responses[i++];
    if (next instanceof Error) throw next;
    if (typeof next === "function") return await next();
    return next;
  };
  Object.defineProperty(fn, "calls", { get: () => i });
  return fn as any;
}

describe("makeRetryFetch", () => {
  it("returns the response unchanged when ok", async () => {
    const inner = scriptFetch([new Response("hi", { status: 200 })]);
    const fetchFn = makeRetryFetch(DEFAULT_RETRY_RULES, inner);
    const res = await fetchFn("https://x");
    expect(res.status).toBe(200);
    expect((inner as any).calls).toBe(1);
  });

  it("retries on 429 then succeeds", async () => {
    const inner = scriptFetch([
      new Response("rl", { status: 429 }),
      new Response("ok", { status: 200 }),
    ]);
    const rules: RetryRule[] = [
      { cause: "rate-limit", action: "retry", retryCount: 1, backoffMs: 1 },
    ];
    const res = await makeRetryFetch(rules, inner)("https://x");
    expect(res.status).toBe(200);
    expect((inner as any).calls).toBe(2);
  });

  it("honors Retry-After: <seconds>", async () => {
    const inner = scriptFetch([
      new Response("rl", { status: 429, headers: { "retry-after": "1" } }),
      new Response("ok", { status: 200 }),
    ]);
    const rules: RetryRule[] = [
      { cause: "rate-limit", action: "retry", retryCount: 1, backoffMs: 99_999, waitForRetryAfter: true },
    ];
    const start = Date.now();
    const res = await makeRetryFetch(rules, inner)("https://x");
    const elapsed = Date.now() - start;
    expect(res.status).toBe(200);
    // Retry-After=1s should win over backoffMs=99s. Allow slop.
    expect(elapsed).toBeLessThan(2_000);
    expect(elapsed).toBeGreaterThanOrEqual(900);
  });

  it("fails fast on auth errors when rule.action=fail", async () => {
    const inner = scriptFetch([new Response("nope", { status: 401 })]);
    const rules: RetryRule[] = [
      { cause: "auth-error", action: "fail" },
    ];
    const res = await makeRetryFetch(rules, inner)("https://x");
    expect(res.status).toBe(401);
    expect((inner as any).calls).toBe(1);
  });

  it("retries network errors then surfaces last error", async () => {
    const inner = scriptFetch([
      new TypeError("ECONNRESET"),
      new TypeError("ECONNRESET"),
    ]);
    const rules: RetryRule[] = [
      { cause: "network-error", action: "retry", retryCount: 1, backoffMs: 1 },
    ];
    await expect(makeRetryFetch(rules, inner)("https://x")).rejects.toThrow("ECONNRESET");
    expect((inner as any).calls).toBe(2);
  });

  it("does not retry on 4xx that isn't auth or 429", async () => {
    const inner = scriptFetch([new Response("bad", { status: 400 })]);
    const res = await makeRetryFetch(DEFAULT_RETRY_RULES, inner)("https://x");
    expect(res.status).toBe(400);
    expect((inner as any).calls).toBe(1);
  });

  it("retries 5xx with exp backoff up to retryCount", async () => {
    const inner = scriptFetch([
      new Response("e", { status: 502 }),
      new Response("e", { status: 502 }),
      new Response("e", { status: 502 }),
    ]);
    const rules: RetryRule[] = [
      { cause: "temporary-error", action: "retry", retryCount: 2, backoffMs: 1 },
    ];
    const res = await makeRetryFetch(rules, inner)("https://x");
    expect(res.status).toBe(502);
    expect((inner as any).calls).toBe(3); // initial + 2 retries
  });

  it("hands fallback-action responses through without retry", async () => {
    const inner = scriptFetch([new Response("rl", { status: 429 })]);
    const rules: RetryRule[] = [
      { cause: "rate-limit", action: "fallback", fallbackToRouteLabel: "openai-backup" },
    ];
    const res = await makeRetryFetch(rules, inner)("https://x");
    expect(res.status).toBe(429);
    expect((inner as any).calls).toBe(1);
  });
});
