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
// FAIL-OPEN IS A DECISION, NOT AN ACCIDENT. See `LIMITER_UNAVAILABLE_POLICY`.

import { secondsUntil } from "./credential.js";
import { rateLimited } from "./errors.js";
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
  | { readonly outcome: "degraded" };

/**
 * WHAT HAPPENS WHEN THE LIMITER ITSELF IS DOWN.
 *
 * `"allow"` — availability over limiting. This is the behaviour the running
 * system has: the Redis-backed guard swallows a connection failure and lets the
 * request through, and the budget services do the same. It is recorded here as a
 * named constant so it is a policy a reviewer can see and argue with, rather
 * than a `catch {}` a reader has to notice.
 *
 * The trade is explicit: a limiter outage becomes an unlimited window. That is
 * accepted because the alternative — refusing every login while the cache is
 * down — converts a cache outage into a total authentication outage. Flip this
 * to `"deny"` and every use case below closes instead, with no other edit.
 */
export const LIMITER_UNAVAILABLE_POLICY: "allow" | "deny" = "allow";

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

/** The decision when the limiter could not be consulted at all. */
export function decideOnLimiterFailure(): RateLimitDecision {
  return LIMITER_UNAVAILABLE_POLICY === "allow"
    ? { outcome: "degraded" }
    : { outcome: "limited", retryAfterSeconds: 1, resetAt: new Date(0) };
}

export function isPermitted(decision: RateLimitDecision): boolean {
  return decision.outcome !== "limited";
}

export function asResult(decision: RateLimitDecision): Result<RateLimitDecision> {
  if (decision.outcome === "limited") return err(rateLimited(decision.retryAfterSeconds));
  return ok(decision);
}
