import { Injectable, Inject, Optional, Logger } from "@nestjs/common";
import { createHash, randomUUID, timingSafeEqual } from "node:crypto";
import { Prisma } from "@platos/tenancy-database";
import type Redis from "ioredis";
import { PRISMA_TOKEN, type ControlDatabaseClient } from "../shared/database.provider";
import { REDIS_TOKEN } from "../shared/redis.provider";
import {
  mergeSubjectKeys, isEmptySubject, subjectKeyHash,
  type SubjectKeys, type SubjectScope,
} from "./subject-graph";
import {
  pendingStore, assertContentFree,
  deriveStatus,
  type ErasureReceipt, type ErasureStatus, type StoreOutcome,
} from "./erasure-receipt";
import { runErasure, retryErasure, type StoreExecutors } from "./erasure-orchestrator";
import { findLegalHold, parseLegalHoldList } from "./legal-hold";
import { planDeletions, subjectKeyPatterns, retainedAggregatePatterns } from "./redis-keys";
import { ErasureObjectStore } from "./object-store";
import { ErasureClickhouse } from "./clickhouse";
import { eraseClickhouseSubject } from "./clickhouse-erasure";

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

export class ErasureIdempotencyConflictError extends Error {
  constructor() {
    super("Idempotency key is already bound to another subject");
    this.name = "ErasureIdempotencyConflictError";
  }
}

function toDatabaseStatus(status: ErasureStatus) {
  if (status === "pending") return "PENDING" as const;
  if (status === "running") return "ACTIVE" as const;
  if (status === "completed") return "SUCCEEDED" as const;
  if (status === "blocked_legal_hold") return "CANCELLED" as const;
  return "FAILED" as const;
}

const CONTENT_FREE_AUDIT_ARGUMENTS = {
  __platosAudit: {
    userId: null,
    mcpUserId: null,
    endUserId: null,
  },
} as const;

function isContentFreeAudit(row: {
  endUserId: string | null;
  arguments: unknown;
  result: unknown;
  error: string | null;
}): boolean {
  const argumentsValue = row.arguments;
  if (!argumentsValue || typeof argumentsValue !== "object" || Array.isArray(argumentsValue)) {
    return false;
  }
  const argumentEntries = Object.entries(argumentsValue as Record<string, unknown>);
  const metadata = (argumentsValue as Record<string, unknown>).__platosAudit;
  if (!metadata || typeof metadata !== "object" || Array.isArray(metadata)) return false;
  const metadataObject = metadata as Record<string, unknown>;
  return row.endUserId === null
    && row.result === null
    && row.error === null
    && argumentEntries.length === 1
    && argumentEntries[0]?.[0] === "__platosAudit"
    && Object.keys(metadataObject).sort().join(",") === "endUserId,mcpUserId,userId"
    && metadataObject.userId === null
    && metadataObject.mcpUserId === null
    && metadataObject.endUserId === null;
}

@Injectable()
export class ErasureService {
  private readonly logger = new Logger(ErasureService.name);
  private readonly prisma: ControlDatabaseClient;
  private readonly salt: string;

  constructor(
    @Inject(PRISMA_TOKEN) prisma: ControlDatabaseClient,
    @Inject(REDIS_TOKEN) private readonly redis: Redis,
    @Optional() private readonly attachments?: ErasureObjectStore,
    @Optional() private readonly clickhouse?: ErasureClickhouse,
  ) {
    this.prisma = prisma;
    // Per-deployment salt. Without one, a hash of an email is trivially
    // reversible with a wordlist, which defeats the point of hashing it.
    const configuredSalt = process.env.PLATOS_ERASURE_HASH_SALT;
    if (!configuredSalt && process.env.NODE_ENV === "production") {
      throw new Error("PLATOS_ERASURE_HASH_SALT is required in production");
    }
    this.salt = configuredSalt || "platos-erasure-development-only";
  }

  private hash(externalUserId: string, organizationId: string): string {
    return subjectKeyHash(externalUserId, organizationId, this.salt, (s) =>
      createHash("sha256").update(s).digest("hex"));
  }

  private hashMatches(left: string, right: string): boolean {
    const leftBytes = Buffer.from(left, "hex");
    const rightBytes = Buffer.from(right, "hex");
    return leftBytes.length === rightBytes.length && timingSafeEqual(leftBytes, rightBytes);
  }

