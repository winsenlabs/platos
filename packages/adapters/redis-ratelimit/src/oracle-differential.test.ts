// THE DIFFERENTIAL: this adapter's windows against the ORACLE's own arithmetic.
//
// The hazard this closes is not a compile error. `redis-ratelimit` is the HOT
// path and `internal-packages/tenancy-database/src/auth.ts`'s
// `#consumeRateLimit` is the DURABLE one, and the port says the two must be
// indistinguishable: "Both return the SAME bucket shape, so a use case cannot
// tell them apart and the durable and hot representations of a window cannot
// drift." A hot limiter whose window boundary sat a millisecond from the
// canonical store's would admit an eleventh request under a limit of ten
// whenever a login crossed the boundary, and every unit test in this directory
// would still be green.
//
// EVERY NUMBER AND EVERY OPERATOR ON THE ORACLE'S SIDE IS LIFTED OUT OF ITS
// SOURCE AND EVALUATED — see `oracle-source.ts` for why, and for the proof that
// the file it reads is byte-identical to `origin/main`. Nothing on that side is
// written here, so this cannot be the assertion that compares two things one
// tranche controls.

import { describe, expect, it } from "vitest";

import {
  windowFor,
  type AuthRateLimitAction,
  type RateLimitPolicy,
  type TokenHash,
} from "@platos/context-identity-access/application/ports/index.js";

import { countingConnection } from "./harness.js";
import { readExtractionDefaults, readOracleRateLimiter, type OracleLimit } from "./oracle-source.js";
import { bucketKey, createRedisRateLimiter } from "./rate-limiter.js";

const oracle = readOracleRateLimiter();
const HASH = "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef" as TokenHash;

/**
 * The oracle's own three policies, used as the sweep's inputs.
 *
 * The KEYS are the oracle's three constructor slots and they are also the three
 * members of `AuthRateLimitAction` — which is itself a claim, and the reason the
 * cast is written out rather than hidden: `domain/rate-limit.ts` says
 * `AUTH_RATE_LIMIT_ACTIONS` is "Schema enum `AuthRateLimitAction`", and the same
 * three names appear as `#loginRateLimit`, `#inviteAcceptRateLimit` and
 * `#mfaVerifyRateLimit` in the oracle. If the two sets ever diverge the sweep
 * runs against a name the schema does not have, and the integration suite —
 * which sends the action to a real server as part of the key — is where that
 * shows.
 */
const POLICIES = Object.entries(oracle.defaults) as [AuthRateLimitAction, OracleLimit][];

/**
 * A deterministic instant sweep, and it is deliberately not random.
 *
 * A seeded generator would make a failure reproduce only if the seed were also
 * reported; a fixed list of offsets reproduces by construction. The offsets are
 * chosen where a fixed window can be wrong: the two boundaries, the millisecond
 * either side of each, the middle, and a scatter that does not divide evenly
 * into any of the three window lengths.
 */
function instantsFor(windowMs: number): Date[] {
  const anchor = Math.floor(Date.parse("2026-03-04T10:17:41.250Z") / windowMs) * windowMs;
  const offsets = [
    0, 1, 2, 999, 1_000, 1_001,
    Math.floor(windowMs / 3), Math.floor(windowMs / 2),
    windowMs - 2, windowMs - 1, windowMs, windowMs + 1,
    2 * windowMs - 1, 2 * windowMs, 7 * windowMs + 13,
  ];
  // And the same offsets one window BEFORE the anchor, so a sign error in a
  // `floor` shows up: `Math.floor` of a negative quotient rounds away from zero.
  return [
    ...offsets.map((offset) => new Date(anchor + offset)),
    ...offsets.map((offset) => new Date(anchor - windowMs + offset)),
  ];
}

describe("the oracle is readable, and it is the module the extraction names", () => {
  it("yields all six expressions rather than falling back to a default", () => {
    // No expected TEXT is asserted — that would pin the oracle's formatting
    // rather than its behaviour. What is asserted is that each capture found
    // something; `readOracleRateLimiter` throws when one did not.
    for (const [name, source] of Object.entries(oracle.evidence)) {
      expect(source.length, `${name} came back empty`).toBeGreaterThan(0);
    }
  });
});

