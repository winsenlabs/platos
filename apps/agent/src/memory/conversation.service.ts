import { Injectable, Inject, Optional } from "@nestjs/common";
import { PRISMA_TOKEN } from "../shared/database.provider";
import { REDIS_TOKEN } from "../shared/redis.provider";
import type Redis from "ioredis";
import type { RequestScope } from "../auth/scope.guard";
import { MessageCryptoService } from "../monitoring/message-crypto.service";
import { env } from "../shared/env";

export interface StoredMessage {
  id: string;
  threadId: string;
  role: "user" | "assistant" | "tool";
  content: string | null;
  toolCalls: any[] | null;
  thinkingContent: string | null;
  responseJson: any | null;
  createdAt: Date;
}

export interface Thread {
  id: string;
  agentId: string;
  organizationId: string;
  projectId: string;
  environmentId: string;
  userId: string;
  platosEndUserId?: string | null;
  title: string | null;
  status: string;
  turnCount: number;
  compactedSummary: string | null;
  /**
   * Theme F.10 — thread metadata surface. Tags are user-assignable,
   * normalised (lowercase, trimmed, deduped) and capped to 20 per thread
   * with each tag max 50 chars. `pinnedAt` + `archivedAt` power the
   * conversation-list pin/archive affordances.
   */
  tags: string[];
  pinnedAt: Date | null;
  archivedAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
}

/**
 * Theme F.10 — normalise a user-supplied tag list.
 *
 * Rules:
 *   - Lowercase + trim each tag.
 *   - Drop empties after trim.
 *   - Cap individual tag length at MAX_TAG_LENGTH (excess truncated).
 *   - De-duplicate while preserving first-seen order.
 *   - Throw if the distinct count exceeds MAX_TAGS_PER_THREAD.
 *   - Throw on non-string / non-array input so the caller surfaces a 400.
 */
export const MAX_TAG_LENGTH = 50;
export const MAX_TAGS_PER_THREAD = 20;

export function normalizeTags(input: unknown): string[] {
  if (!Array.isArray(input)) {
    throw new Error("tags must be an array of strings");
  }
  const seen = new Set<string>();
  const out: string[] = [];
  for (const raw of input) {
    if (typeof raw !== "string") {
      throw new Error("tags must be an array of strings");
    }
    const normalised = raw.trim().toLowerCase().slice(0, MAX_TAG_LENGTH);
    if (normalised.length === 0) continue;
    if (seen.has(normalised)) continue;
    seen.add(normalised);
    out.push(normalised);
  }
  if (out.length > MAX_TAGS_PER_THREAD) {
    throw new Error(`too many tags (max ${MAX_TAGS_PER_THREAD})`);
  }
  return out;
}

/**
 * ConversationService — Layer 1 of the memory system.
 *
 * Handles conversation thread CRUD and message persistence.
 * Every message is stored in PostgreSQL (PlatosAgentMessage).
 * This is automatic — the developer doesn't configure it.
 *
 * All queries are scoped by (organizationId, projectId, environmentId, userId).
 */
@Injectable()
export class ConversationService {
  private prisma: any; // Runtime-loaded PrismaClient

  constructor(
    @Inject(PRISMA_TOKEN) prisma: any,
    @Inject(REDIS_TOKEN) private readonly redis: Redis,
    // Optional so existing test fixtures that new up ConversationService
    // without the monitoring module keep compiling. When absent, writes go
    // through as plaintext (matches the pre-H.4 behaviour exactly).
    @Optional() private readonly crypto?: MessageCryptoService,
  ) {
    this.prisma = prisma;
  }

  /**
   * Theme H.4 — apply write-side encryption to message content fields.
   * Returns the data Payload to store, with `content` / `thinkingContent`
   * replaced by ciphertext and `encKeyVersion` set when a key is
   * available. When no key is configured, the fields pass through
   * unchanged and encKeyVersion stays null.
   */
  private applyEncryption(data: {
    content: string | null;
    thinkingContent: string | null;
  }): { content: string | null; thinkingContent: string | null; encKeyVersion: number | null } {
    if (!this.crypto?.available) {
      return { ...data, encKeyVersion: null };
    }
    let encKeyVersion: number | null = null;
    let content = data.content;
    let thinkingContent = data.thinkingContent;
    if (content) {
      const enc = this.crypto.encrypt(content);
      if (enc) {
        content = enc.ciphertext;
        encKeyVersion = enc.keyVersion;
      }
    }
    if (thinkingContent) {
      const enc = this.crypto.encrypt(thinkingContent);
      if (enc) {
        thinkingContent = enc.ciphertext;
        encKeyVersion = encKeyVersion ?? enc.keyVersion;
      }
    }
    return { content, thinkingContent, encKeyVersion };
  }

  /**
   * Theme H.4 — apply read-side decryption. Works transparently across
   * mixed plaintext + ciphertext rows (encKeyVersion null → passthrough).
   */
  private applyDecryption<T extends { content?: string | null; thinkingContent?: string | null; encKeyVersion?: number | null }>(
    row: T | null,
  ): T | null {
    if (!row || !this.crypto) return row;
    const kv = row.encKeyVersion ?? null;
    if (!kv) return row;
    return {
      ...row,
      content: this.crypto.decryptIfNeeded(row.content ?? null, kv),
      thinkingContent: this.crypto.decryptIfNeeded(row.thinkingContent ?? null, kv),
    };
  }

