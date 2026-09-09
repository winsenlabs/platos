// The published surface of `@platos/adapter-redis-ratelimit`.
//
// Only `apps/core-api` may import it (`adapters-only-from-core`), and it imports
// no other adapter (`adapter-is-self-contained`). What it publishes is what the
// composition root needs to bind ONE port and to close one connection — and the
// connection seam, so a suite can drive the limiter against a container, or
// against a connection that rejects every command, without this package deciding
// how a test reaches either.

export type { RedisRatelimitAdapter } from "./adapter.js";
export { buildRedisRatelimitAdapter, createRedisRatelimitAdapter } from "./adapter.js";
export type { RateLimitConnection, RateLimitConnectionOptions } from "./client.js";
export { createRateLimitConnection } from "./client.js";
export { bucketKey, createRedisRateLimiter, reclamationTtlMs } from "./rate-limiter.js";
