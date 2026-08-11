import { Injectable, Inject, Optional, Logger } from "@nestjs/common";
import { createHash, randomUUID } from "node:crypto";
import type Redis from "ioredis";
import { PRISMA_TOKEN } from "../shared/database.provider";
import { REDIS_TOKEN } from "../shared/redis.provider";
import {
  mergeSubjectKeys, isEmptySubject, subjectKeyHash,
  type SubjectKeys, type SubjectScope,
} from "./subject-graph";
import {
  pendingStore, assertContentFree,
  type ErasureReceipt, type StoreOutcome,
} from "./erasure-receipt";
import { runErasure, retryErasure, type StoreExecutors } from "./erasure-orchestrator";
import { planDeletions, subjectKeyPatterns, retainedAggregatePatterns, toWireKey } from "./redis-keys";

/**
 * Hard erasure across Postgres, Redis, ClickHouse and object storage.
 *
 * The decision logic lives in the pure modules alongside this file; this class
 * is the thin part that actually talks to stores. That split is deliberate: the
 * ordering and failure semantics carry legal weight and must be testable
 * without four running services, so the risky-but-dumb code is here and the
 * subtle code is tested elsewhere.
 *
 * Everything here is idempotent. A retry must be safe, because the alternative
 * to retrying a partial failure is leaving personal data in place.
 */
export const ERASURE_POLICY_VERSION = "2026-08-11.1";

@Injectable()
export class ErasureService {
  private readonly logger = new Logger(ErasureService.name);
  private readonly prisma: any;
  private readonly salt: string;

  constructor(
    @Inject(PRISMA_TOKEN) prisma: any,
    @Inject(REDIS_TOKEN) private readonly redis: Redis,
    @Optional() private readonly attachments?: { deleteObject?: (key: string) => Promise<void>; objectExists?: (key: string) => Promise<boolean> },
  ) {
    this.prisma = prisma;
    // Per-deployment salt. Without one, a hash of an email is trivially
    // reversible with a wordlist, which defeats the point of hashing it.
    this.salt = process.env.PLATOS_ERASURE_HASH_SALT || process.env.PLATOS_ADMIN_TOKEN || "platos-erasure";
  }

  private hash(externalUserId: string, organizationId: string): string {
    return subjectKeyHash(externalUserId, organizationId, this.salt, (s) =>
      createHash("sha256").update(s).digest("hex"));
  }

  /**
   * Resolve one canonical person from a Walle external id.
   *
   * Deliberately does NOT assume the caller's id is the denormalized userId.
   * It matches externalUserId OR linkedExternalId OR a channel identity handle,
   * then expands to every PlatosEndUser row those touch and every scope they
   * appear in. That expansion is the whole point: the previous route took one
   * userId and missed every row linked by platosEndUserId instead.
   */
  async discoverSubject(externalUserId: string, organizationId: string): Promise<SubjectKeys> {
    const endUsers: any[] = await this.prisma.platosEndUser.findMany({
      where: {
        organizationId,
        OR: [{ externalUserId }, { linkedExternalId: externalUserId }],
      },
      select: { id: true, externalUserId: true, linkedExternalId: true,
                organizationId: true, projectId: true, environmentId: true },
    });

    // A person can be reachable only through a channel handle (an email or a
    // Slack id) with no matching externalUserId anywhere.
    const viaIdentity: any[] = await this.prisma.platosEndUserIdentity.findMany({
      where: { organizationId, handle: externalUserId },
      select: { platosEndUserId: true, organizationId: true, projectId: true, environmentId: true },
    });

    const identityOwners: any[] = viaIdentity.length
      ? await this.prisma.platosEndUser.findMany({
          where: { id: { in: [...new Set(viaIdentity.map((i) => i.platosEndUserId))] } },
          select: { id: true, externalUserId: true, linkedExternalId: true,
                    organizationId: true, projectId: true, environmentId: true },
        })
      : [];

    const all = [...endUsers, ...identityOwners];
    const scopes: SubjectScope[] = all.map((u) => ({
      organizationId: u.organizationId, projectId: u.projectId, environmentId: u.environmentId,
    }));

    // Historical denormalized ids: the request id itself, plus whatever the
    // canonical rows were keyed by before adoption.
    const legacy = [externalUserId, ...all.map((u) => u.externalUserId), ...all.map((u) => u.linkedExternalId)]
      .filter((v): v is string => typeof v === "string" && v.length > 0);

    return mergeSubjectKeys({
      platosEndUserIds: all.map((u) => u.id),
      legacyUserIds: legacy,
      scopes: [...scopes, ...viaIdentity.map((i) => ({
        organizationId: i.organizationId, projectId: i.projectId, environmentId: i.environmentId }))],
    });
  }

