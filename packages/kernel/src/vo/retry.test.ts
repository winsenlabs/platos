// The retry policy, and the bound it claims.
//
// A CEILING NOBODY SWEEPS IS A COMMENT. The boundedness cases below do not check
// one hand-picked wait against one hand-picked ceiling — that assertion compares
// two numbers the same test wrote and cannot fail. They sweep every retry number
// a policy can reach, for policies whose growth overflows to Infinity inside the
// swept range, and assert the ceiling holds for all of them AND that the ceiling
// is actually reached, so a `Math.min` quietly replaced by its left operand goes
// red rather than staying silently green on small inputs.

import { describe, expect, it } from "vitest";

import { isOk, unwrap } from "./error.js";
import {
  backoffMs,
  decideRetry,
  defineRetryPolicy,
  jitteredDelayMs,
  retryDueAtMs,
  totalDelayCeilingMs,
  RETRY_BASE_DELAY_INVALID,
  RETRY_CEILING_BELOW_BASE,
  RETRY_JITTER_INVALID,
  RETRY_MAX_SENDS_INVALID,
  RETRY_MULTIPLIER_INVALID,
  type RetryPolicy,
} from "./retry.js";

/** The schedule `eventing` runs today, restated as a policy. */
const EVENTING = unwrap(
  defineRetryPolicy({ maxSends: 3, baseDelayMs: 1000, multiplier: 2, ceilingMs: 30_000 }),
);

const FLAT = unwrap(
  defineRetryPolicy({ maxSends: 5, baseDelayMs: 250, multiplier: 1, ceilingMs: 250 }),
);

const JITTERED = unwrap(
  defineRetryPolicy({
    maxSends: 6,
    baseDelayMs: 100,
    multiplier: 3,
    ceilingMs: 5_000,
    jitterFraction: 0.5,
  }),
);

describe("defineRetryPolicy refuses five different mistakes with five codes", () => {
  it.each([
    ["zero sends", { maxSends: 0, baseDelayMs: 1, multiplier: 2, ceilingMs: 10 }, RETRY_MAX_SENDS_INVALID],
    ["a fractional send budget", { maxSends: 2.5, baseDelayMs: 1, multiplier: 2, ceilingMs: 10 }, RETRY_MAX_SENDS_INVALID],
    ["a negative first wait", { maxSends: 3, baseDelayMs: -1, multiplier: 2, ceilingMs: 10 }, RETRY_BASE_DELAY_INVALID],
    ["a fractional first wait", { maxSends: 3, baseDelayMs: 1.5, multiplier: 2, ceilingMs: 10 }, RETRY_BASE_DELAY_INVALID],
    ["growth below one", { maxSends: 3, baseDelayMs: 1, multiplier: 0.5, ceilingMs: 10 }, RETRY_MULTIPLIER_INVALID],
    ["growth that is not finite", { maxSends: 3, baseDelayMs: 1, multiplier: Number.POSITIVE_INFINITY, ceilingMs: 10 }, RETRY_MULTIPLIER_INVALID],
    ["a ceiling below the first wait", { maxSends: 3, baseDelayMs: 100, multiplier: 2, ceilingMs: 99 }, RETRY_CEILING_BELOW_BASE],
    ["a fractional ceiling", { maxSends: 3, baseDelayMs: 1, multiplier: 2, ceilingMs: 10.5 }, RETRY_CEILING_BELOW_BASE],
    ["jitter above one", { maxSends: 3, baseDelayMs: 1, multiplier: 2, ceilingMs: 10, jitterFraction: 1.5 }, RETRY_JITTER_INVALID],
    ["jitter below zero", { maxSends: 3, baseDelayMs: 1, multiplier: 2, ceilingMs: 10, jitterFraction: -0.1 }, RETRY_JITTER_INVALID],
  ])("refuses %s", (_label, draft, code) => {
    const outcome = defineRetryPolicy(draft);
    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(outcome.error.code).toBe(code);
  });

  it("mints five DISTINCT codes, so two mistakes are never one log line", () => {
    const codes = new Set([
      RETRY_MAX_SENDS_INVALID,
      RETRY_BASE_DELAY_INVALID,
      RETRY_MULTIPLIER_INVALID,
      RETRY_CEILING_BELOW_BASE,
      RETRY_JITTER_INVALID,
    ]);
    expect(codes.size).toBe(5);
  });

  it("names the offending field on every refusal", () => {
    const outcome = defineRetryPolicy({ maxSends: 3, baseDelayMs: 1, multiplier: 0, ceilingMs: 10 });
    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(outcome.error.fields.map((violation) => violation.field)).toEqual(["multiplier"]);
  });

  it("accepts a policy that never retries at all", () => {
    const outcome = defineRetryPolicy({ maxSends: 1, baseDelayMs: 0, multiplier: 1, ceilingMs: 0 });
    expect(isOk(outcome)).toBe(true);
  });

  it("accepts a ceiling exactly equal to the first wait", () => {
    expect(isOk(defineRetryPolicy({ maxSends: 2, baseDelayMs: 500, multiplier: 1, ceilingMs: 500 }))).toBe(true);
  });

  it("defaults jitter to none when the draft does not say", () => {
    expect(EVENTING.jitterFraction).toBe(0);
  });

  it("freezes the policy it returns", () => {
    expect(Object.isFrozen(EVENTING)).toBe(true);
  });
});

