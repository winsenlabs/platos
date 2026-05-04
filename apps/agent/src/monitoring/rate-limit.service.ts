import { Injectable, Inject } from "@nestjs/common";
import { REDIS_TOKEN } from "../shared/redis.provider";
import type Redis from "ioredis";
import type { RequestScope } from "../auth/scope.guard";
import { env } from "../shared/env";

type ScopeTuple = Pick<RequestScope, "organizationId" | "projectId" | "environmentId">;

export type RateLimitWindow = "minute" | "hour" | "day";

export interface RateLimitResult {
  allowed: boolean;
  limit: number;
  remaining: number;
  window: RateLimitWindow;
  retryAfterSeconds: number;
  key: string;
}

export interface RateLimitOptions {
  /** Per-user per-minute cap on messages. 0 disables. */
  perUserPerMinute?: number;
  /** Per-user per-hour cap on messages. 0 disables. */
  perUserPerHour?: number;
  /** Per-user per-day cap on messages. 0 disables. */
  perUserPerDay?: number;
  /** Per-(agent, user) per-minute cap on tool calls. 0 disables. */
  perAgentUserToolPerMinute?: number;
}

/**
 * Theme H.8 — Redis token-bucket rate limits.
 *
 * Mirrors the PPR-10 pattern (`agent.controller.ts:replayToolAudit`):
 *   - INCR with TTL on first hit
 *   - compare count to budget
 *   - return structured result with retryAfterSeconds
 *
 * Applied at two hot paths:
 *   1. Per-user message rate (minute/hour/day) — `checkUserMessage`
 *   2. Per-(agent, user) tool-call rate — `checkToolCall`
 */
@Injectable()
export class RateLimitService {
  private readonly defaults: Required<RateLimitOptions>;

  constructor(@Inject(REDIS_TOKEN) private readonly redis: Redis) {
    this.defaults = {
      perUserPerMinute: env.PLATOS_USER_RATE_PER_MIN ?? 20,
      perUserPerHour: env.PLATOS_USER_RATE_PER_HOUR ?? 200,
      perUserPerDay: env.PLATOS_USER_RATE_PER_DAY ?? 1000,
      perAgentUserToolPerMinute: env.PLATOS_AGENT_USER_TOOL_RATE_PER_MIN ?? 60,
    };
  }

  /**
   * Per-user message gate — enforce minute/hour/day budgets. Returns the
   * first window that would be exceeded, or an `allowed: true` result when
   * all budgets have headroom.
   *
   * The implementation issues all three INCRs in one pipeline to keep the
   * hot-path cost identical whether the budget is hit or not.
   */
  async checkUserMessage(
    scope: ScopeTuple,
    userId: string,
    opts: RateLimitOptions = {},
  ): Promise<RateLimitResult> {
    const perMin = opts.perUserPerMinute ?? this.defaults.perUserPerMinute;
    const perHour = opts.perUserPerHour ?? this.defaults.perUserPerHour;
    const perDay = opts.perUserPerDay ?? this.defaults.perUserPerDay;
    const s = this.scopeKey(scope);
    const now = Date.now();
    const minuteBucket = Math.floor(now / 60_000);
    const hourBucket = Math.floor(now / 3_600_000);
    const dayBucket = Math.floor(now / 86_400_000);
    const keys = {
      min: `rl:user:${s}:${userId}:m:${minuteBucket}`,
      hr: `rl:user:${s}:${userId}:h:${hourBucket}`,
      d: `rl:user:${s}:${userId}:d:${dayBucket}`,
    };

    const pipeline = this.redis.pipeline();
    pipeline.incr(keys.min);
    pipeline.expire(keys.min, 70);
    pipeline.incr(keys.hr);
    pipeline.expire(keys.hr, 3700);
    pipeline.incr(keys.d);
    pipeline.expire(keys.d, 86_500);
    const results = await pipeline.exec();
    const minCount = (results?.[0]?.[1] as number) || 0;
    const hourCount = (results?.[2]?.[1] as number) || 0;
    const dayCount = (results?.[4]?.[1] as number) || 0;

    if (perMin > 0 && minCount > perMin) {
      return {
        allowed: false,
        limit: perMin,
        remaining: 0,
        window: "minute",
        retryAfterSeconds: 60 - Math.floor((now / 1000) % 60),
        key: keys.min,
      };
    }
    if (perHour > 0 && hourCount > perHour) {
      return {
        allowed: false,
        limit: perHour,
        remaining: 0,
        window: "hour",
        retryAfterSeconds: 3600 - Math.floor((now / 1000) % 3600),
        key: keys.hr,
      };
    }
    if (perDay > 0 && dayCount > perDay) {
      return {
        allowed: false,
        limit: perDay,
        remaining: 0,
        window: "day",
        retryAfterSeconds: 86400 - Math.floor((now / 1000) % 86400),
        key: keys.d,
      };
    }
    const remaining = Math.max(
      0,
      (perMin > 0 ? perMin - minCount : Infinity) as number,
    );
    return {
      allowed: true,
      limit: perMin,
      remaining: remaining === Infinity ? perMin : remaining,
      window: "minute",
      retryAfterSeconds: 0,
      key: keys.min,
    };
  }

