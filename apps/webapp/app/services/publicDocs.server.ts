/**
 * Phase 3 — public-docs server adapter.
 *
 * Wraps `@internal/docs.DocRepository` for the webapp + sets up the
 * 60 req/min/IP rate limiter that fronts every `/api/v1/public/*` route.
 *
 * Resolves `contentRoot` from `PLATOS_DOCS_CONTENT_ROOT` if set, otherwise
 * walks up from `process.cwd()` looking for a `content/docs` directory.
 * In dev `cwd` is `apps/webapp`, so we step up two levels by default.
 */

import * as path from "node:path";
import * as fs from "node:fs";
import { DocRepository, getSharedRepository } from "@internal/docs";
import { Ratelimit } from "@upstash/ratelimit";
import { env } from "~/env.server";
import {
  createRedisRateLimitClient,
  type RateLimitResponse,
} from "./rateLimiter.server";
import { logger } from "./logger.server";

let _repo: DocRepository | null = null;
let _limiter: Ratelimit | null = null;

function resolveContentRoot(): string {
  const configured = env.PLATOS_DOCS_CONTENT_ROOT;
  if (configured && configured.trim()) {
    return path.resolve(configured.trim());
  }
  // Walk up from cwd looking for `content/docs`. In dev cwd is
  // apps/webapp; in prod containers we expect the explicit env var.
  let current = process.cwd();
  for (let i = 0; i < 6; i += 1) {
    const candidate = path.join(current, "content", "docs");
    try {
      if (fs.statSync(candidate).isDirectory()) {
        return current;
      }
    } catch {
      // not here
    }
    const parent = path.dirname(current);
    if (parent === current) break;
    current = parent;
  }
  // Last resort — return cwd; the repository will treat missing dirs
  // as empty + the API surface 404s gracefully.
  return process.cwd();
}

/** Lazy-instantiated process-singleton repository. */
export function getPublicDocsRepository(): DocRepository {
  if (_repo) return _repo;
  const contentRoot = resolveContentRoot();
  // Tests / production both use the shared singleton via our wrapper;
  // we pin watchMtime=true so dev edits to content/*.md are picked up
  // without a server restart.
  _repo = getSharedRepository({ contentRoot, watchMtime: true });
  return _repo;
}

/**
 * Rate-limit guard for public docs endpoints. 60 req / 60s per IP.
 *
 * Reuses the existing Redis rate-limit infra (`createRedisRateLimitClient`)
 * so we share infra with the rest of the webapp's rate limits — keys are
 * prefixed `ratelimit:public-docs:` to avoid bucket collisions.
 */
function getLimiter(): Ratelimit {
  if (_limiter) return _limiter;
  _limiter = new Ratelimit({
    redis: createRedisRateLimitClient({
      port: env.RATE_LIMIT_REDIS_PORT,
      host: env.RATE_LIMIT_REDIS_HOST,
      username: env.RATE_LIMIT_REDIS_USERNAME,
      password: env.RATE_LIMIT_REDIS_PASSWORD,
      tlsDisabled: env.RATE_LIMIT_REDIS_TLS_DISABLED === "true",
      clusterMode: env.RATE_LIMIT_REDIS_CLUSTER_MODE_ENABLED === "1",
    }),
    limiter: Ratelimit.slidingWindow(60, "60 s"),
    prefix: "ratelimit:public-docs",
    analytics: false,
    ephemeralCache: new Map(),
  });
  return _limiter;
}

export interface RateLimitOutcome {
  ok: boolean;
  limit: number;
  remaining: number;
  reset: number;
  retryAfterSeconds: number;
}

/** Resolve the client IP from incoming Remix `Request` headers. */
export function clientIpFromRequest(request: Request): string {
  const headers = request.headers;
  const forwarded = headers.get("x-forwarded-for");
  if (forwarded) {
    const first = forwarded.split(",")[0]?.trim();
    if (first) return first;
  }
  const real = headers.get("x-real-ip");
  if (real) return real.trim();
  // Remix doesn't expose the underlying socket address; fall back to a
  // shared bucket so we still rate-limit when the proxy forgot the
  // header. Acceptable degradation for a public read-only endpoint.
  return "unknown";
}

export async function checkPublicDocsRateLimit(ip: string): Promise<RateLimitOutcome> {
  try {
    const result: RateLimitResponse = await getLimiter().limit(`ip:${ip}`);
    const retryAfterSeconds = Math.max(0, Math.ceil((result.reset - Date.now()) / 1000));
    return {
      ok: result.success,
      limit: result.limit,
      remaining: result.remaining,
      reset: result.reset,
      retryAfterSeconds,
    };
  } catch (err) {
    // Rate-limit infra outage must not 500 the public docs API. Log + allow.
    logger.warn("public-docs rate limiter degraded; allowing request", {
      err: err instanceof Error ? err.message : String(err),
    });
    return { ok: true, limit: 60, remaining: 60, reset: Date.now() + 60_000, retryAfterSeconds: 0 };
  }
}

/** Common headers applied to every public docs response. */
export function publicDocsResponseHeaders(): Headers {
  const h = new Headers();
  h.set("Cache-Control", "public, max-age=600, stale-while-revalidate=86400");
  h.set("Access-Control-Allow-Origin", "*");
  h.set("Access-Control-Allow-Methods", "GET, OPTIONS");
  h.set("Access-Control-Allow-Headers", "Content-Type, Authorization");
  h.set("Access-Control-Max-Age", "86400");
  h.set("X-Content-Type-Options", "nosniff");
  return h;
}

/** Build a 429 response body when the rate limiter rejects a request. */
export function rateLimitedResponse(retryAfterSeconds: number): Response {
  const headers = publicDocsResponseHeaders();
  headers.set("Content-Type", "application/json");
  headers.set("Retry-After", String(Math.max(1, retryAfterSeconds)));
  return new Response(
    JSON.stringify({
      error: "rate_limited",
      message: "Too many requests. Try again shortly.",
      retryAfterSeconds: Math.max(1, retryAfterSeconds),
    }),
    { status: 429, headers },
  );
}
