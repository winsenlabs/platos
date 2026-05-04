import { Injectable, Inject } from "@nestjs/common";
import { REDIS_TOKEN } from "../shared/redis.provider";
import type Redis from "ioredis";
import { env } from "../shared/env";

/**
 * WorkingMemoryService — Layer 2 of the memory system.
 *
 * Short-term, per-conversation context stored in Redis.
 * Automatically cleared when conversation ends or times out.
 *
 * Contains:
 * - Active tool results (avoid re-searching the same thing)
 * - Detected entities (names, companies mentioned in this session)
 * - Pending actions (approval flows)
 * - User preferences detected during conversation
 *
 * All data is scoped by thread_id. TTL: 1 hour (configurable).
 */
@Injectable()
export class WorkingMemoryService {
  private ttl: number;

  constructor(@Inject(REDIS_TOKEN) private readonly redis: Redis) {
    this.ttl = env.PLATOS_WORKING_MEMORY_TTL ?? 3600;
  }

  private key(threadId: string, field: string): string {
    return `wm:${threadId}:${field}`;
  }

  /** Store a value in working memory for this thread */
  async set(threadId: string, field: string, value: unknown): Promise<void> {
    await this.redis.set(this.key(threadId, field), JSON.stringify(value), "EX", this.ttl);
  }

  /** Get a value from working memory */
  async get<T = unknown>(threadId: string, field: string): Promise<T | null> {
    const raw = await this.redis.get(this.key(threadId, field));
    if (!raw) return null;
    try { return JSON.parse(raw) as T; } catch { return null; }
  }

  /** Delete a value */
  async del(threadId: string, field: string): Promise<void> {
    await this.redis.del(this.key(threadId, field));
  }

  /** Store a tool result for caching (avoid re-calling the same tool) */
  async cacheToolResult(threadId: string, toolName: string, params: Record<string, unknown>, result: unknown): Promise<void> {
    const cacheKey = `tool:${toolName}:${JSON.stringify(params)}`;
    await this.set(threadId, cacheKey, result);
  }

  /** Get a cached tool result */
  async getCachedToolResult(threadId: string, toolName: string, params: Record<string, unknown>): Promise<unknown | null> {
    const cacheKey = `tool:${toolName}:${JSON.stringify(params)}`;
    return this.get(threadId, cacheKey);
  }

  /** Add a detected entity to the session */
  async addEntity(threadId: string, entity: { type: string; name: string; id?: string }): Promise<void> {
    const entities = await this.getEntities(threadId);
    // Dedup by name
    if (!entities.find((e) => e.name === entity.name && e.type === entity.type)) {
      entities.push(entity);
      await this.set(threadId, "entities", entities);
    }
  }

  /** Get all detected entities for this session */
  async getEntities(threadId: string): Promise<Array<{ type: string; name: string; id?: string }>> {
    return (await this.get(threadId, "entities")) || [];
  }

  /** Store a pending action (approval flow) */
  async setPendingAction(threadId: string, actionId: string, data: Record<string, unknown>): Promise<void> {
    await this.set(threadId, `action:${actionId}`, data);
  }

  /** Get a pending action */
  async getPendingAction(threadId: string, actionId: string): Promise<Record<string, unknown> | null> {
    return this.get(threadId, `action:${actionId}`);
  }

  /** Clear all working memory for a thread (on conversation end) */
  async clearThread(threadId: string): Promise<void> {
    // Scan and delete all keys for this thread
    const pattern = `wm:${threadId}:*`;
    const keys = await this.redis.keys(pattern);
    if (keys.length > 0) {
      // ioredis keyPrefix means we need to strip prefix for del
      const pipeline = this.redis.pipeline();
      for (const k of keys) {
        pipeline.del(k);
      }
      await pipeline.exec();
    }
  }

  /** Get a summary of what's in working memory for context injection */
  async getContextSummary(threadId: string): Promise<string> {
    const entities = await this.getEntities(threadId);
    if (entities.length === 0) return "";

    const entityList = entities.map((e) => `${e.type}: ${e.name}`).join(", ");
    return `[Working Memory] Entities mentioned in this conversation: ${entityList}`;
  }
}
