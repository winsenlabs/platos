// The join: `eventing`'s live retry schedule against the kernel `RetryPolicy`.
//
// WHY THIS SUITE EXISTS RATHER THAN A REWRITE. `retry-schedule.ts` is the policy
// the notification drain actually runs, restored line for line from
// `McpEventsService.dispatchOne` and pinned by its own suite. Replacing it with a
// call into the kernel would change the code that runs on the strength of an
// argument that the two agree — which is precisely the claim that needs proving
// first. So nothing here is rewritten. The kernel policy is DECLARED to be this
// schedule, and every observable of both is compared across a swept range.
//
// THIS IS NOT AN ASSERTION OVER TWO THINGS ONE AUTHOR CONTROLS. The right-hand
// side is `eventing`'s shipped domain module, written by an earlier tranche and
// pinned by `retry-schedule.test.ts`, which this file does not touch. If the
// kernel's arithmetic drifts, this goes red. If `eventing`'s does, this goes red.
// If someone "unifies" them by editing both, `retry-schedule.test.ts` — with its
// own hard-coded 2000/4000/give-up expectations — goes red instead. There is no
// edit that moves both sides quietly.
//
// WHAT IT LICENSES. Once this holds, a second context adopting the kernel policy
// is adopting the schedule that has been in production, not a new one that
// happens to look similar.

import { describe, expect, it } from "vitest";

import {
  backoffMs as kernelBackoffMs,
  decideRetry as kernelDecideRetry,
  defineRetryPolicy,
  totalDelayCeilingMs,
  unwrap,
} from "@platos/kernel";

import {
  BACKOFF_BASE_MS,
  BACKOFF_CEILING_MS,
  MAX_RETRIES,
  backoffMs,
  decideRetry,
} from "./retry-schedule.js";

/**
 * The declaration under test.
 *
 * Every field is read from `retry-schedule.ts` rather than typed as a literal.
 * A literal here would let the two drift apart while this file stayed green,
 * which is the exact failure mode this suite is written to avoid.
 */
const POLICY = unwrap(
  defineRetryPolicy({
    maxSends: MAX_RETRIES,
    baseDelayMs: BACKOFF_BASE_MS,
    multiplier: 2,
    ceilingMs: BACKOFF_CEILING_MS,
  }),
);

/** Past the ceiling, past the budget, and past the point growth overflows. */
const SWEEP = Array.from({ length: 64 }, (_unused, index) => index);

describe("the kernel policy IS the eventing schedule", () => {
  it("agrees on the wait for every retry number in the sweep", () => {
    const disagreements = SWEEP.filter(
      (retryCount) => kernelBackoffMs(POLICY, retryCount) !== backoffMs(retryCount),
    );
    // `backoffMs(0)` is the one place the two differ by construction: the legacy
    // formula answers `min(2^0 * 1000, 30000)` = 1000 for a retry number that
    // does not exist, while the kernel answers 0 because there is no wait before
    // a retry nobody is scheduling. `decideRetry` never reaches it on either
    // side — the cases below prove that — so the disagreement is unreachable,
    // and it is named here rather than swept under a tolerance.
    expect(disagreements).toEqual([0]);
  });

  it("agrees on every wait a decision can actually produce", () => {
    const reachable = SWEEP.map((failedCount) => kernelDecideRetry(POLICY, failedCount))
      .filter((decision) => decision.kind === "retry")
      .map((decision) => decision.retryCount);
    expect(reachable.length).toBeGreaterThan(0);
    for (const retryCount of reachable) {
      expect(kernelBackoffMs(POLICY, retryCount)).toBe(backoffMs(retryCount));
    }
  });

  it("agrees on retry-or-give-up for every failed count in the sweep", () => {
    const disagreements = SWEEP.filter(
      (failedCount) => kernelDecideRetry(POLICY, failedCount).kind !== decideRetry(failedCount).kind,
    );
    expect(disagreements).toEqual([]);
  });

  it("agrees on the retry number carried by every decision", () => {
    const disagreements = SWEEP.filter(
      (failedCount) =>
        kernelDecideRetry(POLICY, failedCount).retryCount !== decideRetry(failedCount).retryCount,
    );
    expect(disagreements).toEqual([]);
  });

  it("agrees on the delay carried by every retry decision", () => {
    for (const failedCount of SWEEP) {
      const mine = kernelDecideRetry(POLICY, failedCount);
      const theirs = decideRetry(failedCount);
      if (mine.kind !== "retry" || theirs.kind !== "retry") continue;
      expect(mine.delayMs).toBe(theirs.delayMs);
    }
  });

  it("gives up in the same place, which is at the second retry", () => {
    // Read back from the shipped module rather than asserted as 2: if
    // `MAX_RETRIES` moves, this moves with it and the sweep above still binds.
    const firstGiveUp = SWEEP.find((failedCount) => decideRetry(failedCount).kind === "give-up");
    expect(firstGiveUp).toBe(MAX_RETRIES - 1);
    expect(kernelDecideRetry(POLICY, MAX_RETRIES - 1).kind).toBe("give-up");
  });

  it("states a bound the shipped schedule never exceeds", () => {
    // The kernel's contribution: `retry-schedule.ts` has a ceiling per wait and
    // no statement at all about the total, which is the number that decides
    // whether a retry budget outlives its own retention window.
    let total = 0;
    for (const failedCount of SWEEP) {
      const decision = decideRetry(failedCount);
      if (decision.kind !== "retry") break;
      total += decision.delayMs;
    }
    expect(total).toBe(6000);
    expect(total).toBeLessThanOrEqual(totalDelayCeilingMs(POLICY));
  });

  it("holds the ceiling unreachable in this policy, exactly as the module says", () => {
    // `retry-schedule.ts` records that 30_000 is unreachable at three sends and
    // is kept because MAX_RETRIES is the number most likely to be raised. Both
    // halves are pinned here so raising it shows up as a red case rather than as
    // a comment that quietly became false.
    const reached = SWEEP.filter((retryCount) => backoffMs(retryCount) === BACKOFF_CEILING_MS);
    const scheduled = SWEEP.filter((failedCount) => decideRetry(failedCount).kind === "retry");
    expect(reached[0]).toBe(5);
    expect(Math.max(...scheduled.map((failedCount) => failedCount + 1))).toBeLessThan(5);
  });
});