// THE SWEEP LOOPS INSIDE EACH CASE, NOT AROUND IT. A `for` around an `it()`
// reads better in a runner's output and `scripts/arch/test-case-census.mjs`
// refuses it — "it() is declared inside a loop or a non-describe callback" —
// because a case count nobody can derive by reading is a count that cannot pin
// anything. Every assertion below therefore carries the policy and the instant
// in its message, which is what a runner's output would otherwise have given.

describe("this adapter's window is the oracle's window", () => {
  it("agrees on every boundary, for all three of the oracle's policies", () => {
    for (const [action, limit] of POLICIES) {
      const policy: RateLimitPolicy = { requests: limit.requests, windowMs: limit.windowMs };
      for (const at of instantsFor(limit.windowMs)) {
        const mine = windowFor(at, policy);
        const theirStart = oracle.windowStartMs(at, limit);
        expect(mine.windowStart.getTime(), `${action} windowStart at ${at.toISOString()}`).toBe(
          theirStart,
        );
        expect(mine.expiresAt.getTime(), `${action} expiresAt at ${at.toISOString()}`).toBe(
          oracle.expiresAtMs(theirStart, limit),
        );
      }
    }
  });

  it("gives two instants ONE key exactly when the oracle gives them one row", () => {
    for (const [action, limit] of POLICIES) {
      const policy: RateLimitPolicy = { requests: limit.requests, windowMs: limit.windowMs };
      const instants = instantsFor(limit.windowMs);
      for (const left of instants) {
        for (const right of instants) {
          // The oracle's row identity is the unique index
          // `(action, identifierHash, windowStart)`; the action and the hash are
          // held fixed here, so the row is the same exactly when the window
          // start is. The adapter's key is the same exactly when it addresses
          // the same counter. The two must be the same equivalence relation —
          // and a one-directional check would miss the failure that matters,
          // which is two DIFFERENT windows sharing a counter.
          const sameRow = oracle.windowStartMs(left, limit) === oracle.windowStartMs(right, limit);
          const sameKey =
            bucketKey(action, HASH, windowFor(left, policy).windowStart) ===
            bucketKey(action, HASH, windowFor(right, policy).windowStart);
          expect(sameKey, `${action} ${left.toISOString()} vs ${right.toISOString()}`).toBe(sameRow);
        }
      }
    }
  });
});

describe("the request the oracle refuses is the request this adapter's count identifies", () => {
  it("refuses the (limit + 1)th and no earlier one, for all three policies", async () => {
    for (const [action, limit] of POLICIES) {
      const policy: RateLimitPolicy = { requests: limit.requests, windowMs: limit.windowMs };
      const limiter = createRedisRateLimiter(countingConnection());
      const at = new Date(oracle.windowStartMs(new Date("2026-03-04T10:17:41.250Z"), limit) + 7);
      const refused: number[] = [];
      for (let request = 1; request <= limit.requests + 2; request += 1) {
        const consumed = await limiter.consume({ action, identifierHash: HASH, policy, at });
        expect(consumed.ok, `${action} request ${request}`).toBe(true);
        if (!consumed.ok) return;
        // The ORACLE decides. `bucket.requestCount > limit.requests` is its
        // comparison, evaluated from its own text, applied to the count THIS
        // adapter produced.
        if (oracle.isRefused(consumed.value, limit)) refused.push(request);
      }
      expect(refused, action).toEqual([limit.requests + 1, limit.requests + 2]);
    }
  });
});

describe("the extraction's claim that it copied the oracle's defaults", () => {
  it("still holds, literal for literal", () => {
    // SOURCE AGAINST SOURCE, and it proves exactly one thing: that
    // `domain/rate-limit.ts`'s header sentence — "The extraction source's
    // defaults, unchanged" — is still true. It says nothing about this adapter,
    // which is handed a policy rather than choosing one.
    expect(readExtractionDefaults()).toEqual({
      LOGIN: oracle.defaults.LOGIN,
      INVITE_ACCEPT: oracle.defaults.INVITE_ACCEPT,
      MFA_VERIFY: oracle.defaults.MFA_VERIFY,
    });
  });
});
