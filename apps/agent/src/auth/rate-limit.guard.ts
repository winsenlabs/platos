import { Injectable, CanActivate, ExecutionContext, HttpException, HttpStatus, Inject, Optional } from "@nestjs/common";
import { REDIS_TOKEN } from "../shared/redis.provider";
import type Redis from "ioredis";
import type { RequestScope } from "./scope.guard";
import { env } from "../shared/env";
import { SafetyEventService } from "../monitoring/safety-event.service";

/**
 * RateLimitGuard — per-scope AND per-user rate limiting for the agent API.
 *
 * Limits (defaults):
 *   - 60 requests / min / scope (PLATOS_RATE_LIMIT_PER_MIN)
 *   - 1000 requests / day / scope (PLATOS_RATE_LIMIT_PER_DAY)
 *   - 30 requests / min / user-within-scope (PLATOS_RATE_LIMIT_USER_PER_MIN)
 *     — EOBD.12: prevents one user from draining the scope's minute budget.
 *
 * Paths skipped entirely: `/api/health`, `/test/*`, `/metrics`.
 * All other paths rate-limit regardless of HTTP method (EOBD.12 — the
 * prior blanket GET skip left expensive reads like trace-build, memory
 * search, and monitoring aggregates unbounded).
 *
 * Uses Redis INCR with TTL for atomic counting.
 * Applied globally via APP_GUARD alongside ScopeGuard.
 */
@Injectable()
export class RateLimitGuard implements CanActivate {
  private perMinLimit: number;
  private perDayLimit: number;
  private userPerMinLimit: number;

  constructor(
    @Inject(REDIS_TOKEN) private readonly redis: Redis,
    /**
     * PRELAUNCH-A3-4 — Optional so guard wiring stays load-bearing even
     * when MonitoringModule isn't on the import graph (test contexts).
     */
    @Optional() private readonly safetyEventService?: SafetyEventService,
  ) {
    this.perMinLimit = env.PLATOS_RATE_LIMIT_PER_MIN ?? 60;
    this.perDayLimit = env.PLATOS_RATE_LIMIT_PER_DAY ?? 1000;
    this.userPerMinLimit = env.PLATOS_RATE_LIMIT_USER_PER_MIN ?? 30;
  }

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const request = context.switchToHttp().getRequest();
    const response = context.switchToHttp().getResponse();
    const url: string = request.url || "";

    // EOBD.12 — skip ONLY the truly free endpoints; remove the prior
    // blanket GET skip so expensive reads (trace build, memory search,
    // /api/v1/agent/evals, /monitoring/*) are limited too.
    if (
      url.startsWith("/api/health") ||
      url.startsWith("/test/") ||
      url.startsWith("/metrics")
    ) {
      return true;
    }

    const scope = request.scope as RequestScope | undefined;
    if (!scope) return true; // No scope = no rate limit (will be caught by ScopeGuard)

    const scopeId = `${scope.organizationId}:${scope.projectId}:${scope.environmentId}`;
    // PRELAUNCH-A3-10 — anonymous traffic guard. When PLATOS_REQUIRE_USER_ID
    // is true, requests with no scope.userId are rejected with 401 instead
    // of being collapsed into a shared "anon" bucket (which makes per-user
    // wildcard caps impossible to enforce).
    if (env.PLATOS_REQUIRE_USER_ID && !scope.userId) {
      throw new HttpException(
        {
          code: "user_id_required",
          error: "Requests must include an end-user identifier.",
          message:
            "PLATOS_REQUIRE_USER_ID is enabled — set X-Platos-User-Id (or include userId in the session token) before retrying.",
        },
        HttpStatus.UNAUTHORIZED,
      );
    }
    const userId = scope.userId || "anon";
    // PRELAUNCH-A3-8 — bucket the minute counter on Math.floor(now/60_000)
    // instead of now.getMinutes(). The latter cycled 0..59 across hours,
    // so the TTL kept refreshing on each INCR and the counter never
    // expired under steady load. The Math.floor(now/60_000) form matches
    // RateLimitService.checkUserMessage and gives true rolling minutes.
    const minuteBucket = Math.floor(Date.now() / 60_000);
    const minuteKey = `rl:min:${scopeId}:${minuteBucket}`;
    const dayKey = `rl:day:${scopeId}:${new Date().toISOString().slice(0, 10)}`;
    // EOBD.12 — per-user sub-bucket so one abusive user can't drain
    // the scope's minute budget for their teammates.
    const userMinKey = `rl:umin:${scopeId}:${userId}:${minuteBucket}`;

