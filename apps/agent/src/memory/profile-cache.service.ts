import { Inject, Injectable, Logger, Optional } from "@nestjs/common";
import type Redis from "ioredis";
import * as crypto from "crypto";
import { REDIS_TOKEN } from "../shared/redis.provider";

/**
 * Theme M.3 / M.4 — Redis-backed projection cache for per-user profile
 * blobs.
 *
 * Backs the turn-start `__user_profile` context block and the
 * `recall_user_profile` meta-tool. Profiles live in PlatosMemory
 * (kind="profile") since M.4 dropped the legacy blob; without this cache
 * every turn would pay a Prisma round-trip just to reassemble the blob
 * shape from N profile rows. Hit the cache first and fall through to
 * Prisma on miss.
 *
 * Keys are hashed so we don't leak raw scope IDs into Redis key strings
 * (keyspace stays short + opaque). TTL is short (10 min) so a missed
 * invalidation self-heals in under one idle session. Writers (the
 * `update_user_profile` meta-tool) must call `invalidate()` after a
 * successful memory-row write so the next reader sees fresh data.
 */
@Injectable()
export class ProfileCacheService {
  private readonly logger = new Logger(ProfileCacheService.name);
  private static readonly TTL_SECONDS = 10 * 60; // 10 minutes
  private static readonly PREFIX = "profile:";

  constructor(
    @Optional() @Inject(REDIS_TOKEN) private readonly redis?: Redis,
  ) {}

  /**
   * Compute the cache key for a (scope, agentId, userId) tuple. The scope
   * tuple is hashed (sha1, first 16 hex chars) to keep keys short. The
   * agentId + userId are included raw so manual Redis inspection is easy
   * in dev — they're not secrets.
   */
  private buildKey(
    scope: { organizationId: string; projectId: string; environmentId: string },
    agentId: string,
    userId: string,
  ): string {
    const scopeHash = crypto
      .createHash("sha1")
      .update(`${scope.organizationId}|${scope.projectId}|${scope.environmentId}`)
      .digest("hex")
      .slice(0, 16);
    return `${ProfileCacheService.PREFIX}${scopeHash}:${agentId}:${userId}`;
  }

  /**
   * GET. Returns null on miss, on Redis error, or on malformed payload.
   * Never throws — the caller should fall through to Prisma.
   */
  async get(
    scope: { organizationId: string; projectId: string; environmentId: string },
    agentId: string,
    userId: string,
  ): Promise<Record<string, unknown> | null> {
    if (!this.redis) return null;
    const key = this.buildKey(scope, agentId, userId);
    try {
      const raw = await this.redis.get(key);
      if (!raw) return null;
      const parsed = JSON.parse(raw);
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
        return parsed as Record<string, unknown>;
      }
      return null;
    } catch (err: any) {
      this.logger.debug(
        `[profile-cache] GET failed key=${key}: ${err?.message || err}`,
      );
      return null;
    }
  }

  /**
   * SET with TTL. Swallows errors — cache is best-effort.
   */
  async set(
    scope: { organizationId: string; projectId: string; environmentId: string },
    agentId: string,
    userId: string,
    data: Record<string, unknown>,
  ): Promise<void> {
    if (!this.redis) return;
    const key = this.buildKey(scope, agentId, userId);
    try {
      await this.redis.set(
        key,
        JSON.stringify(data),
        "EX",
        ProfileCacheService.TTL_SECONDS,
      );
    } catch (err: any) {
      this.logger.debug(
        `[profile-cache] SET failed key=${key}: ${err?.message || err}`,
      );
    }
  }

  /**
   * DEL. Called by `remember_user_profile` after a successful memory-row
   * write so the next reader does not serve stale data. Swallows errors.
   */
  async invalidate(
    scope: { organizationId: string; projectId: string; environmentId: string },
    agentId: string,
    userId: string,
  ): Promise<void> {
    if (!this.redis) return;
    const key = this.buildKey(scope, agentId, userId);
    try {
      await this.redis.del(key);
    } catch (err: any) {
      this.logger.debug(
        `[profile-cache] DEL failed key=${key}: ${err?.message || err}`,
      );
    }
  }
}
