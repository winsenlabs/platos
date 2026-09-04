import { describe, expect, it } from "vitest";

import {
  DEFAULT_RETRY_POLICY,
  DEFAULT_RETRY_RULES,
  MAX_BACKOFF_MS,
  backoffFor,
  classifyStatus,
  parseRetryAfter,
  retryPolicy,
  retryingTransport,
  type HttpTransport,
  type RetryRule,
  type TransportClock,
} from "./transport.js";

/** A clock that records what it was asked to wait for and never waits. */
function recordingClock(now = 1_000_000): { clock: TransportClock; waits: number[] } {
  const waits: number[] = [];
  return {
    waits,
    clock: {
      wait: (milliseconds: number) => {
        waits.push(milliseconds);
        return Promise.resolve();
      },
      now: () => now,
    },
  };
}

/** A transport that answers a scripted sequence and counts its calls. */
function scripted(...answers: readonly (Response | Error)[]): HttpTransport & { calls: () => number } {
  let index = 0;
  const transport = (() => {
    const answer = answers[Math.min(index, answers.length - 1)];
    index += 1;
    if (answer instanceof Error) return Promise.reject(answer);
    return Promise.resolve(answer as Response);
  }) as HttpTransport & { calls: () => number };
  transport.calls = () => index;
  return transport;
}

function answer(status: number, headers: Record<string, string> = {}): Response {
  return new Response(status === 204 ? null : "{}", { status, headers });
}

const RETRY_EVERYTHING: readonly RetryRule[] = [
  { cause: "rate-limit", action: "retry", retryCount: 2, backoffMs: 100, backoffMultiplier: 2 },
  { cause: "temporary-error", action: "retry", retryCount: 2, backoffMs: 100, backoffMultiplier: 2 },
  { cause: "auth-error", action: "retry", retryCount: 3, backoffMs: 100 },
  { cause: "network-error", action: "retry", retryCount: 1, backoffMs: 50 },
];

describe("classifying a status", () => {
  it("names each cause the taxonomy covers", () => {
    expect(classifyStatus(429)).toBe("rate-limit");
    for (const status of [408, 500, 502, 503, 504]) {
      expect(classifyStatus(status)).toBe("temporary-error");
    }
    expect(classifyStatus(401)).toBe("auth-error");
    expect(classifyStatus(403)).toBe("auth-error");
  });

  it("names nothing for a status no rule can improve", () => {
    for (const status of [400, 404, 409, 422]) expect(classifyStatus(status)).toBeNull();
  });
});

describe("the policy guard", () => {
  it("accepts the default rules", () => {
    const checked = retryPolicy(DEFAULT_RETRY_RULES);

    expect(checked.ok).toBe(true);
  });

  it("refuses a negative retry count", () => {
    const checked = retryPolicy([{ cause: "rate-limit", action: "retry", retryCount: -1 }]);

    expect(checked.ok).toBe(false);
    if (checked.ok) throw new Error("unreachable");
    expect(checked.error.code).toBe("PROVIDERS_RETRY_POLICY_INVALID");
    expect(checked.error.details.field).toBe("retryCount");
  });

  it("refuses a fractional retry count", () => {
    const checked = retryPolicy([{ cause: "rate-limit", action: "retry", retryCount: 1.5 }]);

    expect(checked.ok).toBe(false);
    if (checked.ok) throw new Error("unreachable");
    expect(checked.error.details.field).toBe("retryCount");
  });

  it("refuses a negative backoff", () => {
    const checked = retryPolicy([{ cause: "rate-limit", action: "retry", backoffMs: -1 }]);

    expect(checked.ok).toBe(false);
    if (checked.ok) throw new Error("unreachable");
    expect(checked.error.details.field).toBe("backoffMs");
  });

  it("refuses a shrinking multiplier, which would make later retries fire sooner", () => {
    const checked = retryPolicy([{ cause: "rate-limit", action: "retry", backoffMultiplier: 0.5 }]);

    expect(checked.ok).toBe(false);
    if (checked.ok) throw new Error("unreachable");
    expect(checked.error.details.field).toBe("backoffMultiplier");
  });

  it("refuses two rules for one cause, which would leave one of them dead", () => {
    const checked = retryPolicy([
      { cause: "rate-limit", action: "retry" },
      { cause: "rate-limit", action: "fail" },
    ]);

    expect(checked.ok).toBe(false);
    if (checked.ok) throw new Error("unreachable");
    expect(checked.error.details.field).toBe("cause");
  });

  it("refuses a cause and an action it does not know", () => {
    const badCause = retryPolicy([{ cause: "meteor" as RetryRule["cause"], action: "retry" }]);
    const badAction = retryPolicy([{ cause: "rate-limit", action: "panic" as RetryRule["action"] }]);

    expect(badCause.ok).toBe(false);
    expect(badAction.ok).toBe(false);
  });
});

describe("the backoff", () => {
  it("multiplies from the first wait", () => {
    const rule: RetryRule = { cause: "rate-limit", action: "retry", backoffMs: 500, backoffMultiplier: 2 };

    expect(backoffFor(rule, 1)).toBe(500);
    expect(backoffFor(rule, 2)).toBe(1_000);
    expect(backoffFor(rule, 3)).toBe(2_000);
  });

  it("is capped, so an exponential policy cannot hold a request open forever", () => {
    const rule: RetryRule = { cause: "rate-limit", action: "retry", backoffMs: 500, backoffMultiplier: 10 };

    expect(backoffFor(rule, 6)).toBe(MAX_BACKOFF_MS);
  });
});

