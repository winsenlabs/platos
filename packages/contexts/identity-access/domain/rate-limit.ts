// Per-principal authentication rate limiting.
//
// AuthRateLimitBucket is a FIXED window, not a sliding one: the window start is
// `floor(now / windowMs) * windowMs`, which makes the bucket key deterministic
// and lets the unique index `(action, identifierHash, windowStart)` do the
// concurrency control. A rolled-over window is a DIFFERENT ROW, so a reset needs
// no sweeper and no read-modify-write.
//
// A NOTE ON ONE COLUMN NAME. The counter is `requestCount` here and everywhere
// in this context. The baseline schema maps it to a physical column whose name
// is a term this repository's vocabulary boundary reserves; the `@map` in
// `schema.prisma` carries that name and it is deliberately not repeated in
// context source. Nothing about the arithmetic depends on the physical name.
//
// FAILING CLOSED IS A DECISION, NOT AN ACCIDENT. See `LIMITER_UNAVAILABLE_POLICY`
// (D3, 2026-09-15: it used to be fail-open, and the reason it moved is there).

import { secondsUntil } from "./credential.js";
import { rateLimitFailedClosed, rateLimited } from "./errors.js";
import type { TokenHash } from "./principal.js";
import { err, ok, type Result } from "@platos/kernel";

/** Schema enum `AuthRateLimitAction`. */
export const AUTH_RATE_LIMIT_ACTIONS = ["LOGIN", "INVITE_ACCEPT", "MFA_VERIFY"] as const;
export type AuthRateLimitAction = (typeof AUTH_RATE_LIMIT_ACTIONS)[number];

export interface RateLimitPolicy {
  readonly requests: number;
  readonly windowMs: number;
}

// The extraction source's defaults, unchanged. MFA verification is the tightest
// because it is the only one where each request is a guess at a 6-digit secret.
export const DEFAULT_LOGIN_POLICY: RateLimitPolicy = { requests: 10, windowMs: 60_000 };
export const DEFAULT_INVITE_ACCEPT_POLICY: RateLimitPolicy = { requests: 10, windowMs: 15 * 60_000 };
export const DEFAULT_MFA_VERIFY_POLICY: RateLimitPolicy = { requests: 5, windowMs: 5 * 60_000 };

export const DEFAULT_POLICIES: Readonly<Record<AuthRateLimitAction, RateLimitPolicy>> =
  Object.freeze({
    LOGIN: DEFAULT_LOGIN_POLICY,
    INVITE_ACCEPT: DEFAULT_INVITE_ACCEPT_POLICY,
    MFA_VERIFY: DEFAULT_MFA_VERIFY_POLICY,
  });

export interface RateLimitWindow {
  readonly windowStart: Date;
  readonly expiresAt: Date;
}

export interface RateLimitBucket {
  readonly action: AuthRateLimitAction;
  readonly identifierHash: TokenHash;
  readonly windowStart: Date;
  readonly requestCount: number;
  readonly expiresAt: Date;
}

export type RateLimitDecision =
  | { readonly outcome: "allowed"; readonly remaining: number }
  | { readonly outcome: "limited"; readonly retryAfterSeconds: number; readonly resetAt: Date }
  | { readonly outcome: "degraded" }
  /**
   * D3 (2026-09-15). The limiter could not be consulted and the policy is
   * `deny`. A REFUSAL like `limited`, and a DIFFERENT one: `limited` says the
   * caller spent their budget and should wait `retryAfterSeconds`; this says the
   * service could not count at all. `cause` is the code the limiter port
   * returned, kept so Redis and PostgreSQL outages stay distinguishable.
   */
  | { readonly outcome: "failed-closed"; readonly cause: string };

/**
 * A decision that let the request through.
 *
 * `limited` is a REFUSAL, and `asResult` below turns it into a failure, so it can
 * never inhabit the success branch of a consumption. Saying that in the TYPE is
 * what keeps every caller from carrying an impossible-but-uncheckable case: a
 * branch no input can reach is a branch no test can turn red.
 */
export type PermittedRateLimitDecision = Exclude<
  RateLimitDecision,
  { outcome: "limited" } | { outcome: "failed-closed" }
>;