  // ═══════════════════════════════════════════════════════
  // Threads
  // ═══════════════════════════════════════════════════════

  async createThread(
    scope: RequestScope,
    agentId: string,
    title?: string,
    opts?: { displayName?: string; email?: string },
  ): Promise<Thread> {
    // PPR-58 — fail-closed scope check. `findUnique({id})` + a JS-side scope
    // compare leaks "agent exists in some other scope" via a distinct error
    // message; it also breaks the invariant that scope tuple is authoritative
    // (§5.1 — every scoped row filtered by (org, project, env) at query time,
    // never at app layer). Switch to `findFirst` with the full scope in the
    // WHERE clause so an agent from a different scope looks identical to one
    // that doesn't exist, and the only path that escapes the guard is the
    // auto-create for the requested scope.
    const anyAgent = await this.prisma.platosAgent.findFirst({
      where: {
        id: agentId,
        organizationId: scope.organizationId,
        projectId: scope.projectId,
        environmentId: scope.environmentId,
      },
    });
    if (!anyAgent) {
      // First-use auto-create. Use a unique slug derived from id to avoid
      // collisions (slug is unique per project+env).
      const uniqueSlug = `${agentId}-${Date.now().toString(36)}`;
      await this.prisma.platosAgent.create({
        data: {
          id: agentId,
          name: agentId === "default" ? "Default Agent" : agentId,
          slug: uniqueSlug,
          model: env.PLATOS_DEFAULT_MODEL || "anthropic:claude-sonnet-4-6",
          organizationId: scope.organizationId,
          projectId: scope.projectId,
          environmentId: scope.environmentId,
        },
      });
    }

    // Lazy upsert PlatosEndUser — one row per unique end-user within the scope.
    // `externalUserId` = the opaque user id forwarded by the entity backend.
    // Fails open so a PlatosEndUser upsert hiccup never blocks thread creation.
    let platosEndUserId: string | null = null;
    if (scope.userId) {
      try {
        const endUser = await (this.prisma as any).platosEndUser.upsert({
          where: {
            // Prisma auto-generates this key from the @@unique field names (not the `map:` SQL name)
            organizationId_projectId_environmentId_externalUserId: {
              organizationId: scope.organizationId,
              projectId: scope.projectId,
              environmentId: scope.environmentId,
              externalUserId: scope.userId,
            },
          },
          update: {
            lastActiveAt: new Date(),
            threadCount: { increment: 1 },
            ...(opts?.displayName ? { displayName: opts.displayName } : {}),
            ...(opts?.email ? { email: opts.email } : {}),
          },
          create: {
            organizationId: scope.organizationId,
            projectId: scope.projectId,
            environmentId: scope.environmentId,
            externalUserId: scope.userId,
            displayName: opts?.displayName ?? null,
            email: opts?.email ?? null,
            threadCount: 1,
            lastActiveAt: new Date(),
          },
        });
        platosEndUserId = endUser.id as string;
      } catch {
        // Fail open — thread creation must succeed even if PlatosEndUser upsert fails.
      }
    }

    return this.prisma.platosAgentThread.create({
      data: {
        agentId,
        organizationId: scope.organizationId,
        projectId: scope.projectId,
        environmentId: scope.environmentId,
        userId: scope.userId,
        // LAUNCH-12 — record the actual logged-in operator. In Postman mode
        // `scope.userId` is the simulated user; `scope.operatorUserId` (set
        // by the WS gateway when the override fires) is the real one.
        // Outside Postman the two are identical, so we always fall back to
        // userId to keep the column populated for every new row.
        createdByUserId: scope.operatorUserId ?? scope.userId,
        title,
        status: "active",
        turnCount: 0,
        ...(platosEndUserId ? { platosEndUserId } : {}),
        // PRA-AC: stamp cluster FK when the creating agent is a cluster member.
        ...(scope.clusteringId ? { clusteringId: scope.clusteringId } : {}),
      },
    });
  }

  /** Update a PlatosEndUser's display metadata when richer info becomes available (e.g. from sessionContext). */
  async enrichEndUser(
    scope: Pick<RequestScope, "organizationId" | "projectId" | "environmentId">,
    externalUserId: string,
    meta: { displayName?: string | null; email?: string | null },
  ): Promise<void> {
    if (!externalUserId || (!meta.displayName && !meta.email)) return;
    try {
      // Only backfill — don't overwrite values already set (null guard per field)
      await (this.prisma as any).platosEndUser.updateMany({
        where: {
          organizationId: scope.organizationId,
          projectId: scope.projectId,
          environmentId: scope.environmentId,
          externalUserId,
          displayName: null,
        },
        data: {
          ...(meta.displayName ? { displayName: meta.displayName } : {}),
          ...(meta.email ? { email: meta.email } : {}),
        },
      });
    } catch {
      // Fire-and-forget enrichment; never propagate.
    }
  }

