/**
 * Erasure audit — who destroyed what, when, and what was deliberately kept.
 *
 * THE DEFECT THIS EXISTS TO FIX
 *
 * The only trace an erasure left was the ErasureOperation row and a single log
 * line. Between them they answered "what happened" but never "who asked", and
 * the questions an operator actually gets asked after an irreversible deletion
 * are the ones nothing here could answer:
 *
 *   - WHO. The controller verifies an admin credential and then throws it away;
 *     `requestErasure` never took an actor at all. Nothing recorded which
 *     credential, or which human behind it, destroyed a person's data.
 *   - THE REFUSALS. A legal-hold block left a CANCELLED row and no statement of
 *     which register entry stopped it. An idempotency conflict — someone
 *     targeting person B with person A's key — was rejected and logged nowhere,
 *     which is the one refusal most worth keeping.
 *   - THE READS. The inventory route enumerates a subject's footprint and left
 *     no record, so "who went looking at this person" was unanswerable.
 *   - THE HISTORY. `stores` is overwritten wholesale on every attempt, so each
 *     retry destroys the previous attempt's evidence.
 *
 * AdminAudit is append-only at the database level (`reject_admin_audit_mutation`),
 * which is what makes it the right home for all four: a per-attempt record that
 * nothing later can quietly revise.
 *
 * TWO RECORDS PER PASS, NOT ONE
 *
 * `requested` is written BEFORE any executor runs and `finished` after the
 * receipt is persisted. One record would be cheaper and would lose the case
 * that matters: a pass that dies mid-sweep. The intent record survives it, so
 * "who asked, and when" is answerable even when the outcome never got written.
 *
 * CONTENT-FREE, ON THE SAME TERMS AS THE RECEIPT
 *
 * An audit trail of an erasure that quotes the erased identifiers recreates the
 * data it documents, in a table nobody thinks to sweep. `subjectId` is the
 * salted, organization-scoped hash — the same primitive the receipt and the
 * tombstone register use — and `assertAuditContentFree` scans the WHOLE entry,
 * not just its notes, because an audit payload is assembled from more places
 * than a receipt is.
 *
 * Pure and dependency-free: the writing happens in ErasureService, the shape
 * and the guarantees are decided here where they can be tested.
 */

import type { ErasureReceipt, StoreOutcome } from "./erasure-receipt";
import type { ResumeCoverage } from "./erasure-queue";
import type { SubjectScope } from "./subject-graph";

/** AdminAudit.subjectType for every record this module writes. */
export const ERASURE_AUDIT_SUBJECT_TYPE = "privacy.erasure_subject";

export type ErasureAuditAction =
  /** Intent, before any store is touched. */
  | "privacy.erasure.requested"
  /** Outcome, after the receipt is persisted. */
  | "privacy.erasure.finished"
  /** Nothing ran: legal hold, idempotency conflict, attempts exhausted. */
  | "privacy.erasure.refused"
  /** A subject's footprint was enumerated. */
  | "privacy.erasure.inventoried";

/** What caused this pass. Distinguishes an operator from the queue. */
export type ErasureTrigger = "request" | "operator-retry" | "queue-resume";

/**
 * Retention classes — what an erasure deliberately leaves behind, and how long.
 *
 * Named on every record so the entry states its own retention rule rather than
 * deferring to a policy document that will not be next to it in five years.
 */
export const RETENTION_CLASSES = {
  /**
   * The receipt, the anonymized tool-call audits, and this trail. Retained
   * indefinitely: they are the proof the erasure happened, and destroying them
   * to be tidy would leave the operator unable to evidence compliance with the
   * very request they honoured.
   */
  evidence: "erasure-evidence",
  /**
   * The tombstone register. Bounded — see DEFAULT_TOMBSTONE_TTL_DAYS — because
   * a permanent register of erased people is itself a record of them.
   */
  barrier: "erasure-barrier",
} as const;

export type RetentionClass = (typeof RETENTION_CLASSES)[keyof typeof RETENTION_CLASSES];

/** The admin credential answerable for the destruction. */
export interface ErasureAuditActor {
  /** The control-plane credential row id, never the token. */
  credentialId: string;
  /** The operator who minted it — the human behind the credential. */
  userId: string | null;
  /** Where the credential is bound; the fallback audit environment. */
  environmentId: string;
  /** Project of that binding, for rows filed against the fallback. */
  projectId: string;
}