  /** Content-free inventory: counts and scope ids, never content. */
  async inventory(subject: SubjectKeys): Promise<Record<string, number | unknown>> {
    if (isEmptySubject(subject)) return { resolved: 0 };
    const { platosEndUserIds: eu, legacyUserIds: lu } = subject;
    const [threads, memories, ratings, attachments, audits] = await Promise.all([
      this.prisma.platosAgentThread.count({ where: { OR: [{ platosEndUserId: { in: eu } }, { userId: { in: lu } }] } }),
      this.prisma.platosMemory.count({ where: { OR: [{ platosEndUserId: { in: eu } }, { userId: { in: lu } }] } }),
      this.prisma.platosMessageRating.count({ where: { userId: { in: lu } } }),
      this.prisma.platosMessageAttachment.count({ where: { uploadedBy: { in: lu } } }),
      this.prisma.platosToolCallAudit.count({ where: { OR: [{ platosEndUserId: { in: eu } }, { userId: { in: lu } }] } }),
    ]);
    return {
      resolved: eu.length + lu.length,
      scopes: subject.scopes,
      threads, memories, ratings, attachments, toolCallAudits: audits,
    };
  }

  // ── store executors ────────────────────────────────────────────────────

  /**
   * Object storage. Runs FIRST: the object keys live in attachment metadata, so
   * deleting the rows first destroys the only map to the bytes.
   */
  private minioExecutor = async (subject: SubjectKeys): Promise<StoreOutcome> => {
    const o = pendingStore("minio");
    if (!this.attachments?.deleteObject) {
      return { ...o, status: "not_provisioned", note: "no object-store client wired" };
    }
    const rows: any[] = await this.prisma.platosMessageAttachment.findMany({
      where: { uploadedBy: { in: subject.legacyUserIds } },
      select: { storageKey: true },
    });
    o.discovered = rows.length;
    for (const r of rows) {
      try {
        await this.attachments.deleteObject!(r.storageKey);
        o.deleted++;
      } catch {
        o.failures++;
      }
    }
    // Verify absence rather than trusting the delete call.
    if (this.attachments.objectExists) {
      let survivors = 0;
      for (const r of rows) {
        try { if (await this.attachments.objectExists!(r.storageKey)) survivors++; } catch { survivors++; }
      }
      o.verificationStatus = survivors === 0 ? "passed" : "failed";
      o.note = `verified ${rows.length - survivors}/${rows.length} objects absent`;
    } else {
      // No existence probe means we cannot prove it. Unknown, never passed.
      o.verificationStatus = "unknown";
      o.note = "no objectExists probe available; deletion unverified";
    }
    o.status = o.failures > 0 ? "failed" : "done";
    return o;
  };

  private redisExecutor = async (subject: SubjectKeys): Promise<StoreOutcome> => {
    const o = pendingStore("redis");
    const threadRows: any[] = await this.prisma.platosAgentThread.findMany({
      where: { OR: [{ platosEndUserId: { in: subject.platosEndUserIds } }, { userId: { in: subject.legacyUserIds } }] },
      select: { id: true },
    });
    const refs = {
      threadIds: threadRows.map((t) => t.id),
      legacyUserIds: subject.legacyUserIds,
      platosEndUserIds: subject.platosEndUserIds,
      scopes: subject.scopes,
    };

    const scanned: string[] = [];
    for (const pattern of subjectKeyPatterns(refs)) {
      try {
        // keys() returns PREFIXED keys; planDeletions strips them. Feeding them
        // back to del() unstripped double-prefixes and silently deletes nothing.
        const found = await this.redis.keys(pattern);
        scanned.push(...found);
      } catch { o.failures++; }
    }
    const { deletable, retained } = planDeletions(scanned);
    o.discovered = deletable.length + retained.length;
    o.retained = retained.length;

    for (const k of deletable) {
      try { await this.redis.del(k); o.deleted++; } catch { o.failures++; }
    }

    // Verify with the on-wire form.
    let survivors = 0;
    for (const k of deletable) {
      try { if (await this.redis.exists(k)) survivors++; } catch { survivors++; }
    }
    o.verificationStatus = survivors === 0 ? "passed" : "failed";
    o.status = o.failures > 0 ? "failed" : "done";
    o.note = `${o.deleted} deleted, ${o.retained} aggregate keys retained (${retainedAggregatePatterns(refs).length} patterns); ${survivors} survivors`;
    return o;
  };