  /**
   * Per-(agent, user) tool-call gate. Prevents a single user from draining
   * a shared agent's tool quota.
   */
  async checkToolCall(
    scope: ScopeTuple,
    agentId: string,
    userId: string,
    opts: RateLimitOptions = {},
  ): Promise<RateLimitResult> {
    const perMin = opts.perAgentUserToolPerMinute ?? this.defaults.perAgentUserToolPerMinute;
    if (perMin <= 0) {
      return {
        allowed: true,
        limit: 0,
        remaining: 0,
        window: "minute",
        retryAfterSeconds: 0,
        key: "disabled",
      };
    }
    const s = this.scopeKey(scope);
    const now = Date.now();
    const bucket = Math.floor(now / 60_000);
    const key = `rl:tool:${s}:${agentId}:${userId}:m:${bucket}`;
    const count = await this.redis.incr(key);
    if (count === 1) await this.redis.expire(key, 70);
    if (count > perMin) {
      return {
        allowed: false,
        limit: perMin,
        remaining: 0,
        window: "minute",
        retryAfterSeconds: 60 - Math.floor((now / 1000) % 60),
        key,
      };
    }
    return {
      allowed: true,
      limit: perMin,
      remaining: Math.max(0, perMin - count),
      window: "minute",
      retryAfterSeconds: 0,
      key,
    };
  }

  /**
   * PRELAUNCH-A3-9 — org-wide minute / day request gate. Mirrors the
   * RateLimitGuard semantics for transports that bypass HTTP guards
   * (WebSocket message handler, MCP gateway). Same Redis keys + TTLs.
   */
  async checkOrgRequest(
    scope: ScopeTuple,
  ): Promise<{
    allowed: boolean;
    bucket: "org_per_minute" | "org_per_day" | "ok";
    limit: number;
    count: number;
    retryAfterSeconds: number;
  }> {
    const perMin = env.PLATOS_RATE_LIMIT_PER_MIN ?? 60;
    const perDay = env.PLATOS_RATE_LIMIT_PER_DAY ?? 1000;
    const scopeId = `${scope.organizationId}:${scope.projectId}:${scope.environmentId}`;
    // PRELAUNCH-A3-8 minute-bucket fix is already encoded here via the
    // floor-divide pattern.
    const minuteBucket = Math.floor(Date.now() / 60_000);
    const dayKey = `rl:day:${scopeId}:${new Date().toISOString().slice(0, 10)}`;
    const minuteKey = `rl:min:${scopeId}:${minuteBucket}`;

    const pipeline = this.redis.pipeline();
    pipeline.incr(minuteKey);
    pipeline.expire(minuteKey, 70);
    pipeline.incr(dayKey);
    pipeline.expire(dayKey, 86_500);
    let results: any;
    try {
      results = await pipeline.exec();
    } catch {
      return { allowed: true, bucket: "ok", limit: perMin, count: 0, retryAfterSeconds: 0 };
    }
    const minuteCount = (results?.[0]?.[1] as number) || 0;
    const dayCount = (results?.[2]?.[1] as number) || 0;
    const now = Date.now();

    if (perMin > 0 && minuteCount > perMin) {
      return {
        allowed: false,
        bucket: "org_per_minute",
        limit: perMin,
        count: minuteCount,
        retryAfterSeconds: 60 - Math.floor((now / 1000) % 60),
      };
    }
    if (perDay > 0 && dayCount > perDay) {
      return {
        allowed: false,
        bucket: "org_per_day",
        limit: perDay,
        count: dayCount,
        retryAfterSeconds: 86400 - Math.floor((now / 1000) % 86400),
      };
    }
    return { allowed: true, bucket: "ok", limit: perMin, count: minuteCount, retryAfterSeconds: 0 };
  }