/** One AdminAudit row's worth of content-free erasure detail. */
export interface ErasureAuditEntry {
  action: ErasureAuditAction;
  subjectType: typeof ERASURE_AUDIT_SUBJECT_TYPE;
  /** The salted, organization-scoped subject hash. Never a raw identifier. */
  subjectId: string;
  reason?: string;
  source: "api";
  payload: Record<string, unknown>;
}

/**
 * Per-store outcome, reduced to the fields that carry no content.
 *
 * `note` is included because store notes are already held to the error-CLASS
 * rule, and it is where the useful operational detail lives — a mutation id, a
 * retained-key count, the reason a verification was demoted.
 */
export function storeAuditSummary(stores: StoreOutcome[]): Array<Record<string, unknown>> {
  return stores.map((s) => ({
    store: s.store,
    status: s.status,
    verification: s.verificationStatus,
    discovered: s.discovered,
    deleted: s.deleted,
    anonymized: s.anonymized,
    retained: s.retained,
    failures: s.failures,
    note: s.note ?? null,
  }));
}

/**
 * Which environments an erasure belongs in the admin log of.
 *
 * One row per environment the subject appeared in, because an operator reading
 * environment X's admin log has to see that data was destroyed in environment X;
 * a single row filed elsewhere is invisible exactly where it is looked for.
 *
 * The fallback matters more than it looks. AdminAudit requires a non-null
 * environmentId, and the entries with no subject scopes are precisely the ones
 * worth keeping — an erasure that resolved nobody, or a refusal that never got
 * as far as discovery. Filing those against the acting credential's own
 * environment is a true statement about where the action was taken.
 */
export function auditEnvironments(
  scopes: Array<Pick<SubjectScope, "environmentId">>,
  fallbackEnvironmentId: string | null | undefined,
): string[] {
  const ids = new Set<string>();
  for (const scope of scopes) if (scope?.environmentId) ids.add(scope.environmentId);
  if (ids.size === 0 && fallbackEnvironmentId) ids.add(fallbackEnvironmentId);
  return [...ids].sort();
}

/** The intent record: who asked, for what, before anything was destroyed. */
export function requestedAudit(args: {
  operationId: string;
  subjectKeyHash: string;
  policyVersion: string;
  trigger: ErasureTrigger;
  coverage: ResumeCoverage;
  actor: ErasureAuditActor;
  /** Content-free counts from the inventory, when one was taken. */
  inventory?: Record<string, unknown>;
  /** Stores this pass intends to run. A retry names only the unsettled ones. */
  stores: string[];
  attempts: number;
}): ErasureAuditEntry {
  return {
    action: "privacy.erasure.requested",
    subjectType: ERASURE_AUDIT_SUBJECT_TYPE,
    subjectId: args.subjectKeyHash,
    source: "api",
    reason: `${args.trigger} (attempt ${args.attempts + 1})`,
    payload: {
      operationId: args.operationId,
      policyVersion: args.policyVersion,
      trigger: args.trigger,
      coverage: args.coverage,
      targetStores: args.stores,
      attempt: args.attempts + 1,
      actor: { credentialId: args.actor.credentialId, userId: args.actor.userId },
      inventory: contentFreeInventory(args.inventory),
      retention: retentionSummary(),
    },
  };
}

/** The outcome record: what each store did, and what was kept on purpose. */
export function finishedAudit(args: {
  receipt: ErasureReceipt;
  trigger: ErasureTrigger;
  coverage: ResumeCoverage;
  actor: ErasureAuditActor;
  /** Null when the queue will not re-drive it; see scheduleAfterAttempt. */
  nextAttemptAt: Date | null;
}): ErasureAuditEntry {
  const stores = args.receipt.stores;
  return {
    action: "privacy.erasure.finished",
    subjectType: ERASURE_AUDIT_SUBJECT_TYPE,
    subjectId: args.receipt.subjectKeyHash,
    source: "api",
    reason: `${args.trigger}: ${args.receipt.status}`,
    payload: {
      operationId: args.receipt.operationId,
      policyVersion: args.receipt.policyVersion,
      status: args.receipt.status,
      trigger: args.trigger,
      coverage: args.coverage,
      attempt: args.receipt.attempts,
      requestedAt: args.receipt.requestedAt,
      startedAt: args.receipt.startedAt ?? null,
      completedAt: args.receipt.completedAt ?? null,
      nextAttemptAt: args.nextAttemptAt?.toISOString() ?? null,
      legalHoldPolicyId: args.receipt.legalHoldPolicyId ?? null,
      actor: { credentialId: args.actor.credentialId, userId: args.actor.userId },
      stores: storeAuditSummary(stores),
      retention: retentionSummary({
        anonymized: stores.reduce((sum, s) => sum + s.anonymized, 0),
        retained: stores.reduce((sum, s) => sum + s.retained, 0),
      }),
    },
  };
}