/**
 * WHAT HAPPENS WHEN THE LIMITER ITSELF IS DOWN.
 *
 * `"deny"` — FAIL CLOSED. Decision D3 (founder-delegated, 2026-09-15) chose it,
 * and the reason is in who consumes this budget: `verify-mfa` and `enrol-totp`
 * spend `MFA_VERIFY`, so `"allow"` meant UNLIMITED guesses at a six-digit TOTP
 * code for as long as Redis was unreachable — and an attacker who can knock the
 * cache over chooses how long that is. A MISSING limiter adapter already failed
 * closed (identity-access does not compose without `redis-ratelimit`); this makes
 * a constructed-but-unreachable one agree with it.
 *
 * WHAT IT COSTS, ACCEPTED IN D3: sign-in, invitation acceptance and MFA stop while
 * the limiter is unreachable. The refusal is `RATE_LIMIT_FAILED_CLOSED`
 * (`unavailable`, 503) and NOT `RATE_LIMITED` (429): a client told it spent its
 * budget waits and retries the same request, a client told the service cannot
 * count is looking at an outage, and two guards under one code cannot be told
 * apart.
 *
 * The running system (the oracle) is fail-open: its Redis-backed guard swallows
 * a connection failure. That behaviour is deliberately NOT ported, and every
 * expectation that encoded it was re-recorded under D3.
 */
export const LIMITER_UNAVAILABLE_POLICY: "allow" | "deny" = "deny";

/** The fixed window containing `now`. */
export function windowFor(now: Date, policy: RateLimitPolicy): RateLimitWindow {
  const startMs = Math.floor(now.getTime() / policy.windowMs) * policy.windowMs;
  return { windowStart: new Date(startMs), expiresAt: new Date(startMs + policy.windowMs) };
}

export function isSameWindow(bucket: RateLimitBucket, window: RateLimitWindow): boolean {
  return bucket.windowStart.getTime() === window.windowStart.getTime();
}

/**
 * Fold one request into the bucket for its window.
 *
 * A bucket from an earlier window is not carried forward — it is replaced by a
 * fresh one starting at 1. That IS the rollover: nothing decays a counter, the
 * key simply changes.
 */
export function recordRequest(
  existing: RateLimitBucket | null,
  action: AuthRateLimitAction,
  identifierHash: TokenHash,
  now: Date,
  policy: RateLimitPolicy,
): RateLimitBucket {
  const window = windowFor(now, policy);
  if (existing !== null && isSameWindow(existing, window)) {
    return { ...existing, requestCount: existing.requestCount + 1 };
  }
  return {
    action,
    identifierHash,
    windowStart: window.windowStart,
    requestCount: 1,
    expiresAt: window.expiresAt,
  };
}

/**
 * Whether the request that produced this bucket is allowed.
 *
 * Strictly greater than the limit, matching the extraction source: a policy of
 * 10 admits the tenth request and refuses the eleventh.
 */
export function decide(bucket: RateLimitBucket, policy: RateLimitPolicy, now: Date): RateLimitDecision {
  if (bucket.requestCount > policy.requests) {
    return {
      outcome: "limited",
      retryAfterSeconds: secondsUntil(bucket.expiresAt, now),
      resetAt: bucket.expiresAt,
    };
  }
  return { outcome: "allowed", remaining: policy.requests - bucket.requestCount };
}

/**
 * The decision when the limiter could not be consulted at all.
 *
 * `policy` defaults to the published constant and is a parameter only so both
 * branches stay exercisable; no production caller passes it.
 */
export function decideOnLimiterFailure(
  cause: string,
  policy: "allow" | "deny" = LIMITER_UNAVAILABLE_POLICY,
): RateLimitDecision {
  return policy === "allow" ? { outcome: "degraded" } : { outcome: "failed-closed", cause };
}

export function isPermitted(decision: RateLimitDecision): boolean {
  return decision.outcome !== "limited" && decision.outcome !== "failed-closed";
}

export function asResult(decision: RateLimitDecision): Result<PermittedRateLimitDecision> {
  if (decision.outcome === "limited") return err(rateLimited(decision.retryAfterSeconds));
  if (decision.outcome === "failed-closed") return err(rateLimitFailedClosed(decision.cause));
  return ok(decision);
}
