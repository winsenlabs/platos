import { Injectable, Inject, Optional, Logger } from "@nestjs/common";
import { REDIS_TOKEN } from "../shared/redis.provider";
import type Redis from "ioredis";
import { createHash } from "crypto";

/**
 * PIFSP-8 — Layer-1 static-prefix prompt cache.
 *
 * Caches the assembled system prompt per (agentId, versionId, toolMode)
 * in Redis with a 10-minute TTL. Saves re-fetching + re-assembling on every
 * turn. Eager invalidation on agent save/update.
 *
 * This is the Platos-side cache; Layer 2 is Anthropic cacheControl on the
 * outbound message (5-min Anthropic sliding window, handled in agent.service.ts).
 */
@Injectable()
export class PromptCacheService {
  private readonly logger = new Logger(PromptCacheService.name);
  private readonly TTL_SEC = 600; // 10 minutes
  private readonly KEY_PREFIX = "prompt:static";

  constructor(
    @Optional() @Inject(REDIS_TOKEN) private readonly redis: Redis | null,
  ) {}

  private buildKey(agentId: string, versionId: string | null, toolMode: string, isSubAgent: boolean): string {
    const v = versionId ?? "current";
    const sub = isSubAgent ? "sub" : "main";
    return `${this.KEY_PREFIX}:${agentId}:${v}:${toolMode}:${sub}`;
  }

  async get(
    agentId: string,
    versionId: string | null,
    toolMode: string,
    isSubAgent: boolean,
  ): Promise<string | null> {
    if (!this.redis) return null;
    try {
      const key = this.buildKey(agentId, versionId, toolMode, isSubAgent);
      const raw = await this.redis.get(key);
      if (raw) {
        this.logger.debug(`[prompt-cache] agent=${agentId} versionId=${versionId ?? "current"} mode=${toolMode} isSubAgent=${isSubAgent} HIT`);
        return raw;
      }
      this.logger.debug(`[prompt-cache] agent=${agentId} versionId=${versionId ?? "current"} mode=${toolMode} isSubAgent=${isSubAgent} MISS`);
    } catch (err: any) {
      this.logger.warn(`[prompt-cache] get error: ${err?.message}`);
    }
    return null;
  }

  async set(
    agentId: string,
    versionId: string | null,
    toolMode: string,
    isSubAgent: boolean,
    systemPrompt: string,
  ): Promise<void> {
    if (!this.redis) return;
    try {
      const key = this.buildKey(agentId, versionId, toolMode, isSubAgent);
      await this.redis.set(key, systemPrompt, "EX", this.TTL_SEC);
      this.logger.debug(`[prompt-cache] agent=${agentId} versionId=${versionId ?? "current"} mode=${toolMode} isSubAgent=${isSubAgent} STORED len=${systemPrompt.length}`);
    } catch (err: any) {
      this.logger.warn(`[prompt-cache] set error: ${err?.message}`);
    }
  }

  /** Invalidate all cache keys for an agent (called on agent update). */
  async invalidate(agentId: string): Promise<void> {
    if (!this.redis) return;
    try {
      const pattern = `${this.KEY_PREFIX}:${agentId}:*`;
      const keys: string[] = [];
      let cursor = "0";
      do {
        const [nextCursor, batch] = await this.redis.scan(cursor, "MATCH", pattern, "COUNT", 50);
        cursor = nextCursor;
        keys.push(...batch);
      } while (cursor !== "0");
      if (keys.length > 0) {
        await this.redis.del(...keys);
        this.logger.debug(`[prompt-cache] invalidated ${keys.length} key(s) for agent=${agentId}`);
      }
    } catch (err: any) {
      this.logger.warn(`[prompt-cache] invalidate error: ${err?.message}`);
    }
  }
}
