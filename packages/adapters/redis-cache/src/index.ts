// The published surface of `@platos/adapter-redis-cache`.
//
// Only `apps/core-api` may import it (`adapters-only-from-core`), and it imports
// no other adapter (`adapter-is-self-contained`). What it publishes is what the
// composition root needs to bind THREE ports and to close one connection — and
// the connection seam, so a suite can drive the stores against a container
// without this package deciding how a test reaches one.

export type { RedisCacheAdapter } from "./adapter.js";
export { buildRedisCacheAdapter, createRedisCacheAdapter } from "./adapter.js";
export type { RedisConnection, RedisConnectionOptions } from "./client.js";
export { createRedisConnection } from "./client.js";
export type { RedisIdempotencyStore } from "./idempotency-store.js";
export { createRedisIdempotencyStore, reservationKey } from "./idempotency-store.js";
export { createRedisCache } from "./cache.js";
export type { RedisRequestIdempotency } from "./request-idempotency.js";
export { createRedisRequestIdempotency, requestReservationKey } from "./request-idempotency.js";