  async getThread(threadId: string, scope: RequestScope): Promise<Thread | null> {
    // PRA-AC: cluster members can read any thread with the same clusteringId + userId.
    // An agent without a cluster can only read its own threads (agentId or userId match).
    // IDOR: scope tuple (org/project/env) is always enforced.
    // LAUNCH-12 — additionally let the operator open threads they created
    // even when the row's `userId` was overridden to a Postman-simulated
    // user. Scope tuple is still enforced; the OR clause widens to either
    // the row owner or the original creator.
    const ownershipOr = [
      { userId: scope.userId },
      { createdByUserId: scope.userId },
    ];
    const baseWhere = {
      id: threadId,
      organizationId: scope.organizationId,
      projectId: scope.projectId,
      environmentId: scope.environmentId,
      OR: ownershipOr,
    };

    if (scope.clusteringId) {
      // Try cluster-scoped first (for cross-agent thread visibility),
      // then fall back to own-thread lookup. Must await before ?? —
      // PrismaPromise is never null, so unawaited ?? is always the first branch.
      const withCluster = await this.prisma.platosAgentThread.findFirst({
        where: { ...baseWhere, clusteringId: scope.clusteringId },
      });
      if (withCluster) return withCluster;
    }

    return this.prisma.platosAgentThread.findFirst({ where: baseWhere });
  }

  /** PRA-AC: list all threads visible to this agent, including cluster siblings' threads. */
  async listThreadsForCluster(
    scope: RequestScope,
    clusterId: string,
    options: { limit?: number; offset?: number } = {},
  ): Promise<{ threads: Thread[]; total: number }> {
    const where = {
      organizationId: scope.organizationId,
      projectId: scope.projectId,
      environmentId: scope.environmentId,
      userId: scope.userId,
      clusteringId: clusterId,
    };
    const [threads, total] = await Promise.all([
      this.prisma.platosAgentThread.findMany({
        where,
        orderBy: { updatedAt: "desc" },
        take: options.limit ?? 20,
        skip: options.offset ?? 0,
      }),
      this.prisma.platosAgentThread.count({ where }),
    ]);
    return { threads, total };
  }

  async listThreads(
    scope: RequestScope,
    options: {
      agentId?: string;
      status?: string;
      limit?: number;
      offset?: number;
      /**
       * Theme F.10 — filter to a single tag (AND with other filters).
       * The caller-supplied value is normalised the same way tags are
       * stored so case / whitespace variants still match.
       */
      tag?: string;
      /**
       * Theme F.10 — when true, returns only threads with `pinnedAt` set.
       * When false/undefined, does not filter on pinned status.
       */
      pinned?: boolean;
      /**
       * Theme F.10 — archive visibility.
       *   - undefined / false  → hide archived (the default — archive
       *     should feel like "out of sight").
       *   - true               → include both active + archived.
       *   - "only"             → return only archived threads.
       */
      archived?: boolean | "only";
      /** When true, omits the userId filter — returns all threads in scope.
       *  Used by the operator conversations list so threads created under
       *  a simulated/end-user userId are still visible to the platform owner. */
      allUsers?: boolean;
    } = {},
  ): Promise<{ threads: Thread[]; total: number }> {
    const where: any = {
      organizationId: scope.organizationId,
      projectId: scope.projectId,
      environmentId: scope.environmentId,
    };
    if (!options.allUsers) {
      // LAUNCH-12 — the operator can see threads they created even if
      // `userId` was overridden to a simulated user via Postman. We OR the
      // standard userId match against `createdByUserId` for that case.
      // For threads created before LAUNCH-12 (no createdByUserId), the
      // userId clause still applies.
      where.OR = [
        { userId: scope.userId },
        { createdByUserId: scope.userId },
      ];
    }
    if (options.agentId) where.agentId = options.agentId;
    if (options.status) where.status = options.status;

    // Theme F.10 — tag filter. `has` does the contains-one-of-many lookup on
    // Postgres string[] columns. We normalise first so the caller doesn't
    // have to match the storage casing exactly.
    if (options.tag && typeof options.tag === "string") {
      const [normalised] = normalizeTags([options.tag]);
      if (normalised) where.tags = { has: normalised };
    }

    // Theme F.10 — pinned filter. Only applied when truthy; `false` is a
    // no-op so `?pinned=false` doesn't accidentally hide pinned threads.
    if (options.pinned === true) {
      where.pinnedAt = { not: null };
    }

    // Theme F.10 — archive visibility. Default behaviour hides archived so
    // users don't see soft-deleted threads in the normal list (Theme F §1.4
    // — "archived threads are still readable, just hidden from default
    // lists").
    if (options.archived === "only") {
      where.archivedAt = { not: null };
    } else if (options.archived !== true) {
      where.archivedAt = null;
    }

    const [threads, total] = await Promise.all([
      this.prisma.platosAgentThread.findMany({
        where,
        // Theme F.10 — pinned threads float to the top of the default list.
        // Inside each bucket we keep the most-recently-updated first.
        orderBy: [{ pinnedAt: { sort: "desc", nulls: "last" } }, { updatedAt: "desc" }],
        take: options.limit || 20,
        skip: options.offset || 0,
      }),
      this.prisma.platosAgentThread.count({ where }),
    ]);

    return { threads, total };
  }

  async updateThread(threadId: string, scope: RequestScope, data: { title?: string; status?: string }): Promise<Thread> {
    return this.prisma.platosAgentThread.updateMany({
      where: {
        id: threadId,
        organizationId: scope.organizationId,
        projectId: scope.projectId,
        environmentId: scope.environmentId,
        userId: scope.userId,
      },
      data,
    });
  }

  /**
   * PIFSP-20 — soft delete (archive). Never hard-deletes the row.
   * Hard purge is admin-tier only (K.18 admin MCP tools).
   */
  async deleteThread(threadId: string, scope: RequestScope): Promise<{ archived: boolean; archivedAt: string | null }> {
    const now = new Date();
    const result = await this.prisma.platosAgentThread.updateMany({
      where: {
        id: threadId,
        organizationId: scope.organizationId,
        projectId: scope.projectId,
        environmentId: scope.environmentId,
        userId: scope.userId,
      },
      data: { status: "archived", archivedAt: now },
    });
    return { archived: result.count > 0, archivedAt: result.count > 0 ? now.toISOString() : null };
  }

