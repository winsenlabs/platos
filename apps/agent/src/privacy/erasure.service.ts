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
  pendingStore, assertContentFree, canRetry,
  deriveStatus, storesNeedingRetry,
  type ErasureReceipt, type ErasureStatus, type StoreOutcome,
} from "./erasure-receipt";
import { runErasure, retryErasure, EXECUTION_ORDER, type StoreExecutors } from "./erasure-orchestrator";
import { findLegalHold, legalHoldReference, parseLegalHoldList } from "./legal-hold";
import { planDeletions, retainedAggregatePatterns, wireScanPatterns } from "./redis-keys";
import { ErasureObjectStore } from "./object-store";
import { ErasureClickhouse } from "./clickhouse";
import { eraseClickhouseSubject } from "./clickhouse-erasure";
import { erasureHashSalt, sealErasedSubject } from "./erasure-register";
import {
  appendNote, buildResumePlan, leaseUntil, objectMapLost, resumePlanFrom,
  scheduleAfterAttempt, subjectFromResumePlan,
  type ErasureResumePlan, type ResumeCoverage,
} from "./erasure-queue";
import {
  assertAuditContentFree, auditEnvironments, finishedAudit, inventoriedAudit,
  refusedAudit, requestedAudit,
  type ErasureAuditActor, type ErasureAuditEntry, type ErasureTrigger,
} from "./erasure-audit";
import { AdminAuditService } from "../monitoring/admin-audit.service";

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
    // Optional in the same sense the object store is: absent means the
    // deployment has not wired it, which is a fact to report rather than a
    // failure to raise. A sink that IS wired and then throws is an incident,
    // and the intent record treats it as one — see `audit`.
    @Optional() private readonly adminAudit?: AdminAuditService,
  ) {
    this.prisma = prisma;
    // Per-deployment salt. Without one, a hash of an email is trivially
    // reversible with a wordlist, which defeats the point of hashing it.
    // Shared with the erased-subject register, which the runtime write paths
    // consult without this service: one salt, or the barrier looks up hashes
    // nobody wrote.
    this.salt = erasureHashSalt();
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

  /**
   * Every handle the subject can be addressed by, for hold matching only.
   *
   * Both the bare handle and the channel-qualified form, because a hold
   * register is written by a human: "U08JTN5FX39" as it appears in Slack, or
   * "slack:U08JTN5FX39" as the documentation writes it. Matching one form and
   * not the other is a hold that quietly does not apply.
   *
   * Unfiltered by `disabledAt` on purpose — the sweep deletes disabled identity
   * rows too, so a hold naming one has to stop it.
   *
   * Kept out of `SubjectKeys` rather than merged into it. These are handles for
   * MATCHING, not locators to delete by, and they are the subject's personal
   * data: widening the subject with them would carry them into the resume plan
   * and into every audit payload built from it.
   */
  private async subjectAliases(
    subject: SubjectKeys,
    organizationId: string,
  ): Promise<string[]> {
    if (!subject.platosEndUserIds.length) return [];
    const rows: Array<{ channel: string; subject: string }> =
      await this.prisma.endUserIdentity.findMany({
        where: { organizationId, endUserId: { in: subject.platosEndUserIds } },
        select: { channel: true, subject: true },
      });
    return rows
      .flatMap((row) => [row.subject, `${row.channel}:${row.subject}`])
      .filter((alias) => typeof alias === "string" && alias.length > 0);
  }

  /**
   * Consult the operator's hold register for this subject.
   *
   * Read from the environment on EVERY pass rather than taken from the
   * operation row. The row records the holds that existed when it was created;
   * counsel files them when they file them, and this branch added an automated
   * drain, so a register consulted once at request time is a register that does
   * not stop a cron destroying a subject placed on hold an hour later.
   *
   * Returns the aliases alongside the match because the caller needs them for a
   * second purpose: they are the subject's own handles, so they are also
   * needles the receipt and the audit trail must be scanned for.
   */
  private async holdCheck(
    subject: SubjectKeys,
    organizationId: string,
    externalUserId?: string,
  ): Promise<{ aliases: string[]; heldBy: string | null }> {
    const register = parseLegalHoldList(process.env.PLATOS_LEGAL_HOLD_USER_IDS);
    // Read only when there is a register to compare them against: with no hold
    // configured there is no reason to pull the subject's handles into memory.
    if (!register.length) return { aliases: [], heldBy: null };

    // The alias set is read here rather than taken from `subject`: discovery
    // resolves the person FROM one identity tuple and reports that one id back,
    // so matching the subject as-discovered compares the register against the
    // requested id and the canonical uuid and nothing else. A hold registered
    // under someone's Slack handle would then not stop an erasure requested
    // under their email — which is the hole this module was written to close
    // for deletion, reopened one layer up.
    const aliases = await this.subjectAliases(subject, organizationId);
    const match = findLegalHold(
      { ...subject, legacyUserIds: [...subject.legacyUserIds, ...aliases] },
      externalUserId ?? "",
      register,
    );
    return {
      aliases,
      // Never the matched entry itself — see legalHoldReference.
      heldBy: match ? legalHoldReference(match, this.hash(match.value, organizationId)) : null,
    };
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
  private minioExecutor = async (
    subject: SubjectKeys,
    plan: ErasureResumePlan | null,
  ): Promise<StoreOutcome> => {
    const o = pendingStore("minio");
    if (!this.attachments?.available) {
      return { ...o, status: "not_provisioned", note: "no object-store client wired" };
    }
    const rows: any[] = await this.prisma.messageAttachment.findMany({
      where: { endUserId: { in: subject.platosEndUserIds } },
      select: { storageKey: true },
    });
    o.discovered = rows.length;
    // A retry discovers nothing here whether the bucket is clean or whether the
    // keys simply became unknowable — Postgres deleted the attachment rows in
    // the same operation, and they were the only map. Left alone the loop below
    // would then report "verified 0/0 objects absent", which is the reassuring
    // reading of the second case. The plan's object count tells them apart, and
    // an unaddressable object is an inconclusive probe: still present.
    if (objectMapLost(plan, rows.length)) {
      return {
        ...o,
        status: "failed",
        failures: 1,
        verificationStatus: "unknown",
        note: `${plan!.attachmentObjects} objects seen before the sweep are no longer addressable; attachment key map deleted`,
      };
    }
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

  private redisExecutor = async (
    subject: SubjectKeys,
    plan: ErasureResumePlan | null,
  ): Promise<StoreOutcome> => {
    const o = pendingStore("redis");
    const refs = {
      threadIds: await this.addressableThreadIds(subject, plan),
      legacyUserIds: subject.legacyUserIds,
      platosEndUserIds: subject.platosEndUserIds,
      scopes: subject.scopes,
    };

    const scanned: string[] = [];
    // Scans that never ran, counted apart from delete failures: they are the
    // difference between "we looked and found nothing" and "we could not look",
    // and only the first of those can support a verification.
    let unscanned = 0;
    // ON THE WIRE. ioredis prefixes key arguments but NOT patterns, so a
    // logical pattern here scans a keyspace that does not exist — and finding
    // nothing looks identical to having deleted everything.
    for (const pattern of wireScanPatterns(refs)) {
      try {
        // keys() returns keys verbatim, so they arrive PREFIXED; planDeletions
        // strips them. Feeding them back to del() unstripped double-prefixes
        // and silently deletes nothing.
        const found = await this.redis.keys(pattern);
        scanned.push(...found);
      } catch { unscanned++; o.failures++; }
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
    // A key found still present is positive evidence and outranks everything. An
    // empty survivor list means nothing at all when the scan that produced it
    // failed: zero probes over an unread keyspace is an inconclusive result, and
    // rounding it down to "gone" is the exact failure this module forbids.
    o.verificationStatus = survivors > 0 ? "failed" : unscanned > 0 ? "unknown" : "passed";
    o.status = o.failures > 0 ? "failed" : "done";
    o.note = `${o.deleted} deleted, ${o.retained} aggregate keys retained (${retainedAggregatePatterns(refs).length} patterns); ${survivors} survivors`;
    if (unscanned > 0) o.note = appendNote(o.note, `${unscanned} patterns could not be scanned`);
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
    plan: ErasureResumePlan | null,
  ): Promise<StoreOutcome> => {
    return eraseClickhouseSubject({
      clickhouse: this.clickhouse,
      subject,
      organizationId,
      subjectKeyHash,
      threadIds: this.clickhouse?.available
        ? await this.addressableThreadIds(subject, plan)
        : [],
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

  /**
   * Write the erased-subject register entries, before any store is touched.
   *
   * Order matters twice over. It has to precede the executors, because a turn
   * landing mid-sweep would otherwise write rows MinIO and Redis have already
   * scanned past. And it has to precede Postgres specifically, because the
   * PlatosEndUserIdentity rows that enumerate the subject's aliases are what
   * Postgres is about to delete — after the sweep there is nothing left to
   * learn the Slack handle or the email address from.
   *
   * Not a store outcome: the register is not a place subject data lives, so it
   * has no business in `stores` where it would move the completion bar. It is a
   * precondition, and a failure to seal aborts the run rather than degrading
   * it — sweeping without a barrier is the exact hole this closes.
   */
  private async seal(
    subject: SubjectKeys,
    args: { operationId: string; organizationId: string; externalUserId?: string },
  ): Promise<void> {
    const sealed = await sealErasedSubject(this.prisma, {
      organizationId: args.organizationId,
      operationId: args.operationId,
      policyVersion: ERASURE_POLICY_VERSION,
      platosEndUserIds: subject.platosEndUserIds,
      // The requested id under the tuple discoverSubject matched it by, plus
      // every denormalized handle seen historically for the same person.
      //
      // Both are absent on a queue-driven pass, which knows the subject only by
      // its locators. That narrows the extra aliases to nothing; it does not
      // narrow the seal to nothing, because the canonical ids still enumerate
      // the identity rows — and if Postgres has already taken those, the first
      // pass sealed the handles they carried.
      extraAliases: [args.externalUserId, ...subject.legacyUserIds]
        .filter((id): id is string => typeof id === "string" && id.length > 0)
        .flatMap((id) => [
          { channel: "external", subject: id },
          { channel: "session", subject: id },
        ]),
      salt: this.salt,
    });
    this.logger.log(
      `[erasure] ${args.operationId} sealed=${sealed.aliases} aliases (new=${sealed.sealed}, purged=${sealed.purged})`,
    );
  }

  /**
   * Thread ids the subject's Redis keys and ClickHouse rows are addressed by.
   *
   * Both stores discovered these from Postgres, and Postgres deletes them in
   * the same operation — so on a retry the discovery returns nothing and the
   * sweep quietly scans for nothing at all. `platos:trace:thread:<id>` is not
   * gone because the thread row is: the key outlives the row that names it.
   *
   * The plan is the union rather than the replacement because both are partial:
   * discovery sees threads created after the plan was written, the plan sees
   * threads Postgres has since deleted.
   */
  private async addressableThreadIds(
    subject: SubjectKeys,
    plan: ErasureResumePlan | null,
  ): Promise<string[]> {
    const discovered = await this.subjectThreadIds(subject);
    return [...new Set([...discovered, ...(plan?.threadIds ?? [])])].sort();
  }

  private executors(
    organizationId: string,
    subjectKeyHash: string,
    plan: ErasureResumePlan | null = null,
  ): StoreExecutors {
    return {
      minio: (subject) => this.minioExecutor(subject, plan),
      redis: (subject) => this.redisExecutor(subject, plan),
      clickhouse: (subject) =>
        this.clickhouseExecutor(subject, organizationId, subjectKeyHash, plan),
      postgres: (subject) => this.postgresExecutor(subject, organizationId),
    };
  }

  // ── queue and audit plumbing ───────────────────────────────────────────

  /**
   * Take the operation's lease, or report that somebody else holds it.
   *
   * This is what makes retry idempotent. Two concurrent retries — an operator
   * hitting the route twice, or the queue drain overlapping with them — would
   * otherwise both compute the same unsettled store set and both sweep it,
   * re-issuing deletes and overwriting each other's receipt with counts that
   * describe neither pass. One conditional UPDATE settles which one runs.
   *
   * The lease is time-bounded rather than held forever, because the failure it
   * has to survive is a pass whose process died: an unexpiring lease would pin
   * the operation until a human cleared it by hand, which is the situation this
   * whole file exists to get out of.
   */
  private async claimLease(operationId: string, now: Date): Promise<string | null> {
    const token = randomUUID();
    const claimed = await this.prisma.erasureOperation.updateMany({
      where: {
        id: operationId,
        OR: [{ leaseExpiresAt: null }, { leaseExpiresAt: { lte: now } }],
      },
      data: { leaseToken: token, leaseExpiresAt: leaseUntil(now) },
    });
    return claimed.count === 1 ? token : null;
  }

  /**
   * Write one AdminAudit row per environment the subject appears in.
   *
   * `recordSync` rather than `record`: the fire-and-forget variant swallows its
   * own failures, which is the wrong shape for the record of an irreversible
   * destruction. Callers decide what a failure means — the intent record treats
   * it as a reason not to proceed, the outcome record as an incident to log.
   */
  private async audit(
    args: {
      organizationId: string;
      scopes: SubjectScope[];
      actor?: ErasureAuditActor;
      forbidden: string[];
    },
    build: (actor: ErasureAuditActor) => ErasureAuditEntry,
  ): Promise<void> {
    // No actor means no answer to "who", and a record naming nobody is not
    // worth the row. The controller always has one; only in-process callers
    // can omit it.
    if (!args.actor) return;
    const entry = build(args.actor);
    // Checked before the write, not after: an audit row is append-only at the
    // database level, so a leaked identifier in one cannot be edited out.
    assertAuditContentFree(entry, args.forbidden);
    if (!this.adminAudit) {
      this.logger.warn(`[erasure] no admin-audit sink wired; ${entry.action} not recorded`);
      return;
    }
    const byEnvironment = new Map(args.scopes.map((scope) => [scope.environmentId, scope]));
    for (const environmentId of auditEnvironments(args.scopes, args.actor.environmentId)) {
      const scope = byEnvironment.get(environmentId);
      await this.adminAudit.recordSync(
        {
          organizationId: args.organizationId,
          projectId: scope?.projectId ?? args.actor.projectId,
          environmentId,
          // AdminAuditService types the scope's userId as required but writes
          // `scope.userId ?? null`. An actor with no minted operator has to
          // land as NULL, not as an empty string that reads like an id.
          userId: (args.actor.userId ?? null) as unknown as string,
        },
        {
          action: entry.action,
          subjectType: entry.subjectType,
          subjectId: entry.subjectId,
          afterJson: entry.payload,
          reason: entry.reason,
          source: entry.source,
        },
      );
    }
  }

  /**
   * Audit an event whose own failure must not change the outcome.
   *
   * Refusals and completed passes both qualify: the refusal already happened
   * and the destruction already happened, so raising here would turn a recorded
   * event into an unrecorded one plus an error. Only the INTENT record is
   * allowed to abort, and it does so before anything is destroyed.
   */
  private async auditBestEffort(
    args: {
      organizationId: string;
      scopes: SubjectScope[];
      actor?: ErasureAuditActor;
      forbidden: string[];
    },
    build: (actor: ErasureAuditActor) => ErasureAuditEntry,
  ): Promise<void> {
    try {
      await this.audit(args, build);
    } catch (error: any) {
      this.logger.error(`[erasure] audit write failed (${error?.name ?? "Error"})`);
    }
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
    actor?: ErasureAuditActor;
  }): Promise<ErasureReceipt> {
    const now = new Date();
    const hash = this.hash(args.externalUserId, args.organizationId);
    const forbidden = [args.externalUserId];
    const existing = await this.prisma.erasureOperation.findFirst({
      where: { organizationId: args.organizationId, idempotencyKey: args.idempotencyKey },
    });
    if (existing) {
      try {
        return this.existingReceiptForSubject(existing, hash);
      } catch (error) {
        // An idempotency key bound to another subject is someone targeting
        // person B with person A's key. Previously that was a 409 and nothing
        // else; it is the refusal most worth keeping.
        if (error instanceof ErasureIdempotencyConflictError) {
          await this.auditBestEffort(
            { organizationId: args.organizationId, scopes: [], actor: args.actor, forbidden },
            (actor) =>
              refusedAudit({
                subjectKeyHash: hash,
                reason: "idempotency key is already bound to another subject",
                actor,
                operationId: existing.id,
                policyVersion: existing.policyVersion,
              }),
          );
        }
        throw error;
      }
    }

    const subject = await this.discoverSubject(args.externalUserId, args.organizationId);
    const inventory = await this.inventory(subject, args.organizationId);

    // Server-side hold check, over every alias the subject resolves to. Runs
    // before the operation row is created so a held subject leaves no
    // half-started operation, and before any executor can touch a store.
    // A caller-supplied legalHoldPolicyId still wins if present; this only adds
    // the holds the caller did not know about.
    const hold = await this.holdCheck(subject, args.organizationId, args.externalUserId);
    const heldBy = args.legalHoldPolicyId ?? hold.heldBy;

    // Every identifier this subject is known by, once discovery has found them.
    // Wider than the requested id, and the guards below scan for all of them.
    //
    // The hold aliases belong in here even though they are deliberately kept out
    // of the SUBJECT: they are channel handles — Slack ids, email addresses —
    // and the guards are the only thing standing between one of them and a
    // durable record of the person it names.
    const subjectForbidden = [args.externalUserId, ...subject.legacyUserIds, ...hold.aliases];

    // Captured here and nowhere else. This is the last moment at which every
    // locator is still resolvable: Postgres holds the threads, the attachment
    // rows and the identity rows, and is about to delete all three. A retry
    // that has to re-discover the subject afterwards cannot, which is why the
    // old retry route demanded the external id back from the caller.
    //
    // Not captured for a held subject: nothing will run, so there is nothing to
    // resume, and a plan on a blocked operation is a set of locators for a
    // person we have been told not to touch.
    const plan = heldBy
      ? null
      : buildResumePlan({
          subject,
          threadIds: await this.subjectThreadIds(subject),
          attachmentObjects: Number(inventory.attachments ?? 0),
        });

    // Leased and scheduled from birth. If this process dies between the create
    // and the receipt, the row does not sit at PENDING forever: the lease
    // expires and `nextAttemptAt` has already made it due.
    const leaseToken = randomUUID();
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
          resumePlan: (plan ?? undefined) as any,
          policyVersion: ERASURE_POLICY_VERSION,
          legalHoldPolicyId: heldBy ?? null,
          retryCount: 0,
          nextAttemptAt: heldBy ? null : now,
          leaseToken: heldBy ? null : leaseToken,
          leaseExpiresAt: heldBy ? null : leaseUntil(now),
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
    if (heldBy) {
      await this.auditBestEffort(
        {
          organizationId: args.organizationId,
          scopes: subject.scopes,
          actor: args.actor,
          forbidden: subjectForbidden,
        },
        (actor) =>
          refusedAudit({
            subjectKeyHash: hash,
            reason: "legal hold in force",
            actor,
            operationId: row.id,
            policyVersion: ERASURE_POLICY_VERSION,
            legalHoldPolicyId: heldBy,
          }),
      );
      return this.toReceipt(row);
    }

    // Intent before destruction. Raises rather than degrading: if we cannot
    // record who asked for an irreversible deletion, we do not perform it. The
    // operation stays PENDING, leased-and-due, and the queue picks it up once
    // the audit sink is healthy again.
    await this.audit(
      {
        organizationId: args.organizationId,
        scopes: subject.scopes,
        actor: args.actor,
        forbidden: subjectForbidden,
      },
      (actor) =>
        requestedAudit({
          operationId: row.id,
          subjectKeyHash: hash,
          policyVersion: ERASURE_POLICY_VERSION,
          trigger: "request",
          coverage: "full",
          actor,
          inventory,
          stores: [...EXECUTION_ORDER],
          attempts: 0,
        }),
    );

    // Barrier first, destruction second. Throws rather than sweeping unsealed:
    // the operation stays PENDING and retryable, which is recoverable, whereas
    // an unsealed sweep is a subject the next request restores.
    await this.seal(subject, {
      operationId: row.id,
      organizationId: args.organizationId,
      externalUserId: args.externalUserId,
    });

    const started = await runErasure(
      this.toReceipt(row),
      subject,
      this.executors(args.organizationId, hash, plan),
      {
        legalHold: args.legalHoldPolicyId ? { policyId: args.legalHoldPolicyId } : null,
        coverage: "full",
      },
    );
    return this.finish(started, {
      organizationId: args.organizationId,
      scopes: subject.scopes,
      forbidden: subjectForbidden,
      trigger: "request",
      coverage: "full",
      leaseToken,
      actor: args.actor,
      now,
    });
  }

  /**
   * Record that someone enumerated a subject's footprint.
   *
   * The inventory route is read-only, which is exactly why it left no trace and
   * exactly why it needs one: "who went looking at this person" is a question
   * an operator gets asked, and a content-free count of their threads and
   * memories is still a statement that this person exists here.
   *
   * Best-effort: a read is not destruction, and failing the read because the
   * audit sink is unhealthy would be a worse trade than the missing row.
   */
  async auditInventoryRead(args: {
    externalUserId: string;
    organizationId: string;
    subject: SubjectKeys;
    inventory: Record<string, unknown>;
    actor?: ErasureAuditActor;
  }): Promise<void> {
    const hash = this.hash(args.externalUserId, args.organizationId);
    await this.auditBestEffort(
      {
        organizationId: args.organizationId,
        scopes: args.subject.scopes,
        actor: args.actor,
        forbidden: [args.externalUserId, ...args.subject.legacyUserIds],
      },
      (actor) =>
        inventoriedAudit({
          subjectKeyHash: hash,
          policyVersion: ERASURE_POLICY_VERSION,
          actor,
          inventory: args.inventory,
          resolvedEndUsers: args.subject.platosEndUserIds.length,
        }),
    );
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

  /**
   * Operator retry: the caller supplies the subject id, so the pass sees
   * everything the first one did and its verifications are worth the same.
   *
   * Discovery alone is no longer enough to build that subject, and that is the
   * point of merging the plan in. Once Postgres has run, the identity row
   * `discoverSubject` matches on is gone, so it resolves to nothing — and an
   * empty subject short-circuits the whole run to `verification_failed`, which
   * would take an operation with three settled stores and report it as a
   * failure. The plan supplies the locators discovery can no longer find; the
   * caller supplies the legacy id the plan deliberately does not hold.
   */
  async retryErasureById(
    operationId: string,
    externalUserId: string,
    actor?: ErasureAuditActor,
  ): Promise<ErasureReceipt | null> {
    const row = await this.prisma.erasureOperation.findFirst({ where: { id: operationId } });
    if (!row) return null;
    const hash = this.hash(externalUserId, row.organizationId);
    if (!this.hashMatches(hash, row.subjectKeyHash)) return null;
    const plan = resumePlanFrom(row.resumePlan);
    const discovered = await this.discoverSubject(externalUserId, row.organizationId);
    // The LOCATORS, before the caller's id is folded in. Emptiness has to be
    // decided on these alone: the id proves who the subject is, it does not make
    // them addressable. An operation created before the plan column existed —
    // which is every operation on the deployment this work upgrades — resolves
    // to nothing here once Postgres has run, and merging the id in first would
    // produce a subject that is non-empty by `isEmptySubject`, sails past the
    // orchestrator's guard, addresses no thread, no scope and no attachment row,
    // and certifies "0 discovered, 0 survivors, passed" for every store.
    const located = mergeSubjectKeys(discovered, plan ? subjectFromResumePlan(plan) : null);
    if (isEmptySubject(located)) {
      const receipt = this.toReceipt(row);
      // The same call `resumeErasure` makes for a plan-less row, and for the
      // same reason: stop rather than sweep against a subject nothing can
      // address. The difference is that this route was the documented fallback
      // for exactly that row, so the refusal has to be recorded — an operator
      // whose retry silently no-ops learns nothing.
      await this.auditBestEffort(
        {
          organizationId: row.organizationId,
          scopes: receipt.scopes,
          actor,
          forbidden: [externalUserId],
        },
        (auditActor) =>
          refusedAudit({
            subjectKeyHash: receipt.subjectKeyHash,
            reason: "no resume plan and nothing left to discover; subject is unaddressable",
            actor: auditActor,
            operationId: receipt.operationId,
            policyVersion: receipt.policyVersion,
            legalHoldPolicyId: receipt.legalHoldPolicyId ?? null,
          }),
      );
      this.logger.warn(
        `[erasure] ${row.id} has no addressable subject; refusing to sweep and verify nothing`,
      );
      return receipt;
    }
    const subject = mergeSubjectKeys(
      located,
      // Safe to assert: the hash comparison above already proved this id is
      // this operation's subject. Discovery cannot prove it a second time
      // because the row it would prove it from is what the first pass deleted.
      { legacyUserIds: [externalUserId] },
    );
    return this.runResumePass(row, {
      subject,
      coverage: "full",
      trigger: "operator-retry",
      externalUserId,
      plan,
      forbidden: [externalUserId, ...subject.legacyUserIds],
      actor,
      now: new Date(),
    });
  }

  /**
   * Queue resume: no subject id, so the pass runs from the persisted plan.
   *
   * It still deletes — the locators address most of the subject — but it cannot
   * certify the rows keyed by the legacy external id, and `coverage` makes sure
   * it does not try. See erasure-queue.ts.
   */
  async resumeErasure(
    operationId: string,
    actor?: ErasureAuditActor,
    now: Date = new Date(),
  ): Promise<ErasureReceipt | null> {
    const row = await this.prisma.erasureOperation.findFirst({ where: { id: operationId } });
    if (!row) return null;
    const plan = resumePlanFrom(row.resumePlan);
    if (!plan) {
      // An operation from before the plan existed, or one whose plan did not
      // survive the Json boundary. Stop re-driving it rather than sweeping
      // against an empty subject; the operator retry route still works.
      await this.prisma.erasureOperation.update({
        where: { id: row.id },
        data: { nextAttemptAt: null },
      });
      this.logger.warn(`[erasure] ${row.id} has no resume plan; leaving it for an operator`);
      return this.toReceipt(row);
    }
    return this.runResumePass(row, {
      subject: subjectFromResumePlan(plan),
      coverage: "locators_only",
      trigger: "queue-resume",
      plan,
      // Nothing to forbid: an id-free resume never learns the identifier, so
      // there is no needle to scan the receipt for. The guard still runs.
      forbidden: [],
      actor,
      now,
    });
  }

  /**
   * Drain the queue for one organization.
   *
   * Selection is the whole design: due, not held, not settled, and not leased.
   * Anything exhausted has already had its `nextAttemptAt` cleared, so it drops
   * out here without a special case — the row keeps its receipt and its plan
   * and waits for an operator rather than churning.
   */
  async resumeDueErasures(args: {
    organizationId: string;
    limit?: number;
    actor?: ErasureAuditActor;
    now?: Date;
  }): Promise<Array<{ operationId: string; status: ErasureStatus; attempts: number }>> {
    const now = args.now ?? new Date();
    const rows: any[] = await this.prisma.erasureOperation.findMany({
      where: {
        organizationId: args.organizationId,
        legalHoldPolicyId: null,
        status: { in: ["PENDING", "ACTIVE", "FAILED"] },
        nextAttemptAt: { lte: now },
        OR: [{ leaseExpiresAt: null }, { leaseExpiresAt: { lte: now } }],
      },
      orderBy: { nextAttemptAt: "asc" },
      take: Math.min(Math.max(1, Math.trunc(args.limit ?? 10)), 50),
    });
    const resumed: Array<{ operationId: string; status: ErasureStatus; attempts: number }> = [];
    for (const row of rows) {
      // One failing operation must not stop the drain: they are independent
      // subjects, and the queue exists precisely because things fail.
      try {
        const receipt = await this.resumeErasure(row.id, args.actor, now);
        if (receipt) {
          resumed.push({
            operationId: receipt.operationId,
            status: receipt.status,
            attempts: receipt.attempts,
          });
        }
      } catch (error: any) {
        this.logger.error(`[erasure] resume failed for ${row.id} (${error?.name ?? "Error"})`);
      }
    }
    return resumed;
  }

  /**
   * One retry pass, whichever entry point asked for it.
   *
   * Order here is load-bearing: refuse before claiming, claim before sealing,
   * seal before sweeping. Claiming first would leave a lease on an operation
   * that was never allowed to run.
   *
   * And re-read before doing any of it. Everything this pass decides — whether
   * a retry is permitted, which stores are outstanding, what receipt the next
   * one is written on top of — comes from a row that was read before the lease
   * existed. The lease serializes passes; it does not refresh a view taken
   * before it was taken. A pass that claims on a stale view re-sweeps stores
   * another pass has already settled and writes a superseded receipt back over
   * a signed-off one.
   */
  private async runResumePass(
    row: any,
    args: {
      subject: SubjectKeys;
      coverage: ResumeCoverage;
      trigger: ErasureTrigger;
      forbidden: string[];
      plan?: ErasureResumePlan | null;
      externalUserId?: string;
      actor?: ErasureAuditActor;
      now: Date;
    },
  ): Promise<ErasureReceipt> {
    const receipt = this.toReceipt(row);
    const auditScope = {
      organizationId: row.organizationId,
      scopes: receipt.scopes,
      actor: args.actor,
      forbidden: args.forbidden,
    };

    // `canRetry` has existed and been tested since the first version of this
    // module and was called from nowhere; a completed operation was re-run and
    // happened to no-op, and a held one was re-run and happened to short-
    // circuit. Both by accident of the code path rather than by the guard.
    const permitted = canRetry(receipt);
    if (!permitted.allowed) {
      await this.auditBestEffort(auditScope, (actor) =>
        refusedAudit({
          subjectKeyHash: receipt.subjectKeyHash,
          reason: permitted.reason ?? "retry not permitted",
          actor,
          operationId: receipt.operationId,
          policyVersion: receipt.policyVersion,
          legalHoldPolicyId: receipt.legalHoldPolicyId ?? null,
        }),
      );
      return receipt;
    }

    // The register, not the row. `canRetry` reads `legalHoldPolicyId` off the
    // operation, which records only the holds that existed when it was created
    // — and the queue drains without a human in the loop, so a hold filed after
    // that row was written would otherwise be destroyed by a cron that never
    // asked whether one existed.
    const hold = await this.holdCheck(args.subject, row.organizationId, args.externalUserId);
    if (hold.heldBy) {
      // Recorded on the row, which takes it out of the drain's selection: the
      // queue skips anything held. Deliberately leaves the store outcomes and
      // the database status alone — a pass stopped by a hold has nothing new to
      // say about what earlier passes destroyed, and `toReceipt` derives the
      // blocked status from the hold itself.
      await this.prisma.erasureOperation.update({
        where: { id: row.id },
        data: { legalHoldPolicyId: hold.heldBy, nextAttemptAt: null },
      });
      await this.auditBestEffort(
        // The aliases join the needles for this record: matching one of them is
        // exactly what happened, and it must not be what gets written down.
        { ...auditScope, forbidden: [...args.forbidden, ...hold.aliases] },
        (actor) =>
          refusedAudit({
            subjectKeyHash: receipt.subjectKeyHash,
            reason: "legal hold in force",
            actor,
            operationId: receipt.operationId,
            policyVersion: receipt.policyVersion,
            legalHoldPolicyId: hold.heldBy,
          }),
      );
      this.logger.warn(`[erasure] ${row.id} stopped by a legal hold; leaving it for an operator`);
      return { ...receipt, status: "blocked_legal_hold", legalHoldPolicyId: hold.heldBy };
    }

    if (storesNeedingRetry(receipt).length === 0) {
      // Nothing to do, so nothing to schedule. Clearing the due marker stops
      // the queue picking the row up again every tick.
      await this.prisma.erasureOperation.update({
        where: { id: row.id },
        data: { nextAttemptAt: null },
      });
      return receipt;
    }

    const leaseToken = await this.claimLease(row.id, args.now);
    if (!leaseToken) {
      // Someone else is mid-pass. Returning the current receipt rather than
      // waiting or duplicating is the point: a second destructive pass over the
      // same subject would report counts describing neither.
      this.logger.log(`[erasure] ${row.id} already leased; skipping this pass`);
      return receipt;
    }

    // Under the lease, and only now, is what the row says stable. Everything
    // from here is decided on THIS view: the pass that just released the lease
    // may have settled stores, changed the attempt count and completed the
    // operation between the read at the top and the claim above.
    const claimed = await this.prisma.erasureOperation.findFirst({ where: { id: row.id } });
    const current = claimed ? this.toReceipt(claimed) : receipt;
    const outstanding = storesNeedingRetry(current);
    const stillPermitted = canRetry(current);
    if (!stillPermitted.allowed || outstanding.length === 0) {
      // Another pass finished the job while this one was queueing for the lease.
      // Hand back what it achieved rather than re-running its stores and
      // overwriting its receipt with this pass's account of work it did not do.
      await this.releaseLease(row.id, leaseToken, { clearSchedule: outstanding.length === 0 });
      this.logger.log(`[erasure] ${row.id} settled by a concurrent pass; nothing left to run`);
      return current;
    }

    try {
      await this.audit(auditScope, (actor) =>
        requestedAudit({
          operationId: current.operationId,
          subjectKeyHash: current.subjectKeyHash,
          policyVersion: current.policyVersion,
          trigger: args.trigger,
          coverage: args.coverage,
          actor,
          stores: outstanding,
          attempts: current.attempts,
        }),
      );

      // Re-seal before re-sweeping, on the same terms as the first pass. The
      // alias set is narrower than the first pass (Postgres has already taken
      // the identity rows), which is why the original tombstones matter: this
      // extends them rather than rebuilding them. A held operation never
      // reaches here — the register and `canRetry` both refused above — so a
      // subject we are forbidden to erase is never tombstoned.
      //
      // Sealed on every pass, including the ones with no external id in hand.
      // A queue-driven pass is reached precisely when the first one aborted
      // before sealing — that is the recovery the intent record's failure
      // nominates — so treating the barrier as the request path's job leaves
      // the drain destroying a subject with no tombstone to keep them erased.
      await this.seal(args.subject, {
        operationId: row.id,
        organizationId: row.organizationId,
        externalUserId: args.externalUserId,
      });
    } catch (error) {
      // Both of those raise rather than degrade, on purpose, and the lease
      // release lives in `finish` — which this pass will never reach. Left
      // alone the operation keeps a lease nobody holds for the full TTL, and
      // keeps an attempt count that never advances, so an unhealthy audit sink
      // re-drives it forever instead of parking it for an operator.
      await this.abandonPass(current, leaseToken, args.now);
      throw error;
    }

    const next = await retryErasure(
      current,
      args.subject,
      this.executors(row.organizationId, current.subjectKeyHash, args.plan ?? null),
      { legalHold: null, coverage: args.coverage },
    );
    return this.finish(next, {
      organizationId: row.organizationId,
      scopes: current.scopes,
      forbidden: args.forbidden,
      trigger: args.trigger,
      coverage: args.coverage,
      leaseToken,
      actor: args.actor,
      now: args.now,
    });
  }

  /**
   * Give the lease back, so the next pass does not have to wait it out.
   *
   * Conditional on still holding it: a pass whose lease expired mid-sweep has
   * been superseded, and clearing the token would strip the lease of whoever
   * took over.
   */
  private async releaseLease(
    operationId: string,
    leaseToken: string,
    opts: { clearSchedule?: boolean } = {},
  ): Promise<void> {
    const released = await this.prisma.erasureOperation.updateMany({
      where: { id: operationId, leaseToken },
      data: {
        leaseToken: null,
        leaseExpiresAt: null,
        ...(opts.clearSchedule ? { nextAttemptAt: null } : {}),
      },
    });
    if (released.count === 0) {
      this.logger.warn(`[erasure] ${operationId} lease was taken over mid-pass`);
    }
  }

  /**
   * Abandon a pass that claimed the lease and then could not proceed.
   *
   * The attempt COUNTS. Nothing was destroyed, so counting it is not a
   * statement about the subject's data — it is the only thing that stops a
   * permanently unhealthy dependency re-driving the same operation until
   * somebody notices, and `isExhausted` is what eventually parks it for a human.
   */
  private async abandonPass(
    receipt: ErasureReceipt,
    leaseToken: string,
    now: Date,
  ): Promise<void> {
    const attempts = receipt.attempts + 1;
    const schedule = scheduleAfterAttempt({ ...receipt, attempts }, now);
    const released = await this.prisma.erasureOperation.updateMany({
      where: { id: receipt.operationId, leaseToken },
      data: {
        retryCount: attempts,
        nextAttemptAt: schedule.nextAttemptAt,
        leaseToken: null,
        leaseExpiresAt: null,
      },
    });
    if (released.count === 0) {
      this.logger.warn(`[erasure] ${receipt.operationId} lease was taken over mid-pass`);
    }
    this.logger.warn(
      `[erasure] ${receipt.operationId} pass abandoned before sweeping at attempt ${attempts}; next=${schedule.nextAttemptAt?.toISOString() ?? "none"}`,
    );
  }

  /** Thread ids the subject owns, read while Postgres still has them. */
  private async subjectThreadIds(subject: SubjectKeys): Promise<string[]> {
    if (!subject.platosEndUserIds.length) return [];
    const rows: any[] = await this.prisma.thread.findMany({
      where: { endUserId: { in: subject.platosEndUserIds } },
      select: { id: true },
    });
    return rows.map((t) => t.id);
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

  /**
   * Close out a pass: persist the receipt, schedule the next attempt, release
   * the lease, record the outcome.
   *
   * The order is not cosmetic. The receipt is written FIRST and
   * unconditionally, even if the lease was stolen by an expiry race, because it
   * is evidence of destruction that has already happened — dropping it would
   * leave the data gone and the record of it gone too. Only the lease release
   * is conditional on still owning the lease.
   */
  private async finish(
    r: ErasureReceipt,
    opts: {
      organizationId: string;
      scopes: SubjectScope[];
      forbidden: string[];
      trigger: ErasureTrigger;
      coverage: ResumeCoverage;
      leaseToken: string | null;
      actor?: ErasureAuditActor;
      now: Date;
    },
  ): Promise<ErasureReceipt> {
    const schedule = scheduleAfterAttempt(r, opts.now);
    await this.persist(r, opts.forbidden, schedule.nextAttemptAt);

    if (opts.leaseToken) await this.releaseLease(r.operationId, opts.leaseToken);

    if (schedule.reason === "exhausted") {
      this.logger.warn(
        `[erasure] ${r.operationId} exhausted automatic attempts at ${r.attempts}; awaiting an operator`,
      );
    }

    await this.auditBestEffort(
      {
        organizationId: opts.organizationId,
        scopes: opts.scopes,
        actor: opts.actor,
        forbidden: opts.forbidden,
      },
      (actor) =>
        finishedAudit({
          receipt: r,
          trigger: opts.trigger,
          coverage: opts.coverage,
          actor,
          nextAttemptAt: schedule.nextAttemptAt,
        }),
    );
    return r;
  }

  private async persist(
    r: ErasureReceipt,
    forbidden: string[],
    nextAttemptAt: Date | null,
  ): Promise<ErasureReceipt> {
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
        nextAttemptAt,
      },
    });
    this.logger.log(
      `[erasure] ${r.operationId} status=${r.status} attempts=${r.attempts} next=${nextAttemptAt?.toISOString() ?? "none"}`,
    );
    return r;
  }
}
