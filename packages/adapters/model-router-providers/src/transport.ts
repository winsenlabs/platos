// The HTTP seam every provider client is built on, and the retry policy that
// rides on it.
//
// WHY A SEAM AND NOT A CONSTANT. The extraction source wraps global `fetch` in a
// declarative retry policy and hands the wrapper to every provider client's
// `create*({ fetch })` option, so an installation can say how hard to try
// without editing a call site. Nothing in the `ModelRouter` port carries that
// policy, and an adapter with no seam for it would have had to hard-code one —
// which is how a 429 policy becomes unchangeable in production. So the policy
// arrives at CONSTRUCTION: the composition root builds the adapter with the
// rules this installation wants, and the default set below is what it gets if it
// says nothing.
//
// WHAT THIS DELIBERATELY DOES NOT DO. It does not vary the policy PER REQUEST.
// The source varies it per agent, and an agent is a concept this context may not
// import (ADR M0.3 §1 row 4 permits `tenancy` and `secrets` and nothing else).
// Carrying it per call would mean a new field on `ModelGenerationRequest` whose
// only honest source is a context that does not exist yet. A construction seam
// closes the hard-coding without inventing that field, and an installation that
// needs two policies builds two adapters — which the factory in `adapter.ts`
// makes cheap, because an adapter holds no state beyond its transport.
//
// STREAMING SAFETY. Only a response that has not been read is retried. Once the
// caller owns the body, retrying would lose whatever it has already consumed, so
// the response is handed back as it is and the SDK reports the failure.

import { err, ok, retryPolicyInvalid, type Result } from "@platos/context-providers/application/ports/index.js";

/** A `fetch`-shaped function. The one thing a provider client is given. */
export type HttpTransport = typeof fetch;

/** How long a wait may ever be, whatever a header or a backoff asks for. */
export const MAX_BACKOFF_MS = 30_000;

/** Why a call failed, in the four kinds a rule can name. */
export const RETRY_CAUSES = ["rate-limit", "temporary-error", "auth-error", "network-error"] as const;

export type RetryCause = (typeof RETRY_CAUSES)[number];

/**
 * What to do about a cause.
 *
 * `fallback` retries nothing here on purpose: it means "hand the failure back so
 * something above can route elsewhere", and swallowing it in a retry loop would
 * make that routing unreachable.
 */
export const RETRY_ACTIONS = ["fail", "retry", "fallback"] as const;

export type RetryAction = (typeof RETRY_ACTIONS)[number];

export interface RetryRule {
  readonly cause: RetryCause;
  readonly action: RetryAction;
  /** Retries after the first call. Read only when the action is `retry`. */
  readonly retryCount?: number;
  /** The first wait, in milliseconds. Multiplied on each later retry. */
  readonly backoffMs?: number;
  /** The multiplier. One is a constant wait; two is exponential. */
  readonly backoffMultiplier?: number;
  /** Honour a `Retry-After` header in place of the computed backoff. */
  readonly waitForRetryAfter?: boolean;
}

export interface RetryPolicy {
  readonly rules: readonly RetryRule[];
}

/** What an installation gets when it names no policy. The source's own set. */
export const DEFAULT_RETRY_RULES: readonly RetryRule[] = Object.freeze([
  { cause: "rate-limit", action: "retry", retryCount: 2, backoffMs: 500, backoffMultiplier: 2, waitForRetryAfter: true },
  { cause: "temporary-error", action: "retry", retryCount: 2, backoffMs: 500, backoffMultiplier: 2, waitForRetryAfter: true },
  { cause: "auth-error", action: "fail" },
  { cause: "network-error", action: "retry", retryCount: 1, backoffMs: 250, backoffMultiplier: 2 },
]);

const TEMPORARY_STATUSES = new Set([408, 500, 502, 503, 504]);
const AUTH_STATUSES = new Set([401, 403]);

const DEFAULT_RETRY_COUNT = 2;
const DEFAULT_BACKOFF_MS = 500;
const DEFAULT_BACKOFF_MULTIPLIER = 2;

/** Classify a status against the cause taxonomy. Null means "not retryable". */
export function classifyStatus(status: number): RetryCause | null {
  if (status === 429) return "rate-limit";
  if (TEMPORARY_STATUSES.has(status)) return "temporary-error";
  if (AUTH_STATUSES.has(status)) return "auth-error";
  return null;
}

function checkNumber(
  value: number | undefined,
  field: string,
  minimum: number,
): Result<number> | null {
  if (value === undefined) return null;
  if (!Number.isFinite(value) || value < minimum) {
    return err(retryPolicyInvalid(`${field} must be a finite number of at least ${minimum}`, field, value));
  }
  return ok(value);
}

/**
 * Check a rule set before anything is built from it.
 *
 * A policy is validated ONCE, at construction, rather than at the moment a rule
 * first fires. A negative retry count only shows itself under a failure nobody
 * produces on purpose, so a policy checked lazily is a policy checked in
 * production; and the numbers below govern how long a request may hold a socket,
 * which makes a malformed one an availability defect rather than a typo.
 */