describe("backoff grows and then stops growing", () => {
  it("charges one factor of growth on the FIRST retry", () => {
    // The surprising half of the legacy eventing schedule: two seconds, not one.
    expect(backoffMs(EVENTING, 1)).toBe(2000);
  });

  it("doubles on the second", () => {
    expect(backoffMs(EVENTING, 2)).toBe(4000);
  });

  it("answers zero for a retry number at or below zero", () => {
    expect([backoffMs(EVENTING, 0), backoffMs(EVENTING, -3)]).toEqual([0, 0]);
  });

  it("stays flat when growth is one", () => {
    expect([1, 2, 3, 4].map((retryCount) => backoffMs(FLAT, retryCount))).toEqual([250, 250, 250, 250]);
  });

  it("never exceeds the ceiling anywhere in a sweep that overflows growth", () => {
    // 2^1024 is Infinity in a double. The sweep runs past that on purpose: a
    // ceiling that holds only while the arithmetic is finite is not a ceiling.
    const over: number[] = [];
    for (let retryCount = 1; retryCount <= 1200; retryCount += 1) {
      const delay = backoffMs(EVENTING, retryCount);
      if (delay > EVENTING.ceilingMs) over.push(retryCount);
    }
    expect(over).toEqual([]);
  });

  it("actually REACHES the ceiling, so the clamp is doing work", () => {
    const reached = [1, 2, 3, 4, 5, 6, 7, 8].filter(
      (retryCount) => backoffMs(EVENTING, retryCount) === EVENTING.ceilingMs,
    );
    // 2^5 * 1000 = 32000 is the first wait above 30000.
    expect(reached[0]).toBe(5);
  });

  it("returns a whole number of milliseconds for a fractional multiplier", () => {
    const policy = unwrap(
      defineRetryPolicy({ maxSends: 9, baseDelayMs: 100, multiplier: 1.5, ceilingMs: 100_000 }),
    );
    const waits = [1, 2, 3, 4].map((retryCount) => backoffMs(policy, retryCount));
    expect(waits).toEqual([150, 225, 338, 506]);
    expect(waits.every((wait) => Number.isInteger(wait))).toBe(true);
  });
});

describe("decideRetry spends a bounded budget", () => {
  it("gives up at the budget, not one send later", () => {
    expect(decideRetry(EVENTING, 2)).toEqual({ kind: "give-up", retryCount: 3, reason: "budget_spent" });
  });

  it("retries below the budget", () => {
    expect(decideRetry(EVENTING, 0)).toEqual({ kind: "retry", retryCount: 1, delayMs: 2000 });
    expect(decideRetry(EVENTING, 1)).toEqual({ kind: "retry", retryCount: 2, delayMs: 4000 });
  });

  it("gives up immediately for a policy that allows one send", () => {
    const once = unwrap(defineRetryPolicy({ maxSends: 1, baseDelayMs: 10, multiplier: 2, ceilingMs: 10 }));
    expect(decideRetry(once, 0).kind).toBe("give-up");
  });

  it("gives up for every failed count at or beyond the budget", () => {
    const kinds = [2, 3, 10, 5000].map((failedCount) => decideRetry(EVENTING, failedCount).kind);
    expect(kinds).toEqual(["give-up", "give-up", "give-up", "give-up"]);
  });

  it("yields exactly maxSends - 1 retries before giving up", () => {
    const policy = unwrap(defineRetryPolicy({ maxSends: 7, baseDelayMs: 5, multiplier: 2, ceilingMs: 500 }));
    let failedCount = 0;
    let retries = 0;
    while (decideRetry(policy, failedCount).kind === "retry" && retries < 100) {
      retries += 1;
      failedCount += 1;
    }
    expect(retries).toBe(policy.maxSends - 1);
  });

  it("names the reason it stopped rather than answering a bare kind", () => {
    const decision = decideRetry(FLAT, 4);
    expect(decision.kind === "give-up" ? decision.reason : null).toBe("budget_spent");
  });
});

