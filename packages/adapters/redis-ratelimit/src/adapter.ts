// The single `RateLimiter` implementation. The vendor client is imported in
// `client.ts` and nowhere else in the repository.
//
// ADR M0.3 §4/§13: an adapter implements ONE owner-supplied port and is the sole
// holder of its vendor client. This directory satisfies exactly one binding —
// `redis-ratelimit:RateLimiter` — and unlike `redis-cache` it will never satisfy
// a second: §4 gives it "one namespaced keyspace, one owner", and the keyspace
// is `platos:identity:ratelimit:`.
//
// ---------------------------------------------------------------------------
// WHERE THIS ADAPTER FAILS CLOSED, AND WHERE THE SYSTEM DOES NOT. MEASURED.
//
// This adapter fails closed: `consume` answers a dead Redis with
// `err(RATE_LIMITER_UNAVAILABLE)` and never with a fabricated bucket, so no
// caller can mistake an outage for a quiet window. `rate-limiter.test.ts`'s
// "a Redis that is gone" block pins it against a connection that rejects every
// command, and `ratelimit.integration.test.ts` pins it against a real client
// that has lost its server.
//
// THE COMPOSED SYSTEM STILL FAILS OPEN, and stating that plainly is worth more
// than a claim this file is not entitled to make. `packages/contexts/identity-
// access/domain/rate-limit.ts` declares
//
//     export const LIMITER_UNAVAILABLE_POLICY: "allow" | "deny" = "allow";
//
// and `consume-rate-limit.ts` applies it to exactly this refusal: the request is
// ADMITTED, as `degraded`, and a safety event is recorded. So an install that
// loses Redis loses authentication rate limiting until it comes back. That is a
// deliberate, argued trade — the constant's own header says "the alternative —
// refusing every login while the cache is down — converts a cache outage into a
// total authentication outage" — and it is DOMAIN policy, not adapter policy:
// flipping it to `"deny"` closes every use case with no other edit.
//
// IT IS ALREADY PINNED, AND NOT BY THIS DIRECTORY.
// `packages/contexts/identity-access/domain/rate-limit.test.ts` asserts
// `LIMITER_UNAVAILABLE_POLICY` is `"allow"` under the heading "the documented
// behaviour when the limiter itself is unreachable", so the day it flips, that
// case is what fails. A second copy here would be a second statement of one
// fact, in a package that cannot even import the constant — an adapter's only
// import edge is the port entry point.
//
// AND IT IS THE ORACLE'S BEHAVIOUR, WHICH IS WHY THIS TRANCHE DOES NOT FLIP IT.
// `apps/agent/src/auth/rate-limit.guard.ts` catches a failed Redis pipeline with
// `// Redis down -> fail open (availability over rate limiting).` and returns
// `true`. Closing the composed system here would be a behaviour change to a live
// authentication path, decided inside a tranche that builds adapters, and it
// would be invisible in a diff of this directory. A reviewer who wants it closed
// changes one constant in the context and every use case follows.
// ---------------------------------------------------------------------------

import type { RateLimiter } from "@platos/context-identity-access/application/ports/index.js";

import type { RateLimitConnection, RateLimitConnectionOptions } from "./client.js";
import { createRateLimitConnection } from "./client.js";
import { createRedisRateLimiter } from "./rate-limiter.js";

export interface RedisRatelimitAdapter extends RateLimiter {
  readonly adapterName: "redis-ratelimit";
  /** Release the connection. The composition root owns this adapter's lifetime. */
  close(): Promise<void>;
}

/**
 * Build the adapter over an ALREADY-OPEN connection.
 *
 * Separate from `createRedisRatelimitAdapter` for the reason
 * `buildRedisCacheAdapter` is separate from its opener: a suite supplies a
 * connection it built against a container and still exercises the real limiter,
 * and a suite supplies a connection that rejects everything and still exercises
 * the real refusal. `close()` here closes the connection it was given, because
 * the caller that opened it is the caller that asked for the adapter.
 */
export function buildRedisRatelimitAdapter(connection: RateLimitConnection): RedisRatelimitAdapter {
  const limiter = createRedisRateLimiter(connection);
  return {
    adapterName: "redis-ratelimit",
    consume: (consumption) => limiter.consume(consumption),
    close: () => connection.close(),
  };
}

/** Open the connection and build the adapter over it. */
export function createRedisRatelimitAdapter(
  options: RateLimitConnectionOptions,
): RedisRatelimitAdapter {
  return buildRedisRatelimitAdapter(createRateLimitConnection(options));
}