  /**
   * PRELAUNCH-A3-11 — per-(agent, user) approval-event rate cap. Prevents
   * a misbehaving agent from firing unlimited approval modals at one user.
   * Default 20/hr; caller passes 0 to disable.
   */
  async checkApprovalEvent(
    scope: ScopeTuple,
    agentId: string,
    userId: string,
    perHour: number = env.PLATOS_AGENT_USER_APPROVAL_PER_HOUR ?? 20,
  ): Promise<RateLimitResult> {
    if (perHour <= 0) {
      return {
        allowed: true,
        limit: 0,
        remaining: 0,
        window: "hour",
        retryAfterSeconds: 0,
        key: "disabled",
      };
    }
    const s = this.scopeKey(scope);
    const now = Date.now();
    const bucket = Math.floor(now / 3_600_000);
    const key = `rl:approval:${s}:${agentId}:${userId}:h:${bucket}`;
    const count = await this.redis.incr(key);
    if (count === 1) await this.redis.expire(key, 3700);
    if (count > perHour) {
      return {
        allowed: false,
        limit: perHour,
        remaining: 0,
        window: "hour",
        retryAfterSeconds: 3600 - Math.floor((now / 1000) % 3600),
        key,
      };
    }
    return {
      allowed: true,
      limit: perHour,
      remaining: Math.max(0, perHour - count),
      window: "hour",
      retryAfterSeconds: 0,
      key,
    };
  }

  /**
   * Introspection endpoint for the governance dashboard — returns the
   * current counters without incrementing. Useful for the rate-limit
   * violation panel so operators see "who's close to the cap".
   */
  async peek(
    scope: ScopeTuple,
    userId: string,
  ): Promise<{ minute: number; hour: number; day: number }> {
    const s = this.scopeKey(scope);
    const now = Date.now();
    const minuteBucket = Math.floor(now / 60_000);
    const hourBucket = Math.floor(now / 3_600_000);
    const dayBucket = Math.floor(now / 86_400_000);
    const pipeline = this.redis.pipeline();
    pipeline.get(`rl:user:${s}:${userId}:m:${minuteBucket}`);
    pipeline.get(`rl:user:${s}:${userId}:h:${hourBucket}`);
    pipeline.get(`rl:user:${s}:${userId}:d:${dayBucket}`);
    const results = await pipeline.exec();
    return {
      minute: parseInt((results?.[0]?.[1] as string) || "0", 10),
      hour: parseInt((results?.[1]?.[1] as string) || "0", 10),
      day: parseInt((results?.[2]?.[1] as string) || "0", 10),
    };
  }

  private scopeKey(scope: ScopeTuple): string {
    return `${scope.organizationId}:${scope.projectId}:${scope.environmentId}`;
  }
}
