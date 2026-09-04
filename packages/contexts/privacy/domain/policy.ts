// The tunable limits, in one place, as data.
//
// Every value here is transcribed from the behaviour the live erasure module
// already has — `DEFAULT_TOMBSTONE_TTL_DAYS`, `DEFAULT_MAX_RETRIES`,
// `BASE_BACKOFF_MS`, `MAX_BACKOFF_MS`, `LEASE_TTL_MS`. They are a POLICY VALUE
// passed into a use case, not a module constant read from the environment,
// because a limit read from `process.env` inside a domain rule is untestable and
// is exactly the coupling ADR M0.3 §2 bans. The live module read all five from
// the environment; the composition root now does that reading and hands the
// result in.
//
// `requiredTargets` is the one field that is not a number, and it is the most
// load-bearing. See below.

export const PRIVACY_POLICY_VERSION = "2026-08-11.1";

export interface PrivacyBarrierPolicy {
  /**
   * How long a tombstone refuses writes for the subject it seals.
   *
   * 30 days is not arbitrary. The tombstone only has to outlive the longest-
   * lived reference that could still land a write for the erased subject: a
   * live end-user session, an in-flight durable run, and the column-store span
   * TTL. Past that window nothing anywhere still points at the subject, and a
   * signup under the same handle is a different person who must not inherit
   * someone else's erasure.
   *
   * A permanent register would also be, itself, a durable record of who has been
   * erased — the thing this context exists to remove.
   */
  readonly tombstoneTtlDays: number;
}

export interface PrivacyRetryPolicy {
  /** Retries before the queue stops re-driving and leaves it for an operator. */
  readonly maxRetries: number;
  /** First retry delay; doubles per retry. */
  readonly baseBackoffMs: number;
  /** Ceiling, so a long-broken target is still retried roughly four times a day. */
  readonly maxBackoffMs: number;
  /**
   * Lease lifetime. Comfortably longer than a pass and short enough that a
   * crashed pass is reclaimed the same hour rather than pinning the operation
   * until someone notices.
   */
  readonly leaseTtlMs: number;
}

export interface PrivacyErasurePolicy {
  /**
   * The context names that MUST report an outcome before an operation may claim
   * completion.
   *
   * ADR M0.3 §3 injects `ErasureTarget[]` at the composition root, which means
   * the set of targets is a wiring decision — and a wiring decision that is
   * silently wrong reads, from inside this context, as "there was nothing to
   * erase there". Pinning the expected roster is what turns a missing target
   * from an invisible omission into `PRIVACY_TARGET_NOT_WIRED`.
   *
   * Empty by default because the roster is a property of an installation's
   * composition root, not of this package. An empty roster still does not let an
   * injected target off: every target that WAS injected must settle too.
   */
  readonly requiredTargets: readonly string[];
}

export interface PrivacyPolicy {
  /**
   * Stamped on every operation and every tombstone, so a record states the rules
   * it was produced under rather than deferring to whatever the code says years
   * later.
   */
  readonly version: string;
  readonly barrier: PrivacyBarrierPolicy;
  readonly retry: PrivacyRetryPolicy;
  readonly erasure: PrivacyErasurePolicy;
}

const DAY_MS = 24 * 60 * 60 * 1000;

export const DEFAULT_PRIVACY_POLICY: PrivacyPolicy = Object.freeze({
  version: PRIVACY_POLICY_VERSION,
  barrier: Object.freeze({ tombstoneTtlDays: 30 }),
  retry: Object.freeze({
    maxRetries: 8,
    baseBackoffMs: 60_000,
    maxBackoffMs: 6 * 60 * 60 * 1000,
    leaseTtlMs: 15 * 60 * 1000,
  }),
  erasure: Object.freeze({ requiredTargets: Object.freeze([]) }),
});

/** Milliseconds one tombstone survives, from the instant it was sealed. */
export function tombstoneTtlMs(policy: PrivacyPolicy): number {
  return Math.max(1, Math.floor(policy.barrier.tombstoneTtlDays)) * DAY_MS;
}