/** The refusal record: an attempt that was denied, and what denied it. */
export function refusedAudit(args: {
  subjectKeyHash: string;
  reason: string;
  actor: ErasureAuditActor;
  operationId?: string;
  policyVersion?: string;
  legalHoldPolicyId?: string | null;
}): ErasureAuditEntry {
  return {
    action: "privacy.erasure.refused",
    subjectType: ERASURE_AUDIT_SUBJECT_TYPE,
    subjectId: args.subjectKeyHash,
    source: "api",
    reason: args.reason,
    payload: {
      operationId: args.operationId ?? null,
      policyVersion: args.policyVersion ?? null,
      refusal: args.reason,
      legalHoldPolicyId: args.legalHoldPolicyId ?? null,
      actor: { credentialId: args.actor.credentialId, userId: args.actor.userId },
      retention: retentionSummary(),
    },
  };
}

/** The read record: someone enumerated this subject's footprint. */
export function inventoriedAudit(args: {
  subjectKeyHash: string;
  policyVersion: string;
  actor: ErasureAuditActor;
  inventory?: Record<string, unknown>;
  resolvedEndUsers: number;
}): ErasureAuditEntry {
  return {
    action: "privacy.erasure.inventoried",
    subjectType: ERASURE_AUDIT_SUBJECT_TYPE,
    subjectId: args.subjectKeyHash,
    source: "api",
    reason: "subject inventory read",
    payload: {
      policyVersion: args.policyVersion,
      resolvedEndUsers: args.resolvedEndUsers,
      inventory: contentFreeInventory(args.inventory),
      actor: { credentialId: args.actor.credentialId, userId: args.actor.userId },
      retention: retentionSummary(),
    },
  };
}

/**
 * The inventory reduced to its counts.
 *
 * The inventory object carries a `scopes` array of (org, project, environment)
 * tuples. Those are already on the audit row's own environment, and repeating
 * them inside the payload widens the shape for no benefit — so only the numeric
 * fields survive into the audit.
 */
function contentFreeInventory(inventory?: Record<string, unknown>): Record<string, number> {
  const out: Record<string, number> = {};
  for (const [key, value] of Object.entries(inventory ?? {})) {
    if (typeof value === "number" && Number.isFinite(value)) out[key] = value;
  }
  return out;
}

/** The retention rules in force, restated on every record. */
function retentionSummary(kept: { anonymized?: number; retained?: number } = {}) {
  return {
    class: RETENTION_CLASSES.evidence,
    retainedIndefinitely: true,
    barrierClass: RETENTION_CLASSES.barrier,
    /** Rows kept but stripped of identity — the proof the erasure happened. */
    anonymizedRecords: kept.anonymized ?? 0,
    /** Aggregates with no user dimension, kept because nothing personal is in them. */
    retainedAggregates: kept.retained ?? 0,
  };
}

/**
 * Reject anything that would put personal data into the audit trail.
 *
 * Scans the entry whole — reason, subjectId, every payload field — rather than
 * a chosen subset. The receipt's guard can afford to check only the notes
 * because a receipt is assembled in one place; an audit payload is assembled
 * from an inventory, a set of store outcomes and an actor, and the leak would
 * arrive through whichever of those a later change touches.
 */
export function assertAuditContentFree(entry: ErasureAuditEntry, forbidden: string[]): void {
  const blob = JSON.stringify(entry);
  for (const needle of forbidden) {
    if (!needle) continue;
    if (blob.includes(needle)) {
      throw new Error(
        `erasure audit ${entry.action} would leak a subject identifier; refusing to record`,
      );
    }
  }
}