  /** PIFSP-20 — rename a thread (1–200 chars, no newlines). */
  async renameThread(threadId: string, scope: RequestScope, title: string | null): Promise<{ threadId: string; title: string | null; updatedAt: string } | null> {
    const sanitized = title === null ? null : title.replace(/[\r\n]/g, " ").trim().slice(0, 200) || null;
    const now = new Date();
    const result = await this.prisma.platosAgentThread.updateMany({
      where: {
        id: threadId,
        organizationId: scope.organizationId,
        projectId: scope.projectId,
        environmentId: scope.environmentId,
        userId: scope.userId,
      },
      data: { title: sanitized, updatedAt: now },
    });
    if (result.count === 0) return null;
    return { threadId, title: sanitized, updatedAt: now.toISOString() };
  }

  // ═══════════════════════════════════════════════════════
  // Theme F.10 — thread metadata mutations
  //
  // Every mutation is gated by the scope tuple (Theme A invariant §5.1).
  // We use `updateMany { where: { id, ...scope } }` + null-check the count
  // instead of `update { where: { id } }` so that a mismatched scope fails
  // closed (count === 0 → throw "not found"), never revealing that the id
  // exists in another scope.
  // ═══════════════════════════════════════════════════════

  private async findScopedThread(threadId: string, scope: RequestScope): Promise<Thread> {
    const thread = await this.getThread(threadId, scope);
    if (!thread) throw new Error("Thread not found or access denied");
    return thread;
  }

  /**
   * Set the full tag list on a thread (idempotent — replaces, does not append).
   *
   * Tags are normalised server-side: lowercase, trimmed, deduped, capped at
   * {@link MAX_TAGS_PER_THREAD} entries with each tag ≤ {@link MAX_TAG_LENGTH}
   * chars. This keeps the filter index small + predictable and matches the
   * normaliser used by {@link listThreads} so the same string round-trips.
   */
  async setThreadTags(threadId: string, scope: RequestScope, tags: unknown): Promise<Thread> {
    await this.findScopedThread(threadId, scope);
    const normalised = normalizeTags(tags);
    const result = await this.prisma.platosAgentThread.updateMany({
      where: {
        id: threadId,
        organizationId: scope.organizationId,
        projectId: scope.projectId,
        environmentId: scope.environmentId,
        userId: scope.userId,
      },
      data: { tags: normalised },
    });
    if (result.count === 0) throw new Error("Thread not found or access denied");
    return this.findScopedThread(threadId, scope);
  }

  /**
   * Toggle the pinned state of a thread.
   *
   * If `pinned` is supplied (true | false) the thread is forced to that state
   * — otherwise the current `pinnedAt` is flipped. Returns the freshly-read
   * row so the caller can re-render the thread list immediately.
   */
  async togglePin(
    threadId: string,
    scope: RequestScope,
    pinned?: boolean,
  ): Promise<Thread> {
    const thread = await this.findScopedThread(threadId, scope);
    const shouldPin = typeof pinned === "boolean" ? pinned : thread.pinnedAt === null;
    const result = await this.prisma.platosAgentThread.updateMany({
      where: {
        id: threadId,
        organizationId: scope.organizationId,
        projectId: scope.projectId,
        environmentId: scope.environmentId,
        userId: scope.userId,
      },
      data: { pinnedAt: shouldPin ? new Date() : null },
    });
    if (result.count === 0) throw new Error("Thread not found or access denied");
    return this.findScopedThread(threadId, scope);
  }

  /**
   * Archive a thread (soft — the row + messages stay queryable, the thread
   * simply drops out of the default conversation list).
   *
   * Idempotent: re-archiving a thread updates `archivedAt` to the new
   * timestamp. Archive ≠ delete (Theme F.10 hard-constraint §4).
   *
   * PPR-43 — Artifact retention policy:
   *   Archiving a thread does NOT cascade an archive flag onto the thread's
   *   `PlatosAgentArtifact` rows. Artifacts are intentionally decoupled from
   *   the parent thread's lifecycle so that (a) consumers can keep referencing
   *   them through the webapp artifact viewer after the surrounding
   *   conversation is shelved, and (b) cross-thread artifact reuse (forking,
   *   revision chains) isn't broken by an archive on any single thread. The
   *   artifacts remain queryable by `threadId` and inherit the scope tuple
   *   from the original thread — scope filtering at read time stays correct.
   *
   *   Deletion is a separate concern: if the parent thread is ever hard
   *   deleted (not just archived), artifacts cascade via the existing
   *   foreign-key relation. A future scheduled sweep may archive artifacts
   *   attached to threads whose `archivedAt` is older than N days — tracked
   *   as a P5 follow-up, NOT wired here.
   */
  async archiveThread(threadId: string, scope: RequestScope): Promise<Thread> {
    await this.findScopedThread(threadId, scope);
    const result = await this.prisma.platosAgentThread.updateMany({
      where: {
        id: threadId,
        organizationId: scope.organizationId,
        projectId: scope.projectId,
        environmentId: scope.environmentId,
        userId: scope.userId,
      },
      data: { status: "archived", archivedAt: new Date() },
    });
    if (result.count === 0) throw new Error("Thread not found or access denied");
    return this.findScopedThread(threadId, scope);
  }