export function retryPolicy(rules: readonly RetryRule[]): Result<RetryPolicy> {
  const seen = new Set<RetryCause>();
  for (const rule of rules) {
    if (!RETRY_CAUSES.includes(rule.cause)) {
      return err(retryPolicyInvalid("unknown retry cause", "cause", rule.cause));
    }
    if (!RETRY_ACTIONS.includes(rule.action)) {
      return err(retryPolicyInvalid("unknown retry action", "action", rule.action));
    }
    // Two rules for one cause: the first would win silently and the second
    // would be dead configuration an operator believes is live.
    if (seen.has(rule.cause)) {
      return err(retryPolicyInvalid("two rules name the same cause", "cause", rule.cause));
    }
    seen.add(rule.cause);

    if (rule.retryCount !== undefined && !Number.isSafeInteger(rule.retryCount)) {
      return err(retryPolicyInvalid("retryCount must be a whole number", "retryCount", rule.retryCount));
    }
    for (const [value, field, minimum] of [
      [rule.retryCount, "retryCount", 0],
      [rule.backoffMs, "backoffMs", 0],
      [rule.backoffMultiplier, "backoffMultiplier", 1],
    ] as const) {
      const checked = checkNumber(value, field, minimum);
      if (checked !== null && !checked.ok) return err(checked.error);
    }
  }
  return ok({ rules: Object.freeze([...rules]) });
}

/** The default policy, already checked. Built once because it cannot fail. */
export const DEFAULT_RETRY_POLICY: RetryPolicy = Object.freeze({ rules: DEFAULT_RETRY_RULES });

/**
 * Read a `Retry-After` header, in either RFC 7231 form.
 *
 * Capped like every other wait: some hosts answer a 429 with a whole day, and a
 * client that honoured it would hold the request open until the caller gave up.
 */
export function parseRetryAfter(value: string | null | undefined, now: number): number | null {
  if (value === undefined || value === null) return null;
  const trimmed = value.trim();
  if (trimmed === "") return null;
  const seconds = Number.parseInt(trimmed, 10);
  if (Number.isFinite(seconds) && seconds >= 0 && /^\d+$/u.test(trimmed)) {
    return Math.min(seconds * 1000, MAX_BACKOFF_MS);
  }
  const date = new Date(trimmed);
  const at = date.getTime();
  if (!Number.isNaN(at)) return at > now ? Math.min(at - now, MAX_BACKOFF_MS) : 0;
  return null;
}

export function backoffFor(rule: RetryRule, retryNumber: number): number {
  const base = rule.backoffMs ?? DEFAULT_BACKOFF_MS;
  const multiplier = rule.backoffMultiplier ?? DEFAULT_BACKOFF_MULTIPLIER;
  return Math.min(base * multiplier ** (retryNumber - 1), MAX_BACKOFF_MS);
}

/** The two ambient facts a retrying transport needs, both replaceable. */
export interface TransportClock {
  readonly wait: (milliseconds: number) => Promise<void>;
  readonly now: () => number;
}

export const SYSTEM_TRANSPORT_CLOCK: TransportClock = Object.freeze({
  wait: (milliseconds: number) =>
    new Promise<void>((resolve) => {
      setTimeout(resolve, milliseconds);
    }),
  now: () => Date.now(),
});

function ruleFor(policy: RetryPolicy, cause: RetryCause): RetryRule | null {
  return policy.rules.find((rule) => rule.cause === cause) ?? null;
}

/**
 * Wrap a transport so it honours a policy.
 *
 * The waits go through `clock`, which is what makes the policy falsifiable: a
 * test asserts the exact millisecond sequence a rule produces instead of waiting
 * for it. A policy whose waits cannot be observed is a policy no test can prove
 * wrong, and this one governs how long a failing provider holds a request.
 */
export function retryingTransport(
  policy: RetryPolicy,
  base: HttpTransport,
  clock: TransportClock = SYSTEM_TRANSPORT_CLOCK,
): HttpTransport {
  const retrying = async (input: Parameters<HttpTransport>[0], init?: Parameters<HttpTransport>[1]) => {
    for (let pass = 1; ; pass += 1) {
      let response: Response | null = null;
      let networkFailure: unknown = null;
      try {
        response = await base(input, init);
      } catch (thrown) {
        networkFailure = thrown;
      }

      if (response !== null && response.ok) return response;

      const cause: RetryCause | null =
        response === null ? "network-error" : classifyStatus(response.status);

      // A 4xx that is neither auth nor 408. Nothing here can improve it, so the
      // response goes back unchanged and the SDK reports the provider's own words.
      if (cause === null) {
        if (response !== null) return response;
        throw networkFailure ?? new Error("transport produced neither a response nor a failure");
      }

      const rule = ruleFor(policy, cause);
      if (rule === null || rule.action === "fail" || rule.action === "fallback") {
        if (response !== null) return response;
        throw networkFailure ?? new Error(`transport gave up on cause ${cause}`);
      }

      const allowed = (rule.retryCount ?? DEFAULT_RETRY_COUNT) + 1;
      if (pass >= allowed) {
        if (response !== null) return response;
        throw networkFailure ?? new Error(`transport exhausted its retries on cause ${cause}`);
      }

      let wait = backoffFor(rule, pass);
      if (rule.waitForRetryAfter === true && response !== null) {
        const header = parseRetryAfter(response.headers.get("retry-after"), clock.now());
        if (header !== null) wait = header;
      }

      // Drain the failed body so the socket returns to the pool. Under a
      // sustained 5xx storm an undrained body leaks one connection per retry.
      if (response !== null) {
        try {
          await response.arrayBuffer();
        } catch {
          // A body that cannot be drained is already gone; nothing to release.
        }
      }

      await clock.wait(wait);
    }
  };
  return retrying as HttpTransport;
}