    // Atomic INCR + EXPIRE via pipeline (single RTT)
    const pipeline = this.redis.pipeline();
    pipeline.incr(minuteKey);
    pipeline.expire(minuteKey, 60);
    pipeline.incr(dayKey);
    pipeline.expire(dayKey, 86400);
    pipeline.incr(userMinKey);
    pipeline.expire(userMinKey, 60);
    let results: any;
    try {
      results = await pipeline.exec();
    } catch (err) {
      // Redis down → fail open (availability over rate limiting).
      // Matches existing fail-open behaviour in cost/budget services.
      return true;
    }

    const minuteCount = (results?.[0]?.[1] as number) || 0;
    const dayCount = (results?.[2]?.[1] as number) || 0;
    const userMinCount = (results?.[4]?.[1] as number) || 0;

    // Compute retry-after based on the current minute boundary so the
    // client doesn't wait longer than the bucket actually rolls.
    const retryAfterMin = 60 - Math.floor((Date.now() / 1000) % 60);
    const retryAfterDay = 86400 - Math.floor((Date.now() / 1000) % 86400);

    // PRELAUNCH-A3-4 — log every rate-limit denial to the safety-event
    // ledger so the governance dashboard timeline reflects enforcement
    // (was previously aliased onto "exfiltration" or not logged at all).
    const recordDenial = (
      detail: string,
      meta: Record<string, unknown>,
    ): void => {
      if (!this.safetyEventService) return;
      this.safetyEventService
        .record(
          {
            organizationId: scope.organizationId,
            projectId: scope.projectId,
            environmentId: scope.environmentId,
          },
          {
            detector: "rate_limit",
            action: "block",
            severity: "medium",
            detail,
            meta,
            userId: scope.userId ?? null,
          },
        )
        .catch(() => undefined); // fail-open: never break the throw path
    };

    // Per-user first — narrower bucket, most likely to trip.
    if (userMinCount > this.userPerMinLimit) {
      if (response?.setHeader) response.setHeader("Retry-After", String(retryAfterMin));
      recordDenial(`user_per_minute exceeded (${userMinCount}/${this.userPerMinLimit})`, {
        bucket: "user_per_minute",
        count: userMinCount,
        limit: this.userPerMinLimit,
      });
      throw new HttpException(
        {
          code: "rate_limit",
          error: "Rate limit reached for this user.",
          message: `Rate limit reached. Try again in ${retryAfterMin} seconds.`,
          scope: "user_per_minute",
          limit: this.userPerMinLimit,
          retryAfterSeconds: retryAfterMin,
        },
        HttpStatus.TOO_MANY_REQUESTS,
      );
    }

    if (minuteCount > this.perMinLimit) {
      if (response?.setHeader) response.setHeader("Retry-After", String(retryAfterMin));
      recordDenial(`org_per_minute exceeded (${minuteCount}/${this.perMinLimit})`, {
        bucket: "org_per_minute",
        count: minuteCount,
        limit: this.perMinLimit,
      });
      throw new HttpException(
        {
          code: "rate_limit",
          error: "Rate limit reached for this organization.",
          message: `Rate limit reached. Try again in ${retryAfterMin} seconds.`,
          scope: "org_per_minute",
          limit: this.perMinLimit,
          retryAfterSeconds: retryAfterMin,
        },
        HttpStatus.TOO_MANY_REQUESTS,
      );
    }

    if (dayCount > this.perDayLimit) {
      if (response?.setHeader) response.setHeader("Retry-After", String(retryAfterDay));
      recordDenial(`org_per_day exceeded (${dayCount}/${this.perDayLimit})`, {
        bucket: "org_per_day",
        count: dayCount,
        limit: this.perDayLimit,
      });
      throw new HttpException(
        {
          code: "rate_limit",
          error: "Daily rate limit reached for this organization.",
          message: "Daily message limit reached. Limit resets at 00:00 UTC.",
          scope: "org_per_day",
          limit: this.perDayLimit,
          retryAfterSeconds: retryAfterDay,
        },
        HttpStatus.TOO_MANY_REQUESTS,
      );
    }

    return true;
  }
}