  /**
   * Clear the archivedAt marker and reset status to active.
   * Idempotent — unarchiving an already-active thread is a no-op.
   */
  async unarchiveThread(threadId: string, scope: RequestScope): Promise<Thread> {
    await this.findScopedThread(threadId, scope);
    const result = await this.prisma.platosAgentThread.updateMany({
      where: {
        id: threadId,
        organizationId: scope.organizationId,
        projectId: scope.projectId,
        environmentId: scope.environmentId,
        userId: scope.userId,
      },
      data: { status: "active", archivedAt: null },
    });
    if (result.count === 0) throw new Error("Thread not found or access denied");
    return this.findScopedThread(threadId, scope);
  }

  // ═══════════════════════════════════════════════════════
  // Messages
  // ═══════════════════════════════════════════════════════

  async storeMessage(
    threadId: string,
    scope: RequestScope,
    message: {
      role: "user" | "assistant" | "tool";
      content?: string;
      toolCalls?: any[];
      thinkingContent?: string;
      responseJson?: any;
      /**
       * Theme F — per-turn system prompt override. When set on a user message
       * it indicates the ensuing assistant turn was generated with a different
       * system prompt than the agent's stored config. Surfaces in the fork /
       * edit-and-rerun replay paths so history is faithful.
       */
      systemPromptOverride?: string | null;
      /**
       * Theme F.5 — per-turn output schema. JSON Schema (or Zod-serialised)
       * describing the required shape of the assistant's response. Persisted
       * verbatim so the history replay on fork / edit-and-rerun keeps the
       * exact same enforcement.
       */
      outputSchema?: any;
      /** PRA-TC: sub-thread reply. When set, this message is a reply to the
       *  referenced message. Depth=1 enforced: parent must have threadReplyToId=null. */
      threadReplyToId?: string | null;
      /** PRA-AC: which cluster agent wrote this message. NULL for single-agent turns. */
      authorAgentId?: string | null;
    },
  ): Promise<StoredMessage> {
    // Verify thread belongs to this scope + user
    const thread = await this.getThread(threadId, scope);
    if (!thread) throw new Error("Thread not found or access denied");

    // PRA-TC: depth=1 enforcement — reject replies to replies.
    if (message.threadReplyToId) {
      const parent = await this.prisma.platosAgentMessage.findFirst({
        where: { id: message.threadReplyToId, threadId },
        select: { id: true, threadReplyToId: true },
      });
      if (!parent) throw new Error("Reply parent message not found in this thread");
      if (parent.threadReplyToId) throw new Error("Nested thread replies are not supported (max depth 1)");
    }

    // Theme H.4 — encrypt content + thinkingContent before durable write.
    // When no key is configured, this passes through unchanged and leaves
    // encKeyVersion null (legacy behaviour).
    const encrypted = this.applyEncryption({
      content: message.content || null,
      thinkingContent: message.thinkingContent || null,
    });

    const stored = await this.prisma.$transaction(async (tx: any) => {
      const msg = await tx.platosAgentMessage.create({
        data: {
          threadId,
          role: message.role,
          content: encrypted.content,
          toolCalls: message.toolCalls || null,
          thinkingContent: encrypted.thinkingContent,
          encKeyVersion: encrypted.encKeyVersion,
          responseJson: message.responseJson || null,
          systemPromptOverride: message.systemPromptOverride ?? null,
          outputSchema: message.outputSchema ?? null,
          threadReplyToId: message.threadReplyToId ?? null,
          authorAgentId: message.authorAgentId ?? null,
        },
      });

      // PRA-TC: atomically increment replyCount on the parent message.
      if (message.threadReplyToId) {
        await tx.platosAgentMessage.update({
          where: { id: message.threadReplyToId },
          data: { replyCount: { increment: 1 } },
        });
      }

      return msg;
    });

    // Increment turn count if user message on the main thread (not a sub-thread reply).
    if (message.role === "user" && !message.threadReplyToId) {
      await this.prisma.platosAgentThread.update({
        where: { id: threadId },
        data: {
          turnCount: { increment: 1 },
          updatedAt: new Date(),
        },
      });
    }

    // Return the decrypted view so callers (streaming runtime) see the
    // original plaintext they just wrote — avoids surprising
    // "write then immediately read back ciphertext" bugs.
    const decrypted = this.applyDecryption(stored);
    return (decrypted ?? stored) as StoredMessage;
  }

  async getMessages(
    threadId: string,
    scope: RequestScope,
    options: { limit?: number; offset?: number } = {},
  ): Promise<{ messages: StoredMessage[]; total: number }> {
    // Verify thread belongs to this scope + user
    const thread = await this.getThread(threadId, scope);
    if (!thread) return { messages: [], total: 0 };

    const where = { threadId };
    const [messages, total] = await Promise.all([
      this.prisma.platosAgentMessage.findMany({
        where,
        orderBy: { createdAt: "asc" },
        take: options.limit || 50,
        skip: options.offset || 0,
      }),
      this.prisma.platosAgentMessage.count({ where }),
    ]);

    // Theme H.4 — transparent decryption across mixed plaintext + ciphertext
    // rows. Rows with encKeyVersion=null pass through unchanged.
    const decrypted = messages.map((m: any) => this.applyDecryption(m) ?? m);
    return { messages: decrypted, total };
  }

