// The retry policy: how long to wait before sending again, and when to stop.
//
// WHY THIS IS A KERNEL VALUE OBJECT AND NOT A HELPER IN EACH CONTEXT.
//
// Four retry schedules already exist in this tree and no two of them are written
// the same way. `eventing` has an exponential schedule with a ceiling
// (`domain/retry-schedule.ts`); `cost-monitoring` has a FLAT
// `retryBackoffSeconds` on its delivery terms; `observability` bounds a drain
// pass by rows and wall clock; `privacy` re-runs an erasure sweep. Each is
// correct for its own queue, and none of them could state the property an
// operator actually needs — that the wait is BOUNDED, and by what.
//
// A bound is the whole point of a retry policy. Unbounded exponential growth
// turns a downstream outage into a queue nobody can drain: the tail's next send
// is scheduled beyond the retention window, so the row is pruned before it is
// ever sent again and the failure is silently converted into data loss. Every
// policy expressible here has a ceiling per wait and therefore a ceiling on the
// whole sequence, and `totalDelayCeilingMs` states that number so a caller can
// compare it against the window it actually has.
//
// TIME IS A PARAMETER, NEVER A READING. Nothing here calls a clock; `dueAt`
// takes the instant. ADR M0.3 §5.3 forbids the kernel from reading the wall
// clock at all, and the same discipline is what lets "the third failure is
// permanent" be a test rather than three real failed sends.
//
// JITTER IS A PARAMETER TOO, AND FOR THE SAME REASON. `Math.random()` inside a
// backoff makes the schedule untestable and the kernel impure. The caller passes
// a fraction in [0, 1) drawn from wherever it draws randomness, and `spread`
// maps it into the window. A suite passes 0 and 1 and reads the exact edges of
// the band; production passes a random draw and gets the herd-breaking spread
// that is the only reason jitter exists.

import { domainError, err, ok, type Result } from "./error.js";

/** A policy refused because it would send zero or fewer times. */
export const RETRY_MAX_SENDS_INVALID = "RETRY_POLICY_MAX_SENDS_INVALID";

/** A policy refused because its first wait is negative or not a whole number. */
export const RETRY_BASE_DELAY_INVALID = "RETRY_POLICY_BASE_DELAY_INVALID";

/** A policy refused because growth below 1 shrinks the wait on every failure. */
export const RETRY_MULTIPLIER_INVALID = "RETRY_POLICY_MULTIPLIER_INVALID";

/** A policy refused because its ceiling is below its own first wait. */
export const RETRY_CEILING_BELOW_BASE = "RETRY_POLICY_CEILING_BELOW_BASE";

/** A policy refused because its jitter band is outside [0, 1]. */
export const RETRY_JITTER_INVALID = "RETRY_POLICY_JITTER_FRACTION_INVALID";

/**
 * A validated, bounded retry schedule.
 *
 * Only `defineRetryPolicy` produces one, so every value a caller holds has
 * already been through the five refusals above.
 */
export interface RetryPolicy {
  /** TOTAL sends, first included. `1` means send once and never retry. */
  readonly maxSends: number;
  /** The wait before the FIRST retry, before growth and before jitter. */
  readonly baseDelayMs: number;
  /** Growth per retry. `1` is a flat schedule; `2` doubles. Never below 1. */
  readonly multiplier: number;
  /** The per-wait ceiling. Never below `baseDelayMs`. */
  readonly ceilingMs: number;
  /** The fraction of a wait that jitter may remove, in [0, 1]. `0` is none. */
  readonly jitterFraction: number;
}

export interface RetryPolicyDraft {
  readonly maxSends: number;
  readonly baseDelayMs: number;
  readonly multiplier: number;
  readonly ceilingMs: number;
  /** Optional; a policy that does not say is a policy without jitter. */
  readonly jitterFraction?: number;
}

/** What to do after a send that had already failed `failedCount` times fails. */
export type RetryDecision =
  | {
      readonly kind: "retry";
      /** 1-based: the number of the retry now being scheduled. */
      readonly retryCount: number;
      /** The wait, before jitter. Never above `ceilingMs`. */
      readonly delayMs: number;
    }
  | {
      readonly kind: "give-up";
      readonly retryCount: number;
      /** Why. One reason today; naming it keeps a second one from being silent. */
      readonly reason: "budget_spent";
    };

function isWholeAtLeast(value: number, minimum: number): boolean {
  return Number.isInteger(value) && value >= minimum;
}

/**
 * Validate a draft into a policy.
 *
 * The five refusals carry five distinct codes on purpose. A ceiling below the
 * base and a multiplier below 1 are different mistakes with different fixes, and
 * a single shared `RETRY_POLICY_INVALID` would make an operator read the source
 * to find out which one they made — which is how two defects hid behind one code
 * in `privacy` and in `identity-access`.
 */
