// THREE owner-supplied ports over ONE Redis client.
//
// ADR M0.3 §15 amendment: one vendor client is one adapter DIRECTORY, and a
// directory may satisfy more than one port when the ports sit behind the same
// client. `postgres-tenancy` is that rule applied seventeen times; this is the
// second directory it applies to, and the argument is the same one — `Cache`,
// `IdempotencyStore` and the kernel's `RequestIdempotency` are the same
// connection, the same server and the same namespace discipline, so a thirteenth
// directory would have been a second Redis client for one Redis.
//
// THE PAIRING WAS DECIDED BEFORE THIS ISSUE, TWICE. `jobs`' own
// `jobs-repository.ts` explains why `IdempotencyStore` is not a canonical store
// — "an atomic claim-or-report in one round trip, a TTL the store enforces
// rather than a sweep, and an `XX` update that must not resurrect an expired
// key" — and names this directory. The composition root's binding table says the
// same. This file is those two sentences made real.
//
// THE PORTS ARE PROPERTIES, NOT A SPREAD. `Cache.get`/`set`/`delete` and
// `IdempotencyStore.reserve`/`settle` do not collide today, and a flat spread
// would still be wrong: `MemoryDependencies` names the slot `cache` and
// `JobsDependencies` names the slot `idempotency`, so a composition root has to
// hand each port over under its own name rather than out of a bundle assembled
// from key order. The same reason `postgres-tenancy` publishes `jobs` and
// `approvals` as properties.

import type { Cache } from "@platos/context-memory/application/ports/index.js";

import { createRedisCache } from "./cache.js";
import type { RedisConnection, RedisConnectionOptions } from "./client.js";
import { createRedisConnection } from "./client.js";
import type { RedisIdempotencyStore } from "./idempotency-store.js";
import { createRedisIdempotencyStore } from "./idempotency-store.js";
import type { RedisRequestIdempotency } from "./request-idempotency.js";
import { createRedisRequestIdempotency } from "./request-idempotency.js";

export interface RedisCacheAdapter {
  readonly adapterName: "redis-cache";
  /** The `memory` `Cache` port. */
  readonly cache: Cache;
  /** The `jobs` `IdempotencyStore` port. */
  readonly idempotency: RedisIdempotencyStore;
  /**
   * The kernel `RequestIdempotency` port — the THIRD on this connection.
   *
   * A separate slot rather than a widening of `idempotency` because the two are
   * different contracts over the same primitive: one reserves a job execution
   * and settles with a `JobExecutionErrorCode`, the other reserves an HTTP
   * request and settles with the bytes that went on the wire. Their keyspaces
   * are disjoint by prefix, so neither can read the other's records.
   */
  readonly requests: RedisRequestIdempotency;
  /** Release the connection. The composition root owns this adapter's lifetime. */
  close(): Promise<void>;
}

/**
 * Build the adapter over an ALREADY-OPEN connection.
 *
 * Separate from `createRedisCacheAdapter` for the reason
 * `buildPostgresTenancyAdapter` is separate from its opener: a suite supplies a
 * connection it built against a container and still exercises the real store.
 * `close()` here closes the connection it was given, because the caller that
 * opened it is the caller that asked for the adapter.
 */
export function buildRedisCacheAdapter(connection: RedisConnection): RedisCacheAdapter {
  return {
    adapterName: "redis-cache",
    cache: createRedisCache(connection),
    idempotency: createRedisIdempotencyStore(connection),
    requests: createRedisRequestIdempotency(connection),
    close: () => connection.close(),
  };
}

/** Open the connection and build the adapter over it. */
export function createRedisCacheAdapter(options: RedisConnectionOptions): RedisCacheAdapter {
  return buildRedisCacheAdapter(createRedisConnection(options));
}