  /**
   * Load conversation history formatted for the LLM.
   *
   * Default: loads the last `limit` main-thread messages (threadReplyToId IS NULL).
   *
   * PRA-TC hybrid context: when `replyToMessageId` is provided (sub-thread turn),
   * returns main thread history (truncated to `limit`) + a system injection
   * orienting the agent to the sub-thread + all prior replies in that sub-thread.
   * This gives the agent full context without polluting the main timeline.
   */
  async loadHistory(
    threadId: string,
    scope: RequestScope,
    limit: number = 20,
    replyToMessageId?: string | null,
  ): Promise<Array<{ role: "user" | "assistant"; content: string }>> {
    const thread = await this.getThread(threadId, scope);
    if (!thread) return [];

    // Main thread messages — always loaded, excludes sub-thread replies.
    const mainMessages = await this.prisma.platosAgentMessage.findMany({
      where: {
        threadId,
        role: { in: ["user", "assistant"] },
        status: "active",
        threadReplyToId: null,
      },
      orderBy: { createdAt: "desc" },
      take: limit,
      select: { role: true, content: true, encKeyVersion: true },
    });

    const decrypt = (m: any): string =>
      this.crypto
        ? (this.crypto.decryptIfNeeded(m.content, m.encKeyVersion) ?? "")
        : (m.content ?? "");

    const mainHistory = mainMessages
      .reverse()
      .map((m: any) => ({ role: m.role as "user" | "assistant", content: decrypt(m) }))
      .filter((m: { content: string }) => m.content);

    if (!replyToMessageId) return mainHistory;

    // PRA-TC hybrid: fetch the parent message text for context injection.
    const parentMsg = await this.prisma.platosAgentMessage.findFirst({
      where: { id: replyToMessageId, threadId },
      select: { content: true, encKeyVersion: true, role: true },
    });

    // Fetch all prior replies in this sub-thread.
    const threadReplies = await this.prisma.platosAgentMessage.findMany({
      where: {
        threadId,
        threadReplyToId: replyToMessageId,
        role: { in: ["user", "assistant"] },
        status: "active",
      },
      orderBy: { createdAt: "asc" },
      select: { role: true, content: true, encKeyVersion: true },
    });

    const parentContent = parentMsg ? decrypt(parentMsg) : "";
    const replyHistory = threadReplies
      .map((m: any) => ({ role: m.role as "user" | "assistant", content: decrypt(m) }))
      .filter((m: { content: string }) => m.content);

    // Assemble: main thread + user-role context framing + sub-thread replies.
    // NOTE: role:"system" cannot appear mid-conversation for Anthropic — it throws
    // "Multiple system messages separated by user/assistant messages". Use role:"user"
    // for the sub-thread framing so all providers accept the messages array.
    const framingContent = parentContent
      ? `[Sub-thread context: You are replying to this specific message in a side thread: "${parentContent}". Stay focused on this sub-topic while retaining awareness of the broader conversation above.]`
      : `[Sub-thread context: You are replying in a side thread. Stay focused on this sub-topic while retaining awareness of the broader conversation above.]`;

    return [
      ...mainHistory,
      { role: "user" as const, content: framingContent },
      ...replyHistory,
    ];
  }

  /** PRA-TC: fetch all replies in a sub-thread, ordered chronologically. */
  async getThreadReplies(
    threadId: string,
    messageId: string,
    scope: RequestScope,
  ): Promise<StoredMessage[]> {
    const thread = await this.getThread(threadId, scope);
    if (!thread) return [];

    const replies = await this.prisma.platosAgentMessage.findMany({
      where: { threadId, threadReplyToId: messageId, status: "active" },
      orderBy: { createdAt: "asc" },
    });

    return replies.map((m: any) => (this.applyDecryption(m) ?? m) as StoredMessage);
  }

  /** PRA-TC: batch-fetch replyCount for a set of message IDs. Avoids N+1 on thread load. */
  async batchGetReplyCounts(
    messageIds: string[],
    threadId: string,
    scope: RequestScope,
  ): Promise<Map<string, number>> {
    const out = new Map<string, number>();
    if (!messageIds.length) return out;

    const thread = await this.getThread(threadId, scope);
    if (!thread) return out;

    const rows = await this.prisma.platosAgentMessage.findMany({
      where: { id: { in: messageIds }, threadId },
      select: { id: true, replyCount: true },
    });

    for (const row of rows) out.set(row.id, row.replyCount);
    return out;
  }

  /**
   * Get or create a thread for a conversation.
   * If threadId is provided, verifies access and returns it.
   * If not, creates a new thread.
   */
  async getOrCreateThread(
    scope: RequestScope,
    agentId: string,
    threadId?: string,
  ): Promise<Thread> {
    if (threadId) {
      const existing = await this.getThread(threadId, scope);
      if (existing) return existing;
    }
    // PRA-AC: scope.clusteringId is stamped onto the new thread inside createThread.
    return this.createThread(scope, agentId);
  }

  // ═══════════════════════════════════════════════════════
  // Theme F — Conversation operations
  // ═══════════════════════════════════════════════════════

