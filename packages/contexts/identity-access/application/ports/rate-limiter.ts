// RateLimiter — identity-access's adapter-facing port (ADR M0.3 §13).
//
// One port, two legitimate implementations, and they are not alternatives to
// each other:
//
//   * the canonical-store implementation writes `AuthRateLimitBucket`, the row
//     this context is sole writer of. It survives a restart and is what an
//     incident review reads.
//   * `packages/adapters/redis-ratelimit` is the hot-path implementation. It is
//     fast and lossy, and it is the one the request guard calls.
//
// Both return the SAME bucket shape, so a use case cannot tell them apart and
// the durable and hot representations of a window cannot drift.
//
// THE WINDOW ARITHMETIC IS NOT HERE. `windowFor()`, the rollover rule and the
// limit comparison are in `domain/rate-limit.ts` and are exercised without any
// implementation at all. What this port owns is the one thing a pure function
// cannot do: increment a shared counter atomically. An implementation MUST make
// the read-and-increment atomic — two concurrent logins that each read 9 and
// each write 10 have admitted eleven requests under a limit of ten.
//
// FAILURE IS A VALUE, NOT AN EXCEPTION. `consume` returns `Result`, so "the
// limiter is unreachable" arrives as data the use case must handle rather than
// as a throw it might not catch. The fail-open decision is then made once, in
// the open, by `domain/rate-limit.ts`'s `LIMITER_UNAVAILABLE_POLICY` — instead
// of being an empty `catch` block somebody has to notice.

import type {
  AuthRateLimitAction,
  RateLimitBucket,
  RateLimitPolicy,
  TokenHash,
} from "../../domain/index.js";
import type { Result } from "@platos/kernel";

export interface RateLimitConsumption {
  readonly action: AuthRateLimitAction;
  /**
   * The already-hashed identifier.
   *
   * Hashed by the caller, never by the implementation: the identifier is an
   * email address or a client address, and a limiter keyspace holding those in
   * plaintext is a directory of who logged in and from where.
   */
  readonly identifierHash: TokenHash;
  readonly policy: RateLimitPolicy;
  readonly at: Date;
}

export interface RateLimiter {
  /**
   * Fold one request into its fixed window and return the resulting bucket.
   *
   * The returned `requestCount` INCLUDES this request, so a caller compares it
   * against the policy limit with `>` — the same comparison the canonical store
   * makes, and the reason a policy of 10 admits the tenth request.
   */
  consume(consumption: RateLimitConsumption): Promise<Result<RateLimitBucket>>;
}
