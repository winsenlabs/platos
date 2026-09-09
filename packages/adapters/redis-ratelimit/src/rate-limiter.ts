// The identity-access `RateLimiter`, over Redis.
//
// The port names two legitimate implementations of itself and says which this
// is: "`packages/adapters/redis-ratelimit` is the hot-path implementation. It is
// fast and lossy, and it is the one the request guard calls." Both return the
// SAME bucket shape as the canonical store, "so a use case cannot tell them
// apart and the durable and hot representations of a window cannot drift".
//
// FOUR PROPERTIES THIS FILE IS JUDGED ON, each one taken from the port or the
// domain rather than invented here:
//
// 1. THE INCREMENT IS ATOMIC. The port: "An implementation MUST make the
//    read-and-increment atomic — two concurrent logins that each read 9 and each
//    write 10 have admitted eleven requests under a limit of ten." One Lua
//    script, one round trip; `client.ts` holds it and publishes no primitive out
//    of which a read-modify-write could be built.
//
// 2. THE CLOCK IS THE CALLER'S. `at` is a field on `RateLimitConsumption`, so
//    nothing here reads the wall clock — not for the window, not for the expiry,
//    not for the TTL. That is what lets a suite prove rollover by ADVANCING `at`
//    rather than by sleeping through a real minute.
//
// 3. THE WINDOW ARITHMETIC IS BORROWED, NOT RESTATED. `windowFor` is the
//    domain's, imported. `domain/rate-limit.ts` says "THE WINDOW ARITHMETIC IS
//    NOT HERE ... What this port owns is the one thing a pure function cannot
//    do: increment a shared counter atomically", and a `floor(at / windowMs)`
//    written out again in this file would be a second copy of the rollover rule
//    that agrees until somebody edits one of them.
//
// 4. IT FAILS CLOSED, AS AN ADAPTER. A command that fails returns
//    `err(RATE_LIMITER_UNAVAILABLE)` and NEVER a fabricated bucket. The
//    difference matters because a synthesised `requestCount: 1` would be
//    indistinguishable from a real first request of a window: `decide()` would
//    allow it, no safety event would be recorded, and an operator would have no
//    way to learn the limiter had been down. What the SYSTEM then does with the
//    refusal is `LIMITER_UNAVAILABLE_POLICY`'s decision, made once in the open in
//    `domain/rate-limit.ts` — see the note in `adapter.ts`, which measures where
//    that constant currently stands.
//
// THE IDENTIFIER IS ALREADY A HASH AND IS NEITHER RE-HASHED NOR LOGGED. The
// port: "Hashed by the caller, never by the implementation: the identifier is an
// email address or a client address, and a limiter keyspace holding those in
// plaintext is a directory of who logged in and from where." Re-hashing would be
// harmless and would also mean the durable and hot stores keyed one identifier
// two ways; this file logs nothing at all, so the second half needs no rule.

import type {
  RateLimitBucket,
  RateLimitConsumption,
  RateLimiter,
  Result,
  TokenHash,
} from "@platos/context-identity-access/application/ports/index.js";
import {
  err,
  ok,
  rateLimiterUnavailable,
  windowFor,
} from "@platos/context-identity-access/application/ports/index.js";

import type { RateLimitConnection } from "./client.js";

/**
 * The key one action's window for one identifier is counted under.
 *
 * THE WINDOW START IS IN THE KEY, and that is the rollover. `domain/rate-limit.ts`
 * says a fixed window "makes the bucket key deterministic" and that "a rolled-over
 * window is a DIFFERENT ROW, so a reset needs no sweeper and no read-modify-write"
 * — the canonical store gets that from the unique index `(action,
 * identifierHash, windowStart)` and this gets it from the key. It means expiry is
 * a property of the ADDRESS rather than of the TTL: a caller whose `at` has
 * crossed the boundary asks a different question, and would see a fresh counter
 * even on a server that had somehow kept every key forever.
 *
 * ADR M0.3 §4 asks each adapter for "one namespaced keyspace"; `platos:identity:`
 * is that namespace, and this is the only string this directory builds.
 */
export function bucketKey(
  action: string,
  identifierHash: TokenHash,
  windowStart: Date,
): string {
  return `platos:identity:ratelimit:${action}:${identifierHash}:${windowStart.getTime()}`;
}

/**
 * How long the server keeps a window's counter after this request.
 *
 * IT IS RECLAMATION, NOT CORRECTNESS — the key already carries the window start,
 * so a key that outlived its window by an hour would still never be read again.
 * That is why the arithmetic here is allowed to be defensive rather than exact:
 * the cost of being wrong is bytes, and the cost of a NON-POSITIVE `PEXPIRE` is
 * a deleted key, which Redis treats as `DEL` and which would silently reset a
 * live window.
 *
 * Clamped into `[1, windowMs]`. The lower bound covers a caller whose `at` sits
 * exactly on the boundary or past it (a clock that moved backwards between two
 * requests, an `at` chosen by a test); the upper bound is what the value can
 * never exceed by construction and states it rather than trusting it.
 */
export function reclamationTtlMs(at: Date, expiresAt: Date, windowMs: number): number {
  const remaining = expiresAt.getTime() - at.getTime();
  if (!Number.isFinite(remaining) || remaining < 1) return 1;
  return Math.min(Math.ceil(remaining), windowMs);
}

function reasonOf(error: unknown): string {
  // The MESSAGE only, never the error object. A driver error carries the
  // connection URL, which carries the password, and `details` is rendered into
  // logs.
  return error instanceof Error ? error.message : "redis command failed";
}

export function createRedisRateLimiter(connection: RateLimitConnection): RateLimiter {
  return {
    async consume(consumption: RateLimitConsumption): Promise<Result<RateLimitBucket>> {
      const window = windowFor(consumption.at, consumption.policy);
      const key = bucketKey(consumption.action, consumption.identifierHash, window.windowStart);
      const ttlMs = reclamationTtlMs(consumption.at, window.expiresAt, consumption.policy.windowMs);
      let requestCount: number;
      try {
        requestCount = await connection.foldIntoWindow(key, ttlMs);
      } catch (error) {
        // FAIL CLOSED HERE. No bucket is invented, so nothing downstream can
        // mistake an outage for a quiet window.
        return err(rateLimiterUnavailable(reasonOf(error)));
      }
      return ok({
        action: consumption.action,
        identifierHash: consumption.identifierHash,
        windowStart: window.windowStart,
        // INCLUDES this request — the port says so, and it is why a caller
        // compares with `>` and a policy of 10 admits the tenth.
        requestCount,
        expiresAt: window.expiresAt,
      });
    },
  };
}