  /**
   * Fork a thread at a specific message.
   *
   * Creates a new thread in the same (org, project, env, userId) scope as the
   * parent, copies all messages with `createdAt <= upToMessage.createdAt` and
   * `status = "active"` (soft-deleted rows are skipped — edit-and-rerun lineage
   * is not carried into the fork), and records the lineage on the new row
   * via `parentThreadId` + `forkedFromMessageId`.
   *
   * Invariants:
   *   - Scope is preserved (Theme F §5.1): fork inherits parent's scope tuple.
   *   - `upToMessageId` must belong to the parent thread — otherwise rejected.
   *   - Soft limit (Theme F §6): max 10 live forks per parent thread; the
   *     11th throws a clear error. Forks that have themselves been deleted
   *     are not counted.
   */
  async forkThread(
    threadId: string,
    scope: RequestScope,
    options: { upToMessageId: string; title?: string },
  ): Promise<Thread> {
    const parent = await this.getThread(threadId, scope);
    if (!parent) throw new Error("Thread not found or access denied");

    const upTo = await this.prisma.platosAgentMessage.findFirst({
      where: { id: options.upToMessageId, threadId },
      select: { id: true, createdAt: true },
    });
    if (!upTo) {
      throw new Error(
        `Message ${options.upToMessageId} not found in thread ${threadId}`,
      );
    }

    // Soft limit — prevents runaway fork trees (Theme F §6).
    // PPR-47 — archived forks do NOT count against the 10-fork cap. The
    // user's mental model is "archive means out of sight"; keeping archived
    // forks in the count would make the 11th fork unreachable until the
    // user digs into the archive and hard-deletes something, violating the
    // archive-is-reversible contract (Theme F.10 §4).
    // EOBD.17 — scope-filter the fork-count query. Parent thread was
    // already scope-verified by getThread above; the count here is
    // defence-in-depth so we carry the scope tuple on every Platos read.
    const existingForkCount = await this.prisma.platosAgentThread.count({
      where: {
        organizationId: scope.organizationId,
        projectId: scope.projectId,
        environmentId: scope.environmentId,
        parentThreadId: threadId,
        archivedAt: null,
      },
    });
    if (existingForkCount >= 10) {
      throw new Error(
        `Thread ${threadId} already has ${existingForkCount} forks (max 10). Archive an existing fork first.`,
      );
    }

    // Load active messages through the fork point, in chronological order.
    const history = await this.prisma.platosAgentMessage.findMany({
      where: {
        threadId,
        status: "active",
        createdAt: { lte: upTo.createdAt },
      },
      orderBy: { createdAt: "asc" },
    });

    // Transactionally create the new thread + clone the history so a partial
    // write can never leave orphan messages in a ghost thread.
    const fork = await this.prisma.$transaction(async (tx: any) => {
      const newThread = await tx.platosAgentThread.create({
        data: {
          agentId: parent.agentId,
          organizationId: parent.organizationId,
          projectId: parent.projectId,
          environmentId: parent.environmentId,
          userId: parent.userId,
          // LAUNCH-12 — operator who performed the fork, real id (not
          // simulated) when in Postman mode. Falls back to parent.userId
          // for forks that pre-date the column.
          createdByUserId: scope.operatorUserId ?? scope.userId ?? parent.userId,
          title: options.title ?? (parent.title ? `${parent.title} (fork)` : "Fork"),
          status: "active",
          turnCount: history.filter((m: any) => m.role === "user").length,
          parentThreadId: threadId,
          forkedFromMessageId: upTo.id,
          // Carry forward compacted summary so the fork inherits long-memory.
          compactedSummary: parent.compactedSummary,
          tags: [],
        },
      });

      if (history.length > 0) {
        await tx.platosAgentMessage.createMany({
          data: history.map((m: any) => ({
            threadId: newThread.id,
            role: m.role,
            content: m.content,
            toolCalls: m.toolCalls ?? undefined,
            thinkingContent: m.thinkingContent,
            responseJson: m.responseJson ?? undefined,
            systemPromptOverride: m.systemPromptOverride,
            outputSchema: m.outputSchema ?? undefined,
            // EOBD.18 — CRITICAL: propagate the encryption-key version
            // alongside the ciphertext. The prior code copied `content`
            // + `thinkingContent` but not `encKeyVersion`, so the clone
            // landed with encKeyVersion=null (the default) and
            // `applyDecryption` treated it as plaintext — returning
            // the base64 ciphertext verbatim to the LLM on every read.
            // Theme H.4 silently broken by Theme F fork code pre-EOBD.
            encKeyVersion: m.encKeyVersion ?? null,
            // Clones are always the canonical row in the new thread, so reset
            // the soft-delete lineage to default.
            status: "active",
            revision: 1,
            editParentMessageId: null,
          })),
        });
      }

      return newThread;
    });

    return fork;
  }