  /**
   * ClickHouse. Measured on this deployment: zero user tables, so there is
   * nothing to erase and a verification query returns nothing trivially. That
   * reports as not_provisioned, which settles the operation but is NEVER
   * verified — the day it is provisioned, an unexercised guarantee must not
   * silently become false.
   */
  private clickhouseExecutor = async (): Promise<StoreOutcome> => {
    const o = pendingStore("clickhouse");
    const base = process.env.CLICKHOUSE_URL;
    if (!base) return { ...o, status: "not_provisioned", note: "CLICKHOUSE_URL unset" };
    try {
      const res = await fetch(`${base.replace(/\/+$/, "")}/?query=${encodeURIComponent(
        "SELECT count() FROM system.tables WHERE name = 'platos_spans_v1'")}`,
        { signal: AbortSignal.timeout(10_000) });
      const n = parseInt((await res.text()).trim(), 10);
      if (!Number.isFinite(n) || n === 0) {
        return { ...o, status: "not_provisioned", note: "platos_spans_v1 does not exist in this deployment" };
      }
      // Table exists: a real mutation path is required before this can claim
      // anything. Refusing to report success is the correct behaviour until
      // that path is implemented and exercised against real rows.
      return { ...o, status: "failed", failures: 1, verificationStatus: "unknown",
               note: "spans table present but mutation path not implemented" };
    } catch (err: any) {
      return { ...o, status: "failed", failures: 1, verificationStatus: "unknown",
               note: `clickhouse probe failed (${err?.name ?? "Error"})` };
    }
  };

  /** Postgres. Runs LAST: it holds the identifiers every other store uses. */
  private postgresExecutor = async (subject: SubjectKeys): Promise<StoreOutcome> => {
    const o = pendingStore("postgres");
    const eu = subject.platosEndUserIds;
    const lu = subject.legacyUserIds;
    const both = { OR: [{ platosEndUserId: { in: eu } }, { userId: { in: lu } }] };

    try {
      await this.prisma.$transaction(async (tx: any) => {
        // Children first: messages and attachment metadata hang off threads.
        const threads: any[] = await tx.platosAgentThread.findMany({ where: both, select: { id: true } });
        const threadIds = threads.map((t) => t.id);
        if (threadIds.length) {
          const msgs: any[] = await tx.platosAgentMessage.findMany({
            where: { threadId: { in: threadIds } }, select: { id: true } });
          const msgIds = msgs.map((m) => m.id);
          if (msgIds.length) {
            o.deleted += (await tx.platosMessageAttachment.deleteMany({ where: { messageId: { in: msgIds } } })).count;
            o.deleted += (await tx.platosAgentMessage.deleteMany({ where: { id: { in: msgIds } } })).count;
          }
        }
        o.deleted += (await tx.platosMessageRating.deleteMany({ where: { userId: { in: lu } } })).count;
        o.deleted += (await tx.platosMessageAttachment.deleteMany({ where: { uploadedBy: { in: lu } } })).count;
        o.deleted += (await tx.platosMemoryRelationship.deleteMany({ where: { userId: { in: lu } } })).count;
        o.deleted += (await tx.platosMemoryEntity.deleteMany({ where: { userId: { in: lu } } })).count;
        o.deleted += (await tx.platosMemory.deleteMany({ where: both })).count;
        o.deleted += (await tx.platosSafetyEvent.deleteMany({ where: { userId: { in: lu } } })).count;
        o.deleted += (await tx.platosAgentThread.deleteMany({ where: both })).count;
        // Audit rows are ANONYMIZED, not deleted: they are the record that the
        // erasure itself happened, and destroying them would remove the proof.
        o.anonymized += (await tx.platosToolCallAudit.updateMany({
          where: both, data: { userId: null, platosEndUserId: null } })).count;
        // Canonical identity last — without it nothing can be rediscovered.
        if (eu.length) {
          o.deleted += (await tx.platosEndUserIdentity.deleteMany({ where: { platosEndUserId: { in: eu } } })).count;
          o.deleted += (await tx.platosEndUser.deleteMany({ where: { id: { in: eu } } })).count;
        }
      });
    } catch (err: any) {
      return { ...o, status: "failed", failures: 1, verificationStatus: "unknown",
               note: `transaction failed (${err?.name ?? "Error"})` };
    }

    // Negative verification: prove nothing identifying survives.
    const [t, m, a, e] = await Promise.all([
      this.prisma.platosAgentThread.count({ where: both }),
      this.prisma.platosMemory.count({ where: both }),
      this.prisma.platosToolCallAudit.count({ where: { OR: [{ platosEndUserId: { in: eu } }, { userId: { in: lu } }] } }),
      eu.length ? this.prisma.platosEndUser.count({ where: { id: { in: eu } } }) : Promise.resolve(0),
    ]);
    const survivors = t + m + a + e;
    o.verificationStatus = survivors === 0 ? "passed" : "failed";
    o.status = "done";
    o.retained = 0;
    o.note = `verification: threads=${t} memories=${m} audits=${a} endUsers=${e}`;
    return o;
  };

