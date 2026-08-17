import { env } from "~/env.server";
import { authorizationRateLimitMiddleware } from "./authorizationRateLimitMiddleware.server";
import { Duration } from "./rateLimiter.server";

export const apiRateLimiter = authorizationRateLimitMiddleware({
  redis: {
    port: env.RATE_LIMIT_REDIS_PORT,
    host: env.RATE_LIMIT_REDIS_HOST,
    username: env.RATE_LIMIT_REDIS_USERNAME,
    password: env.RATE_LIMIT_REDIS_PASSWORD,
    tlsDisabled: env.RATE_LIMIT_REDIS_TLS_DISABLED === "true",
    clusterMode: env.RATE_LIMIT_REDIS_CLUSTER_MODE_ENABLED === "1",
  },
  keyPrefix: "api",
  defaultLimiter: {
    type: "tokenBucket",
    refillRate: env.API_RATE_LIMIT_REFILL_RATE,
    interval: env.API_RATE_LIMIT_REFILL_INTERVAL as Duration,
    maxTokens: env.API_RATE_LIMIT_MAX,
  },
  limiterCache: {
    fresh: 60_000 * 10, // Data is fresh for 10 minutes
    stale: 60_000 * 20, // Date is stale after 20 minutes
    maxItems: 1000,
  },
  pathMatchers: [/^\/api/],
  pathWhiteList: [
    "/api/v1/timezones",
    // Platos attachment routes are cookie-authenticated Remix routes, not
    // token-authenticated API routes — no Authorization header is present.
    /^\/api\/v1\/agent\/attachments/,
    // Phase 3 — public docs REST API. Unauthenticated by design;
    // per-IP rate limit lives in `services/publicDocs.server.ts`. Without
    // this whitelist entry the apiRateLimiter middleware rejects every
    // request as "No authorization header provided".
    /^\/api\/v1\/public\/(docs|guides|search)/,
  ],
  log: {
    rejections: env.API_RATE_LIMIT_REJECTION_LOGS_ENABLED === "1",
    requests: env.API_RATE_LIMIT_REQUEST_LOGS_ENABLED === "1",
    limiter: env.API_RATE_LIMIT_LIMITER_LOGS_ENABLED === "1",
  },
});

export type RateLimitMiddleware = ReturnType<typeof authorizationRateLimitMiddleware>;