  /**
   * Edit and rerun.
   *
   * Replaces the content of a USER message with `newContent` and soft-deletes
   * every subsequent message (status → "edited_out"). The caller is expected
   * to immediately kick off a new turn with the edited user message — the
   * streaming runtime picks up from there naturally because `loadHistory`
   * filters on `status = "active"`.
   *
   * Returns the new user message row (revision bumped, editParentMessageId points
   * at the prior active revision). The old row is preserved with
   * status="edited_out" so historical UI can still surface the edit trail.
   */
  async editAndRerun(
    threadId: string,
    messageId: string,
    scope: RequestScope,
    newContent: string,
  ): Promise<StoredMessage> {
    const thread = await this.getThread(threadId, scope);
    if (!thread) throw new Error("Thread not found or access denied");

    const target = await this.prisma.platosAgentMessage.findFirst({
      where: { id: messageId, threadId, status: "active" },
    });
    if (!target) throw new Error("Message not found or already edited out");
    if (target.role !== "user") {
      throw new Error("Only user messages may be edited (use retry for assistant)");
    }

    const result = await this.prisma.$transaction(async (tx: any) => {
      // Soft-delete everything from target onward — history must NEVER mutate
      // historical messages (Theme F invariant §5.2).
      await tx.platosAgentMessage.updateMany({
        where: {
          threadId,
          status: "active",
          createdAt: { gte: target.createdAt },
        },
        data: { status: "edited_out" },
      });

      // EOBD.19 — route new revision through applyEncryption. Without
      // this, every edit landed as plaintext while its siblings were
      // ciphertext — violates SPEC §5.13 invariant.
      const encrypted = this.applyEncryption({
        content: newContent,
        thinkingContent: null,
      });
      // Insert the fresh revision. editParentMessageId + revision walk up the chain.
      const next = await tx.platosAgentMessage.create({
        data: {
          threadId,
          role: "user",
          content: encrypted.content ?? "",
          encKeyVersion: encrypted.encKeyVersion,
          editParentMessageId: target.id,
          revision: (target.revision ?? 1) + 1,
          status: "active",
        },
      });

      // Re-point any attachments on the prior message to the new revision so
      // the retention task keeps them alive and the runtime can re-resolve.
      await tx.platosMessageAttachment.updateMany({
        where: { messageId: target.id },
        data: { messageId: next.id },
      });

      return next;
    });

    return result;
  }

  /**
   * Retry an assistant turn.
   *
   * Soft-deletes the target assistant message + any subsequent messages and
   * returns the surviving prior user message. The caller re-runs the user
   * message with (optionally) different model/temperature; the runtime then
   * writes a new assistant row with `editParentMessageId` pointing at the old one.
   */
  async retryAssistantTurn(
    threadId: string,
    messageId: string,
    scope: RequestScope,
  ): Promise<{ priorUserMessage: StoredMessage | null; retriedOut: string }> {
    const thread = await this.getThread(threadId, scope);
    if (!thread) throw new Error("Thread not found or access denied");

    const target = await this.prisma.platosAgentMessage.findFirst({
      where: { id: messageId, threadId, status: "active" },
    });
    if (!target) throw new Error("Message not found or already edited out");
    if (target.role !== "assistant") {
      throw new Error("Only assistant messages may be retried (use edit for user)");
    }

    // Find the user message immediately preceding this assistant turn.
    const priorUser = await this.prisma.platosAgentMessage.findFirst({
      where: {
        threadId,
        status: "active",
        role: "user",
        createdAt: { lt: target.createdAt },
      },
      orderBy: { createdAt: "desc" },
    });

    await this.prisma.platosAgentMessage.updateMany({
      where: {
        threadId,
        status: "active",
        createdAt: { gte: target.createdAt },
      },
      data: { status: "edited_out" },
    });

    return { priorUserMessage: priorUser ?? null, retriedOut: target.id };
  }

  /**
   * Theme F.9 — list artifacts for a thread.
   *
   * Returns rows grouped by `artifactKey` with the latest `revision` per
   * key so the chat UI's artifact panel can render current content + show
   * the full revision count. Scope-gated via `findScopedThread` — a
   * mismatched scope surfaces as "thread not found" and leaks nothing.
   *
   * Result shape is intentionally flat (no nested revisions) — the UI
   * pulls revisions on-demand when the user opens an artifact for detail.
   */
  async listThreadArtifacts(
    threadId: string,
    scope: RequestScope,
    options?: { limit?: number },
  ): Promise<
    Array<{
      id: string;
      artifactKey: string;
      revision: number;
      kind: string;
      title: string | null;
      language: string | null;
      content: string;
      metadata: Record<string, unknown> | null;
      createdAt: Date;
      revisionCount: number;
    }>
  > {
    // Gate on scoped thread existence — keeps the "artifacts for another
    // tenant's thread" attack surface closed.
    await this.findScopedThread(threadId, scope);

    const limit = Math.max(1, Math.min(options?.limit ?? 100, 500));

    // Pull every artifact row in the thread (ordered newest revision first)
    // then compact down to the latest revision per `artifactKey`. At thread
    // sizes we expect (tens of artifacts × a handful of revisions) this is
    // trivially fast and keeps the query shape simple — no window funcs.
    const rows: any[] = await this.prisma.platosAgentArtifact.findMany({
      where: {
        threadId,
        organizationId: scope.organizationId,
        projectId: scope.projectId,
        environmentId: scope.environmentId,
      },
      orderBy: [{ artifactKey: "asc" }, { revision: "desc" }],
    });

    const byKey = new Map<
      string,
      {
        id: string;
        artifactKey: string;
        revision: number;
        kind: string;
        title: string | null;
        language: string | null;
        content: string;
        metadata: Record<string, unknown> | null;
        createdAt: Date;
        revisionCount: number;
      }
    >();
    for (const row of rows) {
      const existing = byKey.get(row.artifactKey);
      if (!existing) {
        byKey.set(row.artifactKey, {
          id: row.id,
          artifactKey: row.artifactKey,
          revision: row.revision,
          kind: row.kind,
          title: row.title,
          language: row.language,
          content: row.content,
          metadata: (row.metadata as Record<string, unknown> | null) ?? null,
          createdAt: row.createdAt,
          revisionCount: 1,
        });
      } else {
        existing.revisionCount += 1;
      }
    }

    // Sort by createdAt DESC so "most recently committed artifact" floats
    // to the top of the panel.
    return Array.from(byKey.values())
      .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime())
      .slice(0, limit);
  }
}
