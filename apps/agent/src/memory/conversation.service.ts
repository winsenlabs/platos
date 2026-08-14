import { Injectable, Inject, Optional, Logger } from "@nestjs/common";
import { createHash } from "node:crypto";
import { PRISMA_TOKEN } from "../shared/database.provider";
import { REDIS_TOKEN } from "../shared/redis.provider";
import type Redis from "ioredis";
import type { RequestScope } from "../auth/scope.guard";
import { MessageCryptoService } from "../monitoring/message-crypto.service";
import { env } from "../shared/env";
import { configureExternalTriggerSdk } from "../shared/external-trigger-config";

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
  private readonly logger = new Logger(ConversationService.name);

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
    opts?: {
      displayName?: string;
      email?: string;
      /**
       * Subagent spawning — records CHILD-thread lineage on the pre-existing
       * self-relation `parentThreadId` column (schema.prisma
       * `PlatosAgentThreadForks`). Distinct semantics from `forkThread`: a
       * spawn creates an EMPTY child thread (no message history copied), it
       * just links the child back to the spawning parent so the runs/thread
       * tree shows the tree. See docs/subagent-spawning-spec.md.
       */
      parentThreadId?: string;
      /**
       * IDENTITY-CORE §C — single-end-user gate. When omitted, defaults to
       * `true` (web/API/direct threads: one token = one end user), preserving
       * today's behaviour byte-for-byte. Channel bindings pass `false` for
       * shared / non-DM threads so `resolveOriginEndUserId` fails closed and
       * per-user Composio-MCP never runs as the wrong human (G1). See
       * `resolveThreadBinding` / `resolveAppThreadBinding`.
       */
      singleEndUser?: boolean;
    },
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

    // Resolve the canonical end-user for this thread. When the session token
    // carried verified channel identities (email / phone / slack / …),
    // resolveEndUser links the thread to the existing person behind that
    // identity (link-not-merge); otherwise it falls back to the legacy
    // find-or-create by `externalUserId`. With no `scope.userIdentities` this is
    // byte-for-byte the old inline PlatosEndUser upsert. Fails open (returns
    // null) so a resolution hiccup never blocks thread creation. NOTE:
    // thread.userId below stays `scope.userId` — resolveEndUser only affects the
    // `platosEndUserId` FK, never thread scoping / ownership.
    let platosEndUserId: string | null = null;
    // IDENTITY-CORE §C (G1) — the gate flag stamped on the new row. Defaults to
    // the caller's opts (or true); overwritten by the parent's flag on the
    // subagent thread-copy path below.
    let singleEndUserForThread: boolean = opts?.singleEndUser ?? true;
    if (opts?.parentThreadId) {
      // IDENTITY-CORE §B.2 — subagent thread-copy. The child scope carries NO
      // `userIdentities`, so re-running resolveEndUser(childScope) would
      // re-derive by `externalUserId = scope.userId` and could land on a
      // DIFFERENT person than the parent's verified-claim person (or bypass the
      // §C gate). Instead, COPY the parent's scope-pinned `platosEndUserId` +
      // `singleEndUser` and SKIP resolveEndUser, so the child re-derives the
      // parent's exact adopted person. Isolation intact: the scope tuple is
      // still copied 1:1 by the caller; the person is inherited, never
      // client-chosen. Fail-closed: a null parent `platosEndUserId` (or a
      // parent gated closed) yields a null/false child → downstream fails
      // closed.
      const parentThread = await this.prisma.platosAgentThread.findFirst({
        where: {
          id: opts.parentThreadId,
          organizationId: scope.organizationId,
          projectId: scope.projectId,
          environmentId: scope.environmentId,
        },
        select: { platosEndUserId: true, singleEndUser: true },
      });
      platosEndUserId = parentThread?.platosEndUserId ?? null;
      // Explicit opts wins (extensibility); else inherit the parent's flag.
      singleEndUserForThread = opts.singleEndUser ?? parentThread?.singleEndUser ?? true;
    } else if (scope.userId) {
      platosEndUserId = await this.resolveEndUser(scope, {
        displayName: opts?.displayName,
        email: opts?.email,
        incrementThreadCount: true,
      });
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
        // IDENTITY-CORE §C (G1) — stamp the single-end-user gate. Default true
        // so web/API/direct threads are unchanged; channel bindings pass false
        // for shared / non-DM threads (fail-closed for {{endUserId}}); a
        // subagent child (§B.2) inherits the parent thread's flag.
        singleEndUser: singleEndUserForThread,
        ...(platosEndUserId ? { platosEndUserId } : {}),
        // PRA-AC: stamp cluster FK when the creating agent is a cluster member.
        ...(scope.clusteringId ? { clusteringId: scope.clusteringId } : {}),
        // Subagent spawning — link the child thread back to its spawning parent
        // (empty-history child, NOT a fork/clone).
        ...(opts?.parentThreadId ? { parentThreadId: opts.parentThreadId } : {}),
      },
    });
  }

  /**
   * Defensive re-application of the mint-time identity-claim bounds (see
   * `sanitizeUserIdentities` in session-token.controller.ts — the shared
   * contract: max 8 entries; channel /^[a-z0-9_-]{1,32}$/ after
   * trim+lowercase; handle control-chars stripped, trimmed, length 1..256;
   * invalid entries dropped silently).
   *
   * The controller mint path already enforces this, but the PRIMARY documented
   * mint path is local HMAC signing with `@platosdev/token-mint` — those
   * tokens reach `validateSessionToken` without ever passing through the
   * controller, so `scope.userIdentities` can carry malformed (non-string
   * channel/handle → Prisma validation throw → whole resolution nulled) or
   * unbounded (thousands of claims → DB fan-out on every thread create)
   * arrays. Re-capping here keeps resolveEndUser's DB work bounded and its
   * honest-path behaviour unchanged.
   */
  private sanitizeIdentityClaims(
    raw: unknown,
  ): Array<{ channel: string; handle: string; verified?: boolean }> {
    if (!Array.isArray(raw)) return [];
    const out: Array<{ channel: string; handle: string; verified?: boolean }> = [];
    for (const entry of raw) {
      if (out.length >= 8) break;
      if (!entry || typeof entry !== "object") continue;
      const channelRaw = (entry as Record<string, unknown>).channel;
      const handleRaw = (entry as Record<string, unknown>).handle;
      if (typeof channelRaw !== "string" || typeof handleRaw !== "string") continue;
      const channel = channelRaw.trim().toLowerCase();
      if (!/^[a-z0-9_-]{1,32}$/.test(channel)) continue;
      // Strip C0/C1 control chars + DEL (codepoints <=0x1F and 0x7F..0x9F).
      const handle = Array.from(handleRaw)
        .filter((ch) => {
          const c = ch.codePointAt(0) ?? 0;
          return !(c <= 0x1f || (c >= 0x7f && c <= 0x9f));
        })
        .join("")
        .trim();
      if (handle.length < 1 || handle.length > 256) continue;
      const verified = (entry as Record<string, unknown>).verified === true;
      out.push({ channel, handle, ...(verified ? { verified: true } : {}) });
    }
    return out;
  }

  /**
   * PII-safe log token for an identity handle: a short hash instead of the
   * raw email address / phone number, so plaintext container logs never carry
   * end-user contact PII (the encrypted-at-rest audit path is the place for
   * raw values, not Logger output).
   */
  private redactHandle(handle: string): string {
    return `sha256:${createHash("sha256").update(handle).digest("hex").slice(0, 12)}`;
  }

  /**
   * Resolve the canonical PlatosEndUser for a session — the identity graph
   * entry point. Returns the resolved `platosEndUserId`, or `null` on ANY
   * failure (fail-open — never throws, so it can never block thread creation).
   *
   * LINK-NOT-MERGE identity model. A person may be reached through several
   * channel identities (email, phone, slack, teams, whatsapp, telegram,
   * discord, web, …). We LINK identities to a person; we never MERGE two
   * people, and we never RE-POINT an identity that already belongs to someone
   * else. `scope.userIdentities` is populated only from validated non-guest
   * tokens (see scope.guard / auth.service). Controller-minted tokens are
   * sanitised at mint-time, but locally-minted tokens (@platosdev/token-mint)
   * are not — so the claim bounds are re-applied here defensively
   * (`sanitizeIdentityClaims`).
   *
   * Algorithm:
   *   (a) VERIFIED claims first — for each `verified === true` claim, look up
   *       PlatosEndUserIdentity by the (org, project, env, channel, handle)
   *       unique. Only a row that is itself `verified === true` may anchor
   *       (an unverified row is a non-authoritative link — letting it anchor
   *       would allow within-tenant identity squatting). First hit wins →
   *       that row's person is canonical. Bump its lastActiveAt (+ threadCount
   *       when asked) and backfill displayName / email only-if-null.
   *   (b) No verified hit → find-or-create PlatosEndUser by
   *       (org, project, env, externalUserId = scope.userId) — byte-for-byte
   *       the legacy inline upsert.
   *   (c) Attach EVERY claimed identity (verified or not) to the resolved
   *       person. A pre-existing identity pointing at a DIFFERENT person is
   *       SKIPPED with a warn — never re-pointed, never merged. Each attach is
   *       isolated so one conflict never aborts the rest.
   *
   * With no `scope.userIdentities` only step (b) runs, reproducing today's
   * behaviour exactly.
   */
  async resolveEndUser(
    scope: {
      organizationId: string;
      projectId: string;
      environmentId: string;
      userId: string;
      entityId?: string;
      userIdentities?: Array<{ channel: string; handle: string; verified?: boolean }>;
    },
    opts?: { displayName?: string; email?: string; incrementThreadCount?: boolean },
  ): Promise<string | null> {
    try {
      const { organizationId, projectId, environmentId } = scope;
      const claims = this.sanitizeIdentityClaims(scope.userIdentities);
      let resolvedId: string | null = null;

      // (a) VERIFIED claims first — canonical-person lookup by channel identity.
      for (const claim of claims) {
        if (claim.verified !== true) continue;
        const { channel, handle } = claim;
        // Per-claim isolation: one bad lookup degrades to the next claim /
        // the step-(b) fallback instead of nulling the whole resolution.
        try {
          const hit = await this.prisma.platosEndUserIdentity.findUnique({
            where: {
              // Prisma auto-derives this key from the @@unique field names.
              organizationId_projectId_environmentId_channel_handle: {
                organizationId,
                projectId,
                environmentId,
                channel,
                handle,
              },
            },
            include: { platosEndUser: true },
          });
          // SECURITY (identity squatting): only rows that are themselves
          // VERIFIED may anchor resolution. An unverified row is just a
          // non-authoritative link — if it could anchor, anyone in the tenant
          // could pre-claim someone else's handle with a verified:false claim
          // and permanently capture their sessions once the real owner shows
          // up with verified:true (scope-tuple-is-not-a-user-boundary class,
          // docs/security-audit-2026-07-16.md).
          if (hit?.platosEndUserId && hit.verified === true) {
            resolvedId = hit.platosEndUserId as string;
            const person = hit.platosEndUser;
            // Bump activity + backfill display metadata ONLY where currently null
            // (a verified identity must never clobber an existing name/email).
            // Best-effort: once resolvedId is anchored, an update failure must
            // NOT let a later claim reassign resolution (first-hit-wins) — so
            // the bump gets its own catch and the break is unconditional.
            try {
              await this.prisma.platosEndUser.update({
                where: { id: resolvedId },
                data: {
                  lastActiveAt: new Date(),
                  ...(opts?.incrementThreadCount ? { threadCount: { increment: 1 } } : {}),
                  ...(person && !person.displayName && opts?.displayName
                    ? { displayName: opts.displayName }
                    : {}),
                  ...(person && !person.email && opts?.email ? { email: opts.email } : {}),
                },
              });
            } catch {
              // activity-bump is non-essential; resolution is already anchored
            }
            break;
          }
        } catch {
          // Fail-open per claim — fall through to the next claim / step (b).
        }
      }

      // (b) No verified hit → find-or-create by externalUserId. This block is
      // byte-for-byte the legacy inline upsert (threadCount increment gated on
      // opts.incrementThreadCount, lastActiveAt bump, displayName/email
      // create-or-set-if-provided).
      if (!resolvedId && scope.userId) {
        const endUser = await this.prisma.platosEndUser.upsert({
          where: {
            // Prisma auto-generates this key from the @@unique field names (not the `map:` SQL name)
            organizationId_projectId_environmentId_externalUserId: {
              organizationId,
              projectId,
              environmentId,
              externalUserId: scope.userId,
            },
          },
          update: {
            lastActiveAt: new Date(),
            ...(opts?.incrementThreadCount ? { threadCount: { increment: 1 } } : {}),
            ...(opts?.displayName ? { displayName: opts.displayName } : {}),
            ...(opts?.email ? { email: opts.email } : {}),
          },
          create: {
            organizationId,
            projectId,
            environmentId,
            externalUserId: scope.userId,
            displayName: opts?.displayName ?? null,
            email: opts?.email ?? null,
            threadCount: opts?.incrementThreadCount ? 1 : 0,
            lastActiveAt: new Date(),
          },
        });
        resolvedId = endUser.id as string;
      }

      if (!resolvedId) return null;

      // (c) Attach EVERY claimed identity (verified or not) to the resolved
      // person. Each attach is isolated in its own try/catch so a single
      // conflict never aborts the rest (link-not-merge — an identity already
      // owned by a DIFFERENT person is left untouched + logged, never
      // re-pointed).
      for (const claim of claims) {
        const { channel, handle } = claim;
        try {
          await this.prisma.platosEndUserIdentity.create({
            data: {
              organizationId,
              projectId,
              environmentId,
              platosEndUserId: resolvedId,
              channel,
              handle,
              verified: claim.verified === true,
              sourceEntityId: scope.entityId ?? null,
            },
          });
        } catch {
          // Unique conflict — an identity row for (channel, handle) already
          // exists in this scope. If it points at a different person, warn and
          // leave it (link-not-merge); if it's the same person, this is just an
          // idempotent no-op.
          try {
            const existing = await this.prisma.platosEndUserIdentity.findUnique({
              where: {
                organizationId_projectId_environmentId_channel_handle: {
                  organizationId,
                  projectId,
                  environmentId,
                  channel,
                  handle,
                },
              },
              select: { platosEndUserId: true },
            });
            if (existing && existing.platosEndUserId !== resolvedId) {
              // PII: log a short hash of the handle, never the raw value —
              // handles are emails / phone numbers and Logger output is
              // plaintext (docker logs, shipped sinks).
              this.logger.warn(
                `identity ${channel}:${this.redactHandle(handle)} already linked to end-user ${existing.platosEndUserId}; not re-pointing to ${resolvedId} (link-not-merge)`,
              );
            }
          } catch {
            // Best-effort warn lookup — swallow so attach stays fail-open.
          }
        }
      }

      return resolvedId;
    } catch {
      // Fail open — end-user resolution must never block thread creation.
      return null;
    }
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

  async getThread(
    threadId: string,
    scope: RequestScope,
    options: { allUsers?: boolean } = {},
  ): Promise<Thread | null> {
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
    const baseWhere: any = {
      id: threadId,
      organizationId: scope.organizationId,
      projectId: scope.projectId,
      environmentId: scope.environmentId,
    };
    // Operator/owner dashboard view — drop the per-end-user ownership filter
    // so the platform owner can open a conversation created under a
    // simulated / embed / SDK end-user id. The scope tuple above is still
    // enforced, so this never crosses org/project/env. Mirrors
    // listThreads({ allUsers }) — the detail endpoint must match the list,
    // otherwise threads visible in the operator list 404 when opened.
    if (!options.allUsers) baseWhere.OR = ownershipOr;

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
    if (result.count > 0) {
      // A deleted (archived) thread is done — close its durable Trigger chat
      // session so the conversation doesn't linger "Active" forever. Fire-and-
      // forget: never block or fail the delete on session bookkeeping.
      void this.closeChatSession(
        threadId,
        {
          organizationId: scope.organizationId,
          projectId: scope.projectId,
          environmentId: scope.environmentId,
        },
        "thread-archived",
      ).catch(() => {});
    }
    return { archived: result.count > 0, archivedAt: result.count > 0 ? now.toISOString() : null };
  }

  // ---- Durable chat session lifecycle (Trigger Sessions) ----
  // A durable chat thread maps 1:1 to a Trigger session (externalId === threadId,
  // task `platos.chat.session`). Trigger never closes these on its own, so
  // without a reaper they accumulate "Active" forever. We close a session once
  // its conversation is done: thread archived/completed, idle past a TTL,
  // orphaned (thread gone), or past a hard max age.

  private static readonly CHAT_SESSION_TASK_ID = "platos.chat.session";

  /**
   * EXACT match to the streaming-cursor key the gateway writes
   * (connections.gateway.ts). Kept in sync by hand — both sides must agree.
   */
  private chatCursorKey(
    scope: { organizationId: string; projectId: string; environmentId: string },
    threadId: string,
  ): string {
    return `chatsess:cursor:${scope.organizationId}:${scope.projectId}:${scope.environmentId}:${threadId}`;
  }

  /** Lazy-load the Trigger SDK (absent in unit tests / when unconfigured). */
  private loadTriggerSdk(): { sessions: any; runs: any } | null {
    try {
      // eslint-disable-next-line @typescript-eslint/no-var-requires
      const sdk = require("@trigger.dev/sdk");
      if (configureExternalTriggerSdk(sdk).status !== "configured") return null;
      // Validate every method the reaper depends on. If `runs.retrieve` were
      // missing the live-run guard would silently vanish, so require it too.
      if (
        !sdk?.sessions?.close ||
        !sdk?.sessions?.list ||
        !sdk?.sessions?.retrieve ||
        !sdk?.runs?.retrieve
      ) {
        return null;
      }
      return { sessions: sdk.sessions, runs: sdk.runs };
    } catch {
      return null;
    }
  }

  /**
   * A Trigger session object exposes NO `status` field — activeness is derived
   * from `closedAt` (null ⇒ not closed) and `expiresAt` (null or future ⇒ not
   * expired). This matches the server's ACTIVE/CLOSED/EXPIRED classification
   * used by the list-filter, which the object shape itself does not echo back.
   */
  private isSessionActive(s: any): boolean {
    if (!s) return false;
    if (s.closedAt) return false;
    if (s.expiresAt && new Date(s.expiresAt).getTime() <= Date.now()) return false;
    return true;
  }

  /**
   * Terminate one Trigger chat session (close + drop its cursor). Resume-safe
   * without unbinding the thread: the session's externalId is immutable, so a
   * returning user's `sessions.start(threadId)` hits the closed session and the
   * gateway falls through to the durable-turn / direct path (history is served
   * from Platos's own DB, not the Trigger session). Never throws.
   */
  private async terminateSession(
    sessions: any,
    sessionId: string,
    threadId: string | null,
    scope: { organizationId: string; projectId: string; environmentId: string } | null,
    reason: string,
  ): Promise<boolean> {
    try {
      // Just close it. A session's externalId is IMMUTABLE (the server rejects
      // any attempt to change it: "externalId cannot be changed after
      // creation"), so we can't unbind the thread — but we don't need to. Once
      // the session is closed, the next turn's sessions.start(threadId) (inside
      // TurnDispatchService.driveSession's sendMessage) fails fast ("Session is
      // closed; use a different externalId"). driveSession catches that
      // PRE-COMMIT (no run dispatched) and returns null, so the chokepoint
      // (streamTurn/collectTurn/gateway) falls open to the ONLY fallback — the
      // in-process DIRECT path. The turn still completes (no brick); a thread
      // whose session was reaped simply runs direct from then on (the
      // durable-turn task path is retired — direct is the sole fallback now).
      await sessions.close(sessionId, { reason });
      // Drop the now-stale streaming cursor. Belt-and-braces: the fallback path
      // doesn't read it, and a closed session can't be appended to anyway, so a
      // failed/late delete is harmless. Only runs after a successful close.
      if (scope && threadId) {
        try {
          await this.redis.del(this.chatCursorKey(scope, threadId));
        } catch {
          /* stale cursor is harmless */
        }
      }
      return true;
    } catch {
      // close failed — nothing changed (session still ACTIVE, cursor intact, so
      // normal resume still works). The next sweep retries.
      return false;
    }
  }

  /**
   * Close the durable chat session bound to a thread (looked up by externalId).
   * Best-effort — used when a thread is explicitly deleted/archived. Returns
   * false (never throws) when there's no configured SDK or no active session.
   */
  async closeChatSession(
    threadId: string,
    scope: { organizationId: string; projectId: string; environmentId: string } | null,
    reason: string,
  ): Promise<boolean> {
    const sdk = this.loadTriggerSdk();
    if (!sdk) return false;
    try {
      // Distinguish "confirmed not active" from "couldn't check": a retrieve
      // that THROWS means we don't know the session's state, so we must not
      // touch the cursor (deleting it while an ACTIVE session still carries
      // externalId=threadId would brick the thread). Only a successful
      // retrieve resolving to a non-ACTIVE / missing session lets us safely
      // drop the stale cursor.
      let sess: any;
      try {
        sess = await sdk.sessions.retrieve(threadId);
      } catch {
        return false;
      }
      if (!sess?.id || !this.isSessionActive(sess)) {
        if (scope) {
          try {
            await this.redis.del(this.chatCursorKey(scope, threadId));
          } catch {
            /* ignore */
          }
        }
        return false;
      }
      return await this.terminateSession(sdk.sessions, sess.id, threadId, scope, reason);
    } catch {
      return false;
    }
  }

  /**
   * Sweep durable chat sessions and close the ones whose conversation is done:
   * thread archived/completed, idle past `PLATOS_CHAT_SESSION_IDLE_MINUTES`,
   * orphaned (thread missing), or past `PLATOS_CHAT_SESSION_MAX_AGE_HOURS`.
   * Skips any session with a live run so an in-flight turn is never yanked.
   * Invoked by the `platos.chat.session_reaper` scheduled task via the admin
   * endpoint (the task has no Prisma/Redis; this service owns both).
   */
  async reapChatSessions(): Promise<{
    scanned: number;
    closed: number;
    skipped: number;
    capped: boolean;
    reasons: Record<string, number>;
  }> {
    const out = {
      scanned: 0,
      closed: 0,
      skipped: 0,
      capped: false,
      reasons: {} as Record<string, number>,
    };
    if (process.env.PLATOS_CHAT_SESSION_REAP_DISABLED === "true") return out;
    const sdk = this.loadTriggerSdk();
    if (!sdk) return out;

    // Default idle window is a full day: a chat idle 24h is genuinely "done",
    // and closing sooner would downgrade same-day resumes off the session path
    // (a reaped thread's next message falls back to the durable-turn path —
    // still durable, but it loses the resumable .out stream). Env-tunable.
    const idleMinutesRaw = Number(process.env.PLATOS_CHAT_SESSION_IDLE_MINUTES ?? "1440");
    const maxAgeHoursRaw = Number(process.env.PLATOS_CHAT_SESSION_MAX_AGE_HOURS ?? "168");
    const idleMinutes = Number.isFinite(idleMinutesRaw) && idleMinutesRaw > 0 ? idleMinutesRaw : 1440;
    const maxAgeHours = Number.isFinite(maxAgeHoursRaw) && maxAgeHoursRaw > 0 ? maxAgeHoursRaw : 168;
    const idleCutoff = Date.now() - idleMinutes * 60_000;
    const maxAgeCutoff = Date.now() - maxAgeHours * 3_600_000;
    const MAX_SCAN = 2000;
    const PAGE = 100;
    // Bound the actual close work per sweep — each close is ~4 serial round
    // trips, so an unbounded first-drain of a large backlog would blow the
    // task's 110s HTTP budget. Remaining sessions are picked up next sweep.
    const MAX_CLOSE_PER_SWEEP = 300;

    // 1) Collect ACTIVE chat sessions (bounded).
    const items: Array<{
      id: string;
      externalId: string | null;
      currentRunId?: string | null;
      createdAt: string | Date;
      metadata?: any;
    }> = [];
    try {
      const page = await sdk.sessions.list({
        status: "ACTIVE",
        taskIdentifier: ConversationService.CHAT_SESSION_TASK_ID,
        limit: PAGE,
      });
      for await (const s of page) {
        items.push({
          id: s.id,
          externalId: s.externalId ?? null,
          currentRunId: s.currentRunId ?? null,
          createdAt: s.createdAt,
          metadata: s.metadata,
        });
        if (items.length >= MAX_SCAN) {
          out.capped = true;
          break;
        }
      }
    } catch {
      return out;
    }
    out.scanned = items.length;
    if (items.length === 0) return out;

    // 2) Batch-load the backing threads for last-activity + status + scope.
    const threadIds = Array.from(
      new Set(items.map((i) => i.externalId).filter((x): x is string => !!x)),
    );
    const threadRows: Array<{
      id: string;
      updatedAt: Date;
      status: string;
      organizationId: string;
      projectId: string;
      environmentId: string;
    }> =
      threadIds.length === 0
        ? []
        : await this.prisma.platosAgentThread.findMany({
            where: { id: { in: threadIds } },
            select: {
              id: true,
              updatedAt: true,
              status: true,
              organizationId: true,
              projectId: true,
              environmentId: true,
            },
          });
    const threadById = new Map(threadRows.map((t) => [t.id, t]));
    const bump = (r: string) => {
      out.reasons[r] = (out.reasons[r] ?? 0) + 1;
    };

    // 3) Decide + close.
    for (const s of items) {
      let reason: string | null = null;
      let scope: { organizationId: string; projectId: string; environmentId: string } | null = null;

      if (!s.externalId) {
        reason = "orphan-no-external-id";
      } else {
        const t = threadById.get(s.externalId);
        if (!t) {
          reason = "thread-missing";
        } else {
          scope = {
            organizationId: t.organizationId,
            projectId: t.projectId,
            environmentId: t.environmentId,
          };
          if (t.status === "archived" || t.status === "completed") reason = `thread-${t.status}`;
          else if (new Date(t.updatedAt).getTime() < idleCutoff) reason = "idle-timeout";
          else if (new Date(s.createdAt).getTime() < maxAgeCutoff) reason = "max-age";
        }
      }

      if (!reason) {
        out.skipped++;
        continue;
      }

      // The list + thread snapshots were taken before this serial loop, which
      // can run for minutes. Re-verify against LIVE state right before closing,
      // and fail CLOSED on any uncertainty — closing a resumed conversation
      // mid-turn is far worse than deferring one sweep.
      let fresh: any = null;
      try {
        fresh = await sdk.sessions.retrieve(s.id);
      } catch {
        fresh = null;
      }
      if (!fresh || !this.isSessionActive(fresh)) {
        // Already closed/expired, or couldn't confirm it's still active.
        out.skipped++;
        bump("skip-not-active");
        continue;
      }

      // Never yank an in-flight turn. Check the FRESH currentRunId (the snapshot
      // one lingers after completion and may point at a stale run). Any run that
      // is not completed counts as live (covers EXECUTING/QUEUED/WAITING/DELAYED
      // /…). A failed run lookup is treated as live → skip (fail closed).
      const runId: string | null = fresh.currentRunId ?? s.currentRunId ?? null;
      if (runId) {
        let run: any;
        try {
          run = await sdk.runs.retrieve(runId);
        } catch {
          out.skipped++;
          bump("skip-run-check-failed");
          continue;
        }
        if (run && run.isCompleted !== true) {
          out.skipped++;
          bump("skip-live-run");
          continue;
        }
      }

      // For idle-timeout, re-confirm the thread is still idle — a user may have
      // messaged since the snapshot (bumping thread.updatedAt at turn start,
      // before any run is visible).
      if (reason === "idle-timeout" && s.externalId) {
        try {
          const t2 = await this.prisma.platosAgentThread.findUnique({
            where: { id: s.externalId },
            select: { updatedAt: true, status: true },
          });
          if (
            t2 &&
            t2.status === "active" &&
            new Date(t2.updatedAt).getTime() >= Date.now() - idleMinutes * 60_000
          ) {
            out.skipped++;
            bump("became-active");
            continue;
          }
        } catch {
          /* couldn't re-read; the snapshot already said idle — proceed */
        }
      }

      const ok = await this.terminateSession(sdk.sessions, s.id, s.externalId, scope, reason);
      if (ok) {
        out.closed++;
        bump(reason);
        if (out.closed >= MAX_CLOSE_PER_SWEEP) {
          out.capped = true;
          break;
        }
      } else {
        out.skipped++;
        bump(`close-failed:${reason}`);
      }
    }
    return out;
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
    options: { limit?: number; offset?: number; allUsers?: boolean } = {},
  ): Promise<{ messages: StoredMessage[]; total: number }> {
    // Verify thread belongs to this scope. `allUsers` widens the check to
    // any thread in-scope (operator view) instead of the caller's own.
    const thread = await this.getThread(threadId, scope, {
      allUsers: options.allUsers,
    });
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

    // ── CURSOR-ANCHORED HISTORY ──────────────────────────────────────────
    //
    // The window used to be a pure slide: `orderBy desc, take: limit`. Two
    // problems with that, and the fix for both is the anchor the compaction
    // path was ALREADY writing and nothing was reading.
    //
    // 1. The summary was ADDITIVE, not substitutive. Messages between the
    //    compaction cursor and the start of the sliding window appeared in the
    //    compacted summary AND again in the loaded history, so compaction
    //    increased token spend instead of reducing it.
    //
    // 2. It defeated cross-turn prompt caching. Anthropic matches an exact
    //    prefix, so when the oldest message slid off, messages[0] changed and
    //    the whole cached prefix died — every turn, on every thread past
    //    contextLimit. That is the same full-price-history bug the caching work
    //    fixed WITHIN a turn, reappearing BETWEEN turns.
    //
    // Anchored on `compactedUpToMessageId` the window is STEPPED instead:
    // between compactions the cursor is fixed, so the array only grows at the
    // tail and the prefix stays byte-identical. It changes once per compaction
    // cycle, not once per turn.
    let cursorAt: Date | null = null;
    let cursorId: string | null = null;
    try {
      const row = await this.prisma.platosAgentThread.findFirst({
        where: { id: threadId },
        select: { compactedUpToMessageId: true },
      });
      cursorId = (row?.compactedUpToMessageId as string | null) ?? null;
      if (cursorId) {
        const anchor = await this.prisma.platosAgentMessage.findFirst({
          where: { id: cursorId },
          select: { createdAt: true },
        });
        // A cursor pointing at a deleted message must not silently drop the
        // whole history — fall back to the sliding window instead.
        cursorAt = (anchor?.createdAt as Date | undefined) ?? null;
      }
    } catch {
      cursorAt = null; // fail-open to the pre-existing behaviour
    }

    // Safety bound. If compaction stalls, an anchored window would grow without
    // limit and eventually blow the context. Cap generously (compaction should
    // land long before this) and log loudly, because hitting it means
    // compaction is broken rather than merely behind.
    const anchoredCap = Math.max(limit * 4, limit + 40);

    const mainMessages = cursorAt
      ? await this.prisma.platosAgentMessage.findMany({
          where: {
            threadId,
            role: { in: ["user", "assistant"] },
            status: "active",
            threadReplyToId: null,
            createdAt: { gt: cursorAt },
          },
          // Ascending + take = the OLDEST messages after the cursor, i.e. a
          // stable prefix. Descending would re-introduce the slide.
          orderBy: { createdAt: "asc" },
          take: anchoredCap,
          select: { role: true, content: true, encKeyVersion: true },
        })
      : (
          await this.prisma.platosAgentMessage.findMany({
            where: {
              threadId,
              role: { in: ["user", "assistant"] },
              status: "active",
              threadReplyToId: null,
            },
            orderBy: { createdAt: "desc" },
            take: limit,
            select: { role: true, content: true, encKeyVersion: true },
          })
        ).reverse();

    if (cursorAt && mainMessages.length >= anchoredCap) {
      this.logger?.warn?.(
        `[conversation] thread ${threadId} hit the anchored history cap (${anchoredCap}) — compaction is not keeping up`,
      );
    }

    const decrypt = (m: any): string =>
      this.crypto
        ? (this.crypto.decryptIfNeeded(m.content, m.encKeyVersion) ?? "")
        : (m.content ?? "");

    // NOTE: both branches above already yield ASCENDING order (the sliding
    // branch reverses its desc result inline), so no reverse here.
    const mainHistory = mainMessages
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
    // IDENTITY-CORE §C (G1 — the real seam). Until now this method called
    // `createThread(scope, agentId)` with NO opts, so a `singleEndUser` opt on
    // createThread could never reach a channel-minted thread and the gate would
    // FAIL OPEN for exactly the shared threads it exists to close. Accept an
    // opts bag (extensible) and FORWARD it to createThread. Omitted ⇒
    // createThread defaults `singleEndUser` to true (web/API/direct unchanged).
    opts?: { singleEndUser?: boolean },
  ): Promise<Thread> {
    if (threadId) {
      const existing = await this.getThread(threadId, scope);
      if (existing) return existing;
    }
    // PRA-AC: scope.clusteringId is stamped onto the new thread inside createThread.
    return this.createThread(scope, agentId, undefined, opts);
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