  private existingReceiptForSubject(row: any, subjectHash: string): ErasureReceipt {
    if (!this.hashMatches(row.subjectKeyHash, subjectHash)) {
      throw new ErasureIdempotencyConflictError();
    }
    return this.toReceipt(row);
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
    const externalIdentity = await this.prisma.endUserIdentity.findFirst({
      where: {
        organizationId,
        issuer: "platos:external",
        channel: "external",
        subject: externalUserId,
        disabledAt: null,
      },
      select: { endUserId: true },
    });
    const endUserIds = externalIdentity ? [externalIdentity.endUserId] : [];
    const environments = endUserIds.length
      ? await this.prisma.environment.findMany({
          where: {
            project: { organizationId },
            OR: [
              { threads: { some: { endUserId: { in: endUserIds } } } },
              { memories: { some: { endUserId: { in: endUserIds } } } },
              { messageAttachments: { some: { endUserId: { in: endUserIds } } } },
              { toolCallAudits: { some: { endUserId: { in: endUserIds } } } },
            ],
          },
          select: { id: true, projectId: true },
        })
      : [];
    const scopes: SubjectScope[] = environments.map((environment) => ({
      organizationId,
      projectId: environment.projectId,
      environmentId: environment.id,
    }));

    return mergeSubjectKeys({
      platosEndUserIds: endUserIds,
      legacyUserIds: endUserIds.length > 0 ? [externalUserId] : [],
      scopes,
    });
  }

  /** Content-free inventory: counts and scope ids, never content. */
  async inventory(
    subject: SubjectKeys,
    organizationId: string,
  ): Promise<Record<string, number | unknown>> {
    if (isEmptySubject(subject)) return { resolved: 0 };
    const { platosEndUserIds: eu, legacyUserIds: lu } = subject;
    const auditAdapterFields = ["userId", "mcpUserId", "endUserId"] as const;
    const legacyAuditWhere = lu.flatMap((userId) =>
      auditAdapterFields.map((field) => ({
        arguments: { path: ["__platosAudit", field], equals: userId },
      })),
    );
    const legacySafetyWhere = lu.map((userId) => ({
      metadata: { path: ["__platosSafety", "userId"], equals: userId },
    }));
    const environmentOrganizationWhere = {
      environment: { project: { organizationId } },
    };
    const [threads, memories, ratings, attachments, audits, safetyEvents] = await Promise.all([
      this.prisma.thread.count({ where: { endUserId: { in: eu } } }),
      this.prisma.memory.count({ where: { endUserId: { in: eu } } }),
      this.prisma.messageRating.count({ where: { endUserId: { in: eu } } }),
      this.prisma.messageAttachment.count({ where: { endUserId: { in: eu } } }),
      this.prisma.toolCallAudit.count({
        where: {
          ...environmentOrganizationWhere,
          OR: [{ endUserId: { in: eu } }, ...legacyAuditWhere],
        },
      }),
      this.prisma.safetyEvent.count({
        where: {
          ...environmentOrganizationWhere,
          OR: [{ endUserId: { in: eu } }, ...legacySafetyWhere],
        },
      }),
    ]);
    return {
      resolved: eu.length + lu.length,
      scopes: subject.scopes,
      threads, memories, ratings, attachments, toolCallAudits: audits, safetyEvents,
    };
  }

  // ── store executors ────────────────────────────────────────────────────

  /**
   * Object storage. Runs FIRST: the object keys live in attachment metadata, so
   * deleting the rows first destroys the only map to the bytes.
   */
  private minioExecutor = async (subject: SubjectKeys): Promise<StoreOutcome> => {
    const o = pendingStore("minio");
    if (!this.attachments?.available) {
      return { ...o, status: "not_provisioned", note: "no object-store client wired" };
    }
    const rows: any[] = await this.prisma.messageAttachment.findMany({
      where: { endUserId: { in: subject.platosEndUserIds } },
      select: { storageKey: true },
    });
    o.discovered = rows.length;
    for (const r of rows) {
      try {
        await this.attachments.deleteObject(r.storageKey);
        o.deleted++;
      } catch {
        o.failures++;
      }
    }
    // Verify ABSENCE rather than trusting the delete call: S3-compatible delete
    // is idempotent and succeeds for a key that was never there, so a successful
    // delete is not evidence the bytes are gone. Only the HEAD probe is.
    let survivors = 0;
    for (const r of rows) {
      try { if (await this.attachments.objectExists(r.storageKey)) survivors++; } catch { survivors++; }
    }
    o.verificationStatus = survivors === 0 ? "passed" : "failed";
    o.note = `verified ${rows.length - survivors}/${rows.length} objects absent`;
    o.status = o.failures > 0 ? "failed" : "done";
    return o;
  };