  private executors(): StoreExecutors {
    return {
      minio: this.minioExecutor,
      redis: this.redisExecutor,
      clickhouse: this.clickhouseExecutor,
      postgres: this.postgresExecutor,
    };
  }

  // ── public API ─────────────────────────────────────────────────────────

  /**
   * Request an erasure. Idempotent on `idempotencyKey`: a repeated request
   * returns the existing operation rather than racing a second purge.
   */
  async requestErasure(args: {
    externalUserId: string;
    organizationId: string;
    idempotencyKey: string;
    legalHoldPolicyId?: string | null;
  }): Promise<ErasureReceipt> {
    const existing = await this.prisma.platosErasureOperation.findFirst({
      where: { idempotencyKey: args.idempotencyKey },
    });
    if (existing) return this.toReceipt(existing);

    const subject = await this.discoverSubject(args.externalUserId, args.organizationId);
    const hash = this.hash(args.externalUserId, args.organizationId);
    const inventory = await this.inventory(subject);

    const row = await this.prisma.platosErasureOperation.create({
      data: {
        id: randomUUID(),
        idempotencyKey: args.idempotencyKey,
        subjectKeyHash: hash,
        organizationId: args.organizationId,
        status: "pending",
        scopes: subject.scopes as any,
        stores: [] as any,
        inventory: inventory as any,
        policyVersion: ERASURE_POLICY_VERSION,
        legalHoldPolicyId: args.legalHoldPolicyId ?? null,
        attempts: 0,
      },
    });

    const started = await runErasure(this.toReceipt(row), subject, this.executors(), {
      legalHold: args.legalHoldPolicyId ? { policyId: args.legalHoldPolicyId } : null,
    });
    return this.persist(started, [args.externalUserId, ...subject.legacyUserIds]);
  }

  async getErasure(operationId: string): Promise<ErasureReceipt | null> {
    const row = await this.prisma.platosErasureOperation.findFirst({ where: { id: operationId } });
    return row ? this.toReceipt(row) : null;
  }

  async retryErasureById(operationId: string, externalUserId: string): Promise<ErasureReceipt | null> {
    const row = await this.prisma.platosErasureOperation.findFirst({ where: { id: operationId } });
    if (!row) return null;
    const receipt = this.toReceipt(row);
    const subject = await this.discoverSubject(externalUserId, row.organizationId);
    const next = await retryErasure(receipt, subject, this.executors(), {
      legalHold: row.legalHoldPolicyId ? { policyId: row.legalHoldPolicyId } : null,
    });
    return this.persist(next, [externalUserId, ...subject.legacyUserIds]);
  }

  private toReceipt(row: any): ErasureReceipt {
    return {
      operationId: row.id,
      subjectKeyHash: row.subjectKeyHash,
      requestedAt: row.requestedAt?.toISOString?.() ?? String(row.requestedAt),
      startedAt: row.startedAt?.toISOString?.(),
      completedAt: row.completedAt?.toISOString?.(),
      status: row.status,
      scopes: (row.scopes ?? []) as any,
      stores: (row.stores ?? []) as StoreOutcome[],
      policyVersion: row.policyVersion,
      attempts: row.attempts ?? 0,
      legalHoldPolicyId: row.legalHoldPolicyId ?? undefined,
    };
  }

  private async persist(r: ErasureReceipt, forbidden: string[]): Promise<ErasureReceipt> {
    // Refuse to write a receipt that would recreate the identifier it documents.
    assertContentFree(r, forbidden);
    await this.prisma.platosErasureOperation.update({
      where: { id: r.operationId },
      data: {
        status: r.status,
        stores: r.stores as any,
        attempts: r.attempts,
        startedAt: r.startedAt ? new Date(r.startedAt) : null,
        completedAt: r.completedAt ? new Date(r.completedAt) : null,
        legalHoldPolicyId: r.legalHoldPolicyId ?? null,
      },
    });
    this.logger.log(`[erasure] ${r.operationId} status=${r.status} attempts=${r.attempts}`);
    return r;
  }
}
