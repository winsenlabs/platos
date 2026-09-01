import { describe, expect, it } from "vitest";

import {
  DEFAULT_LOGIN_POLICY,
  DEFAULT_MFA_VERIFY_POLICY,
  LIMITER_UNAVAILABLE_POLICY,
  asResult,
  decide,
  decideOnLimiterFailure,
  isPermitted,
  isSameWindow,
  recordRequest,
  windowFor,
} from "./rate-limit.js";
import { MINUTE_MS, T0, aRateLimitBucket, at, tokenHash } from "./testing.js";

const identifier = tokenHash("identifier-hash");

describe("the window is fixed, so a bucket key is deterministic", () => {
  it("floors the instant to the window size", () => {
    const window = windowFor(at(37_000), DEFAULT_LOGIN_POLICY);
    expect(window.windowStart).toEqual(T0);
    expect(window.expiresAt).toEqual(at(MINUTE_MS));
  });

  it("gives every instant inside a minute the same window", () => {
    expect(windowFor(at(1), DEFAULT_LOGIN_POLICY).windowStart).toEqual(
      windowFor(at(59_999), DEFAULT_LOGIN_POLICY).windowStart,
    );
  });

  it("uses the policy's own window, not a global one", () => {
    const window = windowFor(at(4 * MINUTE_MS), DEFAULT_MFA_VERIFY_POLICY);
    expect(window.windowStart).toEqual(T0);
    expect(window.expiresAt).toEqual(at(5 * MINUTE_MS));
  });
});

describe("counting within a window", () => {
  it("starts a fresh budget at one", () => {
    const bucket = recordRequest(null, "LOGIN", identifier, T0, DEFAULT_LOGIN_POLICY);
    expect(bucket.requestCount).toBe(1);
    expect(bucket.windowStart).toEqual(T0);
  });

  it("increments an existing bucket inside the same window", () => {
    const first = recordRequest(null, "LOGIN", identifier, T0, DEFAULT_LOGIN_POLICY);
    const second = recordRequest(first, "LOGIN", identifier, at(30_000), DEFAULT_LOGIN_POLICY);
    expect(second.requestCount).toBe(2);
    expect(isSameWindow(second, windowFor(T0, DEFAULT_LOGIN_POLICY))).toBe(true);
  });

  it("RESETS WHEN THE WINDOW ROLLS OVER — the key changes, nothing decays", () => {
    const exhausted = aRateLimitBucket({ requestCount: 99, windowStart: T0 });
    const next = recordRequest(
      exhausted,
      "LOGIN",
      identifier,
      at(MINUTE_MS),
      DEFAULT_LOGIN_POLICY,
    );
    expect(next.requestCount).toBe(1);
    expect(next.windowStart).toEqual(at(MINUTE_MS));
    expect(next.expiresAt).toEqual(at(2 * MINUTE_MS));
  });
});

describe("the limit comparison", () => {
  it("admits the request that reaches the limit exactly", () => {
    const decision = decide(aRateLimitBucket({ requestCount: 10 }), DEFAULT_LOGIN_POLICY, T0);
    expect(decision).toEqual({ outcome: "allowed", remaining: 0 });
  });

  it("refuses the request after it, with a retry-after that reaches the boundary", () => {
    const bucket = aRateLimitBucket({ requestCount: 11, expiresAt: at(MINUTE_MS) });
    const decision = decide(bucket, DEFAULT_LOGIN_POLICY, at(30_500));
    expect(decision.outcome).toBe("limited");
    if (decision.outcome !== "limited") return;
    expect(decision.retryAfterSeconds).toBe(30);
    expect(isPermitted(decision)).toBe(false);
  });

  it("surfaces the refusal as a RATE_LIMITED error carrying the retry-after", () => {
    const bucket = aRateLimitBucket({ requestCount: 11, expiresAt: at(MINUTE_MS) });
    const result = asResult(decide(bucket, DEFAULT_LOGIN_POLICY, T0));
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe("RATE_LIMITED");
    expect(result.error.category).toBe("rate_limited");
    expect(result.error.retryAfterSeconds).toBe(60);
  });
});

describe("the documented behaviour when the limiter itself is unreachable", () => {
  it("is fail-open, and it is a named policy rather than a swallowed error", () => {
    expect(LIMITER_UNAVAILABLE_POLICY).toBe("allow");
  });

  it("reports a DEGRADED outcome, distinguishable from a healthy allow", () => {
    const decision = decideOnLimiterFailure();
    expect(decision).toEqual({ outcome: "degraded" });
    expect(isPermitted(decision)).toBe(true);
    expect(asResult(decision).ok).toBe(true);
  });
});
