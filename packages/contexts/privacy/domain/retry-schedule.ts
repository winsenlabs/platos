// When an unsettled operation is picked up again, and who is allowed to pick it.
//
// THE DEFECT THIS EXISTS TO FIX
//
// A target that did not settle used to be abandoned. The record said so honestly
// — `partial_failure`, with the failing target named — and then nothing ever
// looked at that row again. The only way to finish an erasure was for a human to
// notice. And if the process died between creating the row and persisting the
// outcomes, the row sat at `pending` with no outcomes forever, indistinguishable
// from an erasure that was requested and never started.
//
// So an operation is LEASED AND SCHEDULED FROM BIRTH. If the first pass dies,
// the lease expires and `nextRetryAt` has already made the row due.
//
// BACKOFF IS DETERMINISTIC RATHER THAN JITTERED. These are rare, operator-
// visible operations, not a high-fanout retry storm, and a predictable
// `nextRetryAt` is one an operator can reason about and a test can assert.
//
// EVERY DESTRUCTIVE PASS RUNS UNDER A LEASE, INCLUDING THE FIRST. That is what
// makes retry idempotent: two concurrent resumes cannot both sweep, and a pass
// whose process died leaves an expiring lease the queue reclaims rather than a
// row nobody dares touch.

import type { PrivacyRetryPolicy } from "./policy.js";
import type { ErasureStatus } from "./erasure-operation.js";

/**
 * Delay before retry N+1, doubling and capped.
 *
 * The exponent is capped as well as the result: `2 ** 1024` is `Infinity`, and
 * `Infinity * 0` is `NaN`, which would produce an `Invalid Date` the scheduler
 * cannot compare.
 */
export function backoffMs(retryCount: number, policy: PrivacyRetryPolicy): number {
  const exponent = Math.max(0, Math.floor(retryCount) - 1);
  const scaled = policy.baseBackoffMs * 2 ** Math.min(exponent, 32);
  return Math.min(scaled, policy.maxBackoffMs);
}

/** True once the queue should stop re-driving and wait for an operator. */
export function isExhausted(retryCount: number, policy: PrivacyRetryPolicy): boolean {
  return retryCount >= policy.maxRetries;
}

export type ScheduleReason = "settled" | "blocked" | "exhausted" | "scheduled";

export interface RetrySchedule {
  readonly nextRetryAt: Date | null;
  readonly reason: ScheduleReason;
}

/**
 * When the operation should next be picked up, or null when it should not be.
 *
 * Null is not "abandoned": the row keeps its outcomes and its retry count, and
 * the operator-driven retry still works. It only means the queue stops
 * re-driving something that has failed the same way N times, because the N+1th
 * automated pass teaches nobody anything.
 */
export function scheduleAfterPass(
  operation: { readonly status: ErasureStatus; readonly retryCount: number },
  now: Date,
  policy: PrivacyRetryPolicy,
): RetrySchedule {
  if (operation.status === "completed") return { nextRetryAt: null, reason: "settled" };
  if (operation.status === "blocked_legal_hold") return { nextRetryAt: null, reason: "blocked" };
  if (isExhausted(operation.retryCount, policy)) return { nextRetryAt: null, reason: "exhausted" };
  return {
    nextRetryAt: new Date(now.getTime() + backoffMs(operation.retryCount, policy)),
    reason: "scheduled",
  };
}

/** Lease expiry for a pass starting now. */
export function leaseUntil(now: Date, policy: PrivacyRetryPolicy): Date {
  return new Date(now.getTime() + policy.leaseTtlMs);
}

/**
 * Whether a lease is free to take.
 *
 * A lease expiring exactly now is free — the complement of `leaseUntil`, which
 * always returns an instant strictly after `now` for a positive TTL. Reversing
 * this comparison would leave a crashed pass's lease held for one extra tick and
 * would make the boundary untestable at an exact instant.
 */
export function isLeaseFree(leaseExpiresAt: Date | null, now: Date): boolean {
  return leaseExpiresAt === null || leaseExpiresAt.getTime() <= now.getTime();
}