export function defineRetryPolicy(draft: RetryPolicyDraft): Result<RetryPolicy> {
  if (!isWholeAtLeast(draft.maxSends, 1)) {
    return err(
      domainError(
        RETRY_MAX_SENDS_INVALID,
        "invalid_input",
        "a retry policy must allow at least one whole send",
        { fields: [{ field: "maxSends", code: RETRY_MAX_SENDS_INVALID, message: "must be a whole number of at least 1" }] },
      ),
    );
  }
  if (!isWholeAtLeast(draft.baseDelayMs, 0)) {
    return err(
      domainError(
        RETRY_BASE_DELAY_INVALID,
        "invalid_input",
        "a retry policy's first wait must be a whole number of milliseconds, not negative",
        { fields: [{ field: "baseDelayMs", code: RETRY_BASE_DELAY_INVALID, message: "must be a whole number of at least 0" }] },
      ),
    );
  }
  if (!Number.isFinite(draft.multiplier) || draft.multiplier < 1) {
    return err(
      domainError(
        RETRY_MULTIPLIER_INVALID,
        "invalid_input",
        "a retry policy's growth must be finite and at least 1; below 1 the wait shrinks as the failure persists",
        { fields: [{ field: "multiplier", code: RETRY_MULTIPLIER_INVALID, message: "must be finite and at least 1" }] },
      ),
    );
  }
  if (!isWholeAtLeast(draft.ceilingMs, 0) || draft.ceilingMs < draft.baseDelayMs) {
    return err(
      domainError(
        RETRY_CEILING_BELOW_BASE,
        "invalid_input",
        "a retry policy's ceiling must be a whole number of milliseconds and at least its own first wait",
        { fields: [{ field: "ceilingMs", code: RETRY_CEILING_BELOW_BASE, message: "must be a whole number at least baseDelayMs" }] },
      ),
    );
  }
  const jitterFraction = draft.jitterFraction ?? 0;
  if (!Number.isFinite(jitterFraction) || jitterFraction < 0 || jitterFraction > 1) {
    return err(
      domainError(
        RETRY_JITTER_INVALID,
        "invalid_input",
        "a retry policy's jitter band must be a fraction in [0, 1]",
        { fields: [{ field: "jitterFraction", code: RETRY_JITTER_INVALID, message: "must be a finite fraction in [0, 1]" }] },
      ),
    );
  }
  return ok(
    Object.freeze({
      maxSends: draft.maxSends,
      baseDelayMs: draft.baseDelayMs,
      multiplier: draft.multiplier,
      ceilingMs: draft.ceilingMs,
      jitterFraction,
    }),
  );
}

/**
 * The wait before retry number `retryCount`, 1-based, before jitter.
 *
 * `min(base * multiplier^retryCount, ceiling)`. The exponent is the RETRY
 * number, not the send number, so the first retry already carries one factor of
 * growth — the surprising half of the legacy `eventing` schedule, preserved here
 * because changing it would silently halve every existing backoff.
 *
 * Growth that overflows to Infinity is not a special case: `Math.min` collapses
 * it to the ceiling, which is the answer the ceiling exists to give.
 */
export function backoffMs(policy: RetryPolicy, retryCount: number): number {
  if (retryCount <= 0) return 0;
  const grown = policy.baseDelayMs * policy.multiplier ** retryCount;
  return Math.min(Math.round(grown), policy.ceilingMs);
}

/**
 * Decide what happens after a send that had already failed `failedCount` times
 * fails again.
 *
 * `failedCount` is how many sends have ALREADY failed, so the first failure
 * passes 0. Give-up is `retryCount >= maxSends`, matching the legacy guard: at
 * the budget the answer is stop, not one more.
 */
export function decideRetry(policy: RetryPolicy, failedCount: number): RetryDecision {
  const retryCount = failedCount + 1;
  if (retryCount >= policy.maxSends) return { kind: "give-up", retryCount, reason: "budget_spent" };
  return { kind: "retry", retryCount, delayMs: backoffMs(policy, retryCount) };
}

/**
 * Apply jitter to a wait.
 *
 * `spread` is a fraction in [0, 1) the caller draws. The result lies in
 * `[delayMs * (1 - jitterFraction), delayMs]` — jitter only ever REMOVES time,
 * so a jittered schedule can never exceed the un-jittered bound and
 * `totalDelayCeilingMs` stays a true ceiling. A spread outside [0, 1) is clamped
 * rather than refused: this runs on the retry path, and refusing to schedule a
 * retry because a random draw was out of range would turn a bad draw into a lost
 * message.
 */
export function jitteredDelayMs(policy: RetryPolicy, delayMs: number, spread: number): number {
  if (policy.jitterFraction === 0) return delayMs;
  const clamped = Number.isFinite(spread) ? Math.min(Math.max(spread, 0), 1) : 0;
  const floor = delayMs * (1 - policy.jitterFraction);
  return Math.round(floor + (delayMs - floor) * clamped);
}

/**
 * When a retry decided at `now` becomes due, as epoch milliseconds.
 *
 * A NUMBER RATHER THAN A `Date`, because ADR M0.3 §5.3 forbids the kernel from
 * constructing one — `scripts/arch/kernel-content.mjs` rule K4 fails on any
 * `new Date(...)` in this package, argument or not, and it is right to: a kernel
 * that can build an instant is one call away from building the CURRENT instant.
 * The caller, which already holds a `Clock`, wraps this.
 */
export function retryDueAtMs(now: Date, delayMs: number): number {
  return now.getTime() + delayMs;
}

/**
 * The most total waiting a policy can ever ask for, in milliseconds.
 *
 * The BOUND, stated as arithmetic rather than as a promise in a comment. A
 * policy sends at most `maxSends` times, so it waits at most `maxSends - 1`
 * times, and no single wait exceeds `ceilingMs`. Jitter only subtracts. An
 * operator compares this against the retention window on the queue: if this is
 * larger, the last retry is scheduled after the row is pruned and the retry
 * budget is a fiction.
 */
export function totalDelayCeilingMs(policy: RetryPolicy): number {
  return Math.max(policy.maxSends - 1, 0) * policy.ceilingMs;
}