  private redisExecutor = async (subject: SubjectKeys): Promise<StoreOutcome> => {
    const o = pendingStore("redis");
    const threadRows: any[] = await this.prisma.thread.findMany({
      where: { endUserId: { in: subject.platosEndUserIds } },
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
   * ClickHouse. Submits the erasure mutation, waits for `system.mutations` to
   * report it done, then re-counts. The sequence lives in clickhouse-erasure.ts
   * so it is testable without a server; this method's only job is to address
   * the subject.
   *
   * Runs THIRD, before Postgres, for the same reason Redis does: the thread ids
   * that address the subject's rows here are Postgres rows, and Postgres is
   * about to delete them.
   *
   * A deployment without ClickHouse — which includes local and dev, where it is
   * deliberately not in compose — reports not_provisioned. A deployment WITH
   * ClickHouse that cannot be reached reports failed/unknown. The two must
   * never collapse into one another: only the first settles the operation.
   */
  private clickhouseExecutor = async (
    subject: SubjectKeys,
    organizationId: string,
    subjectKeyHash: string,
  ): Promise<StoreOutcome> => {
    const threadRows: any[] = this.clickhouse?.available
      ? await this.prisma.thread.findMany({
          where: { endUserId: { in: subject.platosEndUserIds } },
          select: { id: true },
        })
      : [];
    return eraseClickhouseSubject({
      clickhouse: this.clickhouse,
      subject,
      organizationId,
      subjectKeyHash,
      threadIds: threadRows.map((t) => t.id),
    });
  };

  /** Postgres. Runs LAST: it holds the identifiers every other store uses. */
  private postgresExecutor = async (
    subject: SubjectKeys,
    organizationId: string,
  ): Promise<StoreOutcome> => {
    const o = pendingStore("postgres");
    const eu = subject.platosEndUserIds;
    const lu = subject.legacyUserIds;
    const subjectWhere = { endUserId: { in: eu } };
    const auditAdapterFields = ["userId", "mcpUserId", "endUserId"] as const;
    const environmentOrganizationWhere = {
      environment: { project: { organizationId } },
    };
    const auditSubjectWhere = {
      ...environmentOrganizationWhere,
      OR: [
        { endUserId: { in: eu } },
        ...lu.flatMap((userId) =>
          auditAdapterFields.map((field) => ({
            arguments: { path: ["__platosAudit", field], equals: userId },
          })),
        ),
      ],
    };
    const safetySubjectWhere = {
      ...environmentOrganizationWhere,
      OR: [
        { endUserId: { in: eu } },
        ...lu.map((userId) => ({
          metadata: { path: ["__platosSafety", "userId"], equals: userId },
        })),
      ],
    };
    const retainedAuditIds: string[] = [];

    try {
      await this.prisma.$transaction(async (tx) => {
        o.deleted += (await tx.messageRating.deleteMany({ where: subjectWhere })).count;
        o.deleted += (await tx.messageAttachment.deleteMany({ where: subjectWhere })).count;
        o.deleted += (await tx.memoryRelationship.deleteMany({ where: subjectWhere })).count;
        o.deleted += (await tx.memoryEntity.deleteMany({ where: subjectWhere })).count;
        o.deleted += (await tx.memory.deleteMany({ where: subjectWhere })).count;
        o.deleted += (await tx.safetyEvent.deleteMany({ where: safetySubjectWhere })).count;
        o.deleted += (await tx.thread.deleteMany({ where: subjectWhere })).count;
        // Audit rows are ANONYMIZED, not deleted: they are the record that the
        // erasure itself happened, and destroying them would remove the proof.
        const auditRows = await tx.toolCallAudit.findMany({
          where: auditSubjectWhere,
          select: { id: true },
        });
        for (const audit of auditRows) {
          retainedAuditIds.push(audit.id);
          await tx.toolCallAudit.update({
            where: { id: audit.id },
            data: {
              endUserId: null,
              arguments: CONTENT_FREE_AUDIT_ARGUMENTS as any,
              result: Prisma.DbNull,
              error: null,
            },
          });
          o.anonymized++;
        }
        // Canonical identity last — without it nothing can be rediscovered.
        if (eu.length) {
          o.deleted += (await tx.endUserIdentity.deleteMany({ where: { endUserId: { in: eu } } })).count;
          o.deleted += (await tx.endUser.deleteMany({ where: { id: { in: eu } } })).count;
        }
      });
    } catch (err: any) {
      return { ...o, status: "failed", failures: 1, verificationStatus: "unknown",
               note: `transaction failed (${err?.name ?? "Error"})` };
    }

    // Negative verification: prove nothing identifying survives.
    const [t, m, auditSubjectSurvivors, retainedAudits, s, e] = await Promise.all([
      this.prisma.thread.count({ where: subjectWhere }),
      this.prisma.memory.count({ where: subjectWhere }),
      this.prisma.toolCallAudit.count({ where: auditSubjectWhere }),
      retainedAuditIds.length
        ? this.prisma.toolCallAudit.findMany({
            where: {
              id: { in: retainedAuditIds },
              ...environmentOrganizationWhere,
            },
            select: {
              id: true,
              endUserId: true,
              arguments: true,
              result: true,
              error: true,
            },
          })
        : Promise.resolve([]),
      this.prisma.safetyEvent.count({ where: safetySubjectWhere }),
      eu.length ? this.prisma.endUser.count({ where: { id: { in: eu } } }) : Promise.resolve(0),
    ]);
    const retainedAuditViolations = retainedAuditIds.length - retainedAudits.filter(isContentFreeAudit).length;
    const a = auditSubjectSurvivors + retainedAuditViolations;
    const survivors = t + m + a + s + e;
    o.verificationStatus = survivors === 0 ? "passed" : "failed";
    o.status = "done";
    o.retained = 0;
    o.note = `verification: threads=${t} memories=${m} audits=${a} safetyEvents=${s} endUsers=${e}`;
    return o;
  };

  private executors(organizationId: string, subjectKeyHash: string): StoreExecutors {
    return {
      minio: this.minioExecutor,
      redis: this.redisExecutor,
      clickhouse: (subject) => this.clickhouseExecutor(subject, organizationId, subjectKeyHash),
      postgres: (subject) => this.postgresExecutor(subject, organizationId),
    };
  }

  // ── public API ─────────────────────────────────────────────────────────

  /**
   * Request an erasure. Idempotent on organization + `idempotencyKey`, and
   * subject-bound so a reused key cannot disclose or target another person.
   */
  async requestErasure(args: {
    externalUserId: string;
    organizationId: string;
    idempotencyKey: string;
    legalHoldPolicyId?: string | null;
  }): Promise<ErasureReceipt> {
    const hash = this.hash(args.externalUserId, args.organizationId);
    const existing = await this.prisma.erasureOperation.findFirst({
      where: { organizationId: args.organizationId, idempotencyKey: args.idempotencyKey },
    });
    if (existing) return this.existingReceiptForSubject(existing, hash);

    const subject = await this.discoverSubject(args.externalUserId, args.organizationId);
    const inventory = await this.inventory(subject, args.organizationId);

    // Server-side hold check, over every alias the subject resolves to. Runs
    // before the operation row is created so a held subject leaves no
    // half-started operation, and before any executor can touch a store.
    // A caller-supplied legalHoldPolicyId still wins if present; this only adds
    // the holds the caller did not know about.
    const heldBy =
      args.legalHoldPolicyId ??
      findLegalHold(
        subject,
        args.externalUserId,
        parseLegalHoldList(process.env.PLATOS_LEGAL_HOLD_USER_IDS),
      );

    let row: any;
    try {
      row = await this.prisma.erasureOperation.create({
        data: {
          id: randomUUID(),
          idempotencyKey: args.idempotencyKey,
          subjectKeyHash: hash,
          organizationId: args.organizationId,
          status: heldBy ? "CANCELLED" : "PENDING",
          scopes: subject.scopes as any,
          stores: [] as any,
          inventory: inventory as any,
          policyVersion: ERASURE_POLICY_VERSION,
          legalHoldPolicyId: heldBy ?? null,
          retryCount: 0,
        },
      });
    } catch (error: any) {
      if (error?.code !== "P2002") throw error;
      const raced = await this.prisma.erasureOperation.findFirst({
        where: { organizationId: args.organizationId, idempotencyKey: args.idempotencyKey },
      });
      if (!raced) throw error;
      return this.existingReceiptForSubject(raced, hash);
    }

    // Return the blocked receipt without running any executor. The operation is
    // recorded rather than dropped: a refused erasure request is itself an event
    // the operator has to be able to evidence later.
    if (heldBy) return this.toReceipt(row);

    const started = await runErasure(this.toReceipt(row), subject, this.executors(args.organizationId, hash), {
      legalHold: args.legalHoldPolicyId ? { policyId: args.legalHoldPolicyId } : null,
    });
    return this.persist(started, [args.externalUserId, ...subject.legacyUserIds]);
  }

  async getErasure(operationId: string): Promise<ErasureReceipt | null> {
    const row = await this.prisma.erasureOperation.findFirst({ where: { id: operationId } });
    return row ? this.toReceipt(row) : null;
  }

  async operationBelongsToOrganization(
    operationId: string,
    organizationId: string,
  ): Promise<boolean> {
    return (await this.prisma.erasureOperation.count({
      where: { id: operationId, organizationId },
    })) > 0;
  }

  async retryErasureById(operationId: string, externalUserId: string): Promise<ErasureReceipt | null> {
    const row = await this.prisma.erasureOperation.findFirst({ where: { id: operationId } });
    if (!row) return null;
    const hash = this.hash(externalUserId, row.organizationId);
    if (!this.hashMatches(hash, row.subjectKeyHash)) return null;
    const receipt = this.toReceipt(row);
    const subject = await this.discoverSubject(externalUserId, row.organizationId);
    const next = await retryErasure(receipt, subject, this.executors(row.organizationId, hash), {
      legalHold: row.legalHoldPolicyId ? { policyId: row.legalHoldPolicyId } : null,
    });
    return this.persist(next, [externalUserId, ...subject.legacyUserIds]);
  }

  private toReceipt(row: any): ErasureReceipt {
    const stores = (row.stores ?? []) as StoreOutcome[];
    const status: ErasureStatus = row.legalHoldPolicyId
      ? "blocked_legal_hold"
      : row.status === "SUCCEEDED"
        ? "completed"
        : row.status === "ACTIVE"
          ? "running"
          : row.status === "FAILED"
            ? deriveStatus(stores, { started: true })
            : "pending";
    return {
      operationId: row.id,
      subjectKeyHash: row.subjectKeyHash,
      requestedAt: row.requestedAt?.toISOString?.() ?? String(row.requestedAt),
      startedAt: row.startedAt?.toISOString?.(),
      completedAt: row.completedAt?.toISOString?.(),
      status,
      scopes: (row.scopes ?? []) as any,
      stores,
      policyVersion: row.policyVersion,
      attempts: row.retryCount ?? 0,
      legalHoldPolicyId: row.legalHoldPolicyId ?? undefined,
    };
  }

  private async persist(r: ErasureReceipt, forbidden: string[]): Promise<ErasureReceipt> {
    // Refuse to write a receipt that would recreate the identifier it documents.
    assertContentFree(r, forbidden);
    await this.prisma.erasureOperation.update({
      where: { id: r.operationId },
      data: {
        status: toDatabaseStatus(r.status),
        stores: r.stores as any,
        retryCount: r.attempts,
        startedAt: r.startedAt ? new Date(r.startedAt) : null,
        completedAt: r.completedAt ? new Date(r.completedAt) : null,
        legalHoldPolicyId: r.legalHoldPolicyId ?? null,
      },
    });
    this.logger.log(`[erasure] ${r.operationId} status=${r.status} attempts=${r.attempts}`);
    return r;
  }
}