describe("Retry-After", () => {
  const NOW = 1_700_000_000_000;

  it("reads a seconds value", () => {
    expect(parseRetryAfter("7", NOW)).toBe(7_000);
  });

  it("reads an HTTP-date", () => {
    expect(parseRetryAfter(new Date(NOW + 5_000).toUTCString(), NOW)).toBe(5_000);
  });

  it("reads a date already in the past as no wait at all", () => {
    expect(parseRetryAfter(new Date(NOW - 5_000).toUTCString(), NOW)).toBe(0);
  });

  it("caps a pathological value at thirty seconds", () => {
    // Some hosts answer a 429 with a whole day. A client that honoured it would
    // hold the request open until the caller gave up.
    expect(parseRetryAfter("86400", NOW)).toBe(MAX_BACKOFF_MS);
  });

  it("reports nothing for a header it cannot read", () => {
    expect(parseRetryAfter(null, NOW)).toBeNull();
    expect(parseRetryAfter("   ", NOW)).toBeNull();
    expect(parseRetryAfter("soon", NOW)).toBeNull();
  });
});

describe("the retrying transport", () => {
  it("returns the first success without waiting", async () => {
    const { clock, waits } = recordingClock();
    const base = scripted(answer(200));

    const response = await retryingTransport(DEFAULT_RETRY_POLICY, base, clock)("https://x");

    expect(response.status).toBe(200);
    expect(base.calls()).toBe(1);
    expect(waits).toEqual([]);
  });

  it("retries a 429 up to the rule's count and then hands back the last response", async () => {
    const { clock, waits } = recordingClock();
    const base = scripted(answer(429), answer(429), answer(429));
    const policy = retryPolicy(RETRY_EVERYTHING);
    if (!policy.ok) throw new Error("fixture policy is invalid");

    const response = await retryingTransport(policy.value, base, clock)("https://x");

    expect(response.status).toBe(429);
    // retryCount 2 means three calls in total: the first plus two retries.
    expect(base.calls()).toBe(3);
    expect(waits).toEqual([100, 200]);
  });

  it("stops at the retry count instead of looping forever", async () => {
    const { clock, waits } = recordingClock();
    const base = scripted(answer(503));
    const policy = retryPolicy([
      { cause: "temporary-error", action: "retry", retryCount: 4, backoffMs: 10, backoffMultiplier: 1 },
    ]);
    if (!policy.ok) throw new Error("fixture policy is invalid");

    await retryingTransport(policy.value, base, clock)("https://x");

    expect(base.calls()).toBe(5);
    expect(waits).toEqual([10, 10, 10, 10]);
  });

  it("fails an auth error at once under the default policy", async () => {
    const { clock, waits } = recordingClock();
    const base = scripted(answer(401));

    const response = await retryingTransport(DEFAULT_RETRY_POLICY, base, clock)("https://x");

    expect(response.status).toBe(401);
    expect(base.calls()).toBe(1);
    expect(waits).toEqual([]);
  });

  it("hands a `fallback` failure straight back so something above can re-route", async () => {
    const { clock, waits } = recordingClock();
    const base = scripted(answer(429));
    const policy = retryPolicy([{ cause: "rate-limit", action: "fallback" }]);
    if (!policy.ok) throw new Error("fixture policy is invalid");

    const response = await retryingTransport(policy.value, base, clock)("https://x");

    expect(response.status).toBe(429);
    expect(base.calls()).toBe(1);
    expect(waits).toEqual([]);
  });

  it("hands back a status no rule covers without retrying it", async () => {
    const { clock } = recordingClock();
    const base = scripted(answer(404));

    const response = await retryingTransport(DEFAULT_RETRY_POLICY, base, clock)("https://x");

    expect(response.status).toBe(404);
    expect(base.calls()).toBe(1);
  });

  it("hands back a classified failure no rule names", async () => {
    const { clock } = recordingClock();
    const base = scripted(answer(429));
    const policy = retryPolicy([{ cause: "network-error", action: "retry" }]);
    if (!policy.ok) throw new Error("fixture policy is invalid");

    const response = await retryingTransport(policy.value, base, clock)("https://x");

    expect(response.status).toBe(429);
    expect(base.calls()).toBe(1);
  });

  it("retries a network failure and rethrows it once the budget is spent", async () => {
    const { clock, waits } = recordingClock();
    const base = scripted(new Error("ECONNRESET"));

    await expect(retryingTransport(DEFAULT_RETRY_POLICY, base, clock)("https://x")).rejects.toThrow(
      "ECONNRESET",
    );
    // The default network rule allows one retry: two calls, one wait.
    expect(base.calls()).toBe(2);
    expect(waits).toEqual([250]);
  });

  it("honours Retry-After in place of the computed backoff", async () => {
    const { clock, waits } = recordingClock();
    const base = scripted(answer(429, { "retry-after": "3" }), answer(200));

    const response = await retryingTransport(DEFAULT_RETRY_POLICY, base, clock)("https://x");

    expect(response.status).toBe(200);
    expect(waits).toEqual([3_000]);
  });

  it("ignores Retry-After when the rule does not ask for it", async () => {
    const { clock, waits } = recordingClock();
    const base = scripted(answer(429, { "retry-after": "3" }), answer(200));
    const policy = retryPolicy(RETRY_EVERYTHING);
    if (!policy.ok) throw new Error("fixture policy is invalid");

    await retryingTransport(policy.value, base, clock)("https://x");

    expect(waits).toEqual([100]);
  });

  it("drains a failed body before retrying, so a 5xx storm cannot leak sockets", async () => {
    const { clock } = recordingClock();
    const failing = new Response("body", { status: 503 });
    const base = scripted(failing, answer(200));

    await retryingTransport(DEFAULT_RETRY_POLICY, base, clock)("https://x");

    expect(failing.bodyUsed).toBe(true);
  });
});