describe("jitter only ever subtracts", () => {
  it("returns the wait untouched when the policy has no jitter", () => {
    expect(jitteredDelayMs(EVENTING, 4000, 0)).toBe(4000);
    expect(jitteredDelayMs(EVENTING, 4000, 1)).toBe(4000);
  });

  it("puts the top of the band at the un-jittered wait", () => {
    expect(jitteredDelayMs(JITTERED, 1000, 1)).toBe(1000);
  });

  it("puts the bottom of the band at (1 - jitterFraction) of the wait", () => {
    expect(jitteredDelayMs(JITTERED, 1000, 0)).toBe(500);
  });

  it("stays inside the band for every draw across a sweep", () => {
    const outside: number[] = [];
    for (let step = 0; step <= 1000; step += 1) {
      const spread = step / 1000;
      const jittered = jitteredDelayMs(JITTERED, 1000, spread);
      if (jittered < 500 || jittered > 1000) outside.push(spread);
    }
    expect(outside).toEqual([]);
  });

  it("clamps a draw outside [0, 1] rather than refusing to schedule", () => {
    // A BAD DRAW MUST NOT LOSE A MESSAGE. Refusing here would turn a random
    // number out of range into an un-sent notification.
    expect([
      jitteredDelayMs(JITTERED, 1000, -5),
      jitteredDelayMs(JITTERED, 1000, 5),
      jitteredDelayMs(JITTERED, 1000, Number.NaN),
    ]).toEqual([500, 1000, 500]);
  });

  it("is monotonic in the draw", () => {
    const waits = [0, 0.25, 0.5, 0.75, 1].map((spread) => jitteredDelayMs(JITTERED, 800, spread));
    const sorted = [...waits].sort((left, right) => left - right);
    expect(waits).toEqual(sorted);
  });
});

describe("the bound is stated as arithmetic, not as a promise", () => {
  it("is (maxSends - 1) ceilings", () => {
    expect(totalDelayCeilingMs(EVENTING)).toBe(2 * 30_000);
  });

  it("is zero for a policy that never retries", () => {
    const once = unwrap(defineRetryPolicy({ maxSends: 1, baseDelayMs: 10, multiplier: 2, ceilingMs: 10 }));
    expect(totalDelayCeilingMs(once)).toBe(0);
  });

  it("dominates the real sum of every wait a policy can schedule, jitter included", () => {
    // JOINS THE BOUND TO THE SCHEDULE, not to another constant. Anything that
    // makes a wait exceed its ceiling, or makes the budget yield more retries
    // than it says, breaks this without touching the bound's own arithmetic.
    const policies: readonly RetryPolicy[] = [EVENTING, FLAT, JITTERED];
    for (const policy of policies) {
      let failedCount = 0;
      let total = 0;
      for (;;) {
        const decision = decideRetry(policy, failedCount);
        if (decision.kind === "give-up") break;
        total += jitteredDelayMs(policy, decision.delayMs, 1);
        failedCount += 1;
        if (failedCount > 1000) break;
      }
      expect(total).toBeLessThanOrEqual(totalDelayCeilingMs(policy));
    }
  });
});

describe("retryDueAtMs takes the instant instead of reading one", () => {
  it("adds the wait to the instant it was handed", () => {
    const now = new Date("2026-05-01T09:00:00.000Z");
    expect(retryDueAtMs(now, 2000)).toBe(now.getTime() + 2000);
  });

  it("answers a number, because the kernel may not construct a Date", () => {
    expect(typeof retryDueAtMs(new Date(0), 1)).toBe("number");
  });
});
