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
// WHERE THIS ADAPTER FAILS CLOSED, AND SINCE D3 THE SYSTEM DOES TOO. MEASURED.
//
// This adapter fails closed: `consume` answers a dead Redis with
// `err(RATE_LIMITER_UNAVAILABLE)` and never with a fabricated bucket, so no
// caller can mistake an outage for a quiet window. `rate-limiter.test.ts`'s
// "a Redis that is gone" block pins it against a connection that rejects every
// command, and `ratelimit.integration.test.ts` pins it against a real client
// that has lost its server.
//
// THE COMPOSED SYSTEM FAILS CLOSED TOO, BY D3 (2026-09-15). It did not always:
// until that decision `packages/contexts/identity-access/domain/rate-limit.ts`
// declared the policy `"allow"`, and an install that lost Redis lost
// authentication rate limiting until it came back. D3 reads: "The composed
// rate-limit path FAILS CLOSED: `LIMITER_UNAVAILABLE_POLICY = "deny"`", because
// its consumers include MFA verification and enrolment, where `"allow"` was
// unlimited guesses at a six-digit code for the length of the outage. So the
// constant is now
//
//     export const LIMITER_UNAVAILABLE_POLICY: "allow" | "deny" = "deny";
//
// and `consume-rate-limit.ts` turns exactly this refusal into
// `RATE_LIMIT_FAILED_CLOSED` (503) — a code distinct from both `RATE_LIMITED`
// (the budget is spent) and this adapter's own `RATE_LIMITER_UNAVAILABLE` (the
// port's cause, carried in `details`). The accepted cost, which D3 names: sign-in
// stops while Redis is unreachable. It is DOMAIN policy, not adapter policy, and
// this directory did not change to follow it — which is the point of the port.
//
// IT IS PINNED, AND NOT BY THIS DIRECTORY.
// `packages/contexts/identity-access/domain/rate-limit.test.ts` asserts the
// policy is `"deny"` (re-recorded under D3 from the oracle's `"allow"`), and
// `apps/core-api/src/composition/identity-tenancy-rest.integration.test.ts`
// stops a real Redis mid-test and reads `RATE_LIMIT_FAILED_CLOSED` off the wire
// with nothing minted or mailed. A second copy here would be a second statement
// of one fact, in a package that cannot even import the constant — an adapter's
// only import edge is the port entry point.
//
// THE ORACLE IS STILL FAIL-OPEN, AND THAT IS NOW A RECORDED DIVERGENCE.
// `apps/agent/src/auth/rate-limit.guard.ts` catches a failed Redis pipeline with
// `// Redis down -> fail open (availability over rate limiting).` and returns
// `true`. V1 deliberately does not port that line; any differential expectation
// that encoded it was re-recorded naming D3.
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
