// The `ErasureOperation` aggregate — the durable, idempotent record of what was
// destroyed, and the state machine that keeps it honest.
//
// The receipt is the product. Deletion counts are not evidence: a route that
// reports "deleted 14 rows" has proved only that it issued a statement, not that
// the person is gone. What makes an erasure defensible is a stable operation id,
// per-target outcomes, and post-delete verification — so this module owns the
// state machine and refuses to let an operation reach a reassuring status
// without the evidence to justify it.
//
// NEVER ROLL BACK A SUCCESSFUL DESTRUCTION. If one target settles and another
// fails, what went stays gone. Restoring it to reach a tidy all-or-nothing state
// would recreate personal data the subject asked to be destroyed, in order to
// make a status field look neater. Partial failure is an honest state.
//
// TWO STATUS VOCABULARIES, ONE MAPPING
//
// `ErasureStatus` is the six-value operational vocabulary a receipt speaks.
// `WorkStatus` is the five-value enum the `ErasureOperation` row is typed with,
// shared with every other unit of durable work in the schema. They are NOT the
// same alphabet and the projection between them LOSES information on purpose:
// `partial_failure` and `verification_failed` both persist as `FAILED`, and
// `blocked_legal_hold` persists as `CANCELLED`. `receiptStatusFor` reconstructs
// the finer status from the row's own evidence — the outcomes it carries and
// whether a hold reference is set — rather than from the column alone. Reading
// the column and stopping there is how a verification failure comes back as a
// plain partial failure.
//
// NOTE ON THE KERNEL'S `ErasureReceipt`. That type is ONE TARGET's receipt: what
// a single context destroyed. The whole-operation record is
// `ErasureOperationRecord` below. The names are close because the concepts are
// adjacent; they are not interchangeable, and nothing here widens the kernel's.

import type { OrganizationId, TenantScope } from "@platos/kernel";

import type { ErasureOperationId, IdempotencyKey, LeaseToken, SubjectKeyHash } from "./identifiers.js";
import { isTargetSettled, isUnproven, type TargetOutcome } from "./target-outcome.js";

/** The operational vocabulary. Stable within a major; renaming one is breaking. */
export type ErasureStatus =
  | "pending"
  | "running"
  | "blocked_legal_hold"
  | "partial_failure"
  | "completed"
  | "verification_failed";

/** The `WorkStatus` enum the row is typed with, shared across the schema. */
export type WorkStatus = "PENDING" | "ACTIVE" | "SUCCEEDED" | "FAILED" | "CANCELLED";

/** The columns an operation carries that no pass ever rewrites. */
export interface ErasureOperationIdentity {
  readonly operationId: ErasureOperationId;
  readonly organizationId: OrganizationId;
  readonly idempotencyKey: IdempotencyKey;
  /** The salted digest. The subject's own identifier is never on this row. */
  readonly subjectKeyHash: SubjectKeyHash;
  /** Every scope the subject was found in. Ids only, no handles. */
  readonly scopes: readonly TenantScope[];
  readonly policyVersion: string;
  readonly requestedAt: Date;
}

/** The columns one destructive pass advances. */
export interface ErasureOperationProgress {
  readonly outcomes: readonly TargetOutcome[];
  /** A register POSITION plus a truncated digest. Never a register entry. */
  readonly legalHoldPolicyId: string | null;
  readonly retryCount: number;
  readonly startedAt: Date | null;
  readonly completedAt: Date | null;
  /** When the queue should next re-drive; null once settled, blocked or exhausted. */
  readonly nextRetryAt: Date | null;
  readonly leaseToken: LeaseToken | null;
  readonly leaseExpiresAt: Date | null;
}

/**
 * The row exactly as it is stored, carrying the `WorkStatus` COLUMN.
 *
 * This is what a repository reads and writes. It is deliberately not the same
 * type as `ErasureOperationRecord`: the column cannot express the six-value
 * status, so an adapter that returned one would have to derive it, which would
 * put this module's rule inside an adapter.
 */
export interface PersistedErasureOperation extends ErasureOperationIdentity, ErasureOperationProgress {
  readonly workStatus: WorkStatus;
}

/** The operation as every reader outside the repository sees it. */
export interface ErasureOperationRecord extends ErasureOperationIdentity, ErasureOperationProgress {
  readonly status: ErasureStatus;
}

/**
 * Derive the operation status from target outcomes. Single place, so a record
 * cannot disagree with the evidence attached to it.
 *
 * ORDER MATTERS. A legal hold outranks everything (nothing started). An explicit
 * verification failure outranks a plain failure (we deleted and it is still
 * there, which is worse than not having deleted). Anything unproven keeps the
 * operation open rather than rounding an unknown up to completed. And a roster
 * that has not reported in full is still running, not complete — a required
 * target that never answered must not be invisible.
 */
export function deriveStatus(
  outcomes: readonly TargetOutcome[],
  options: {
    readonly legalHold?: boolean;
    readonly started?: boolean;
    readonly requiredTargets?: readonly string[];
  } = {},
): ErasureStatus {
  if (options.legalHold === true) return "blocked_legal_hold";
  if (options.started !== true) return "pending";

  const reported = new Set(outcomes.map((outcome) => outcome.target));
  for (const required of options.requiredTargets ?? []) {
    if (!reported.has(required)) return "running";
  }
  if (outcomes.length === 0) return "running";

  if (outcomes.some((outcome) => outcome.verification === "failed")) return "verification_failed";
  if (outcomes.some((outcome) => outcome.status === "failed" || outcome.failures > 0)) return "partial_failure";
  // Unproven is not failure and is not success. Keep it open rather than
  // rounding an unknown up to completed.
  if (outcomes.some(isUnproven)) return "partial_failure";
  if (outcomes.some((outcome) => outcome.status === "pending" || outcome.status === "running")) return "running";
  if (outcomes.every(isTargetSettled)) return "completed";
  return "running";
}

/** The row's `WorkStatus` for an operational status. Lossy by design; see above. */
export function toWorkStatus(status: ErasureStatus): WorkStatus {
  if (status === "pending") return "PENDING";
  if (status === "running") return "ACTIVE";
  if (status === "completed") return "SUCCEEDED";
  if (status === "blocked_legal_hold") return "CANCELLED";
  return "FAILED";
}

/**
 * Reconstruct the operational status of a persisted row.
 *
 * A hold reference outranks the column: a held operation is stored `CANCELLED`,
 * and `CANCELLED` on its own does not say why. `FAILED` is re-derived from the
 * outcomes rather than flattened, which is what recovers `verification_failed`
 * from a column that cannot express it.
 */
export function receiptStatusFor(row: {
  readonly workStatus: WorkStatus;
  readonly legalHoldPolicyId: string | null;
  readonly outcomes: readonly TargetOutcome[];
  readonly requiredTargets?: readonly string[];
}): ErasureStatus {
  if (row.legalHoldPolicyId !== null) return "blocked_legal_hold";
  if (row.workStatus === "SUCCEEDED") return "completed";
  if (row.workStatus === "ACTIVE") return "running";
  if (row.workStatus === "FAILED") {
    // FAILED with NOTHING reported is the unresolved-subject operation: the pass
    // ran, no target was asked about anybody, and so nothing was proved. Falling
    // through to `deriveStatus` would read it as `running`, because from inside
    // one pass "no outcome yet" and "no outcome ever" look the same — but the
    // column has already said this operation is not in flight. This is the one
    // place the lossy projection would otherwise lose a status it can recover.
    if (row.outcomes.length === 0) return "verification_failed";
    return deriveStatus(row.outcomes, { started: true, requiredTargets: row.requiredTargets ?? [] });
  }
  return "pending";
}

/**
 * Project a stored row into the record every reader outside the repository sees.
 *
 * The one place the lossy column becomes the six-value status again. Every read
 * path goes through here, so no caller can accidentally read `workStatus` and
 * report `FAILED` as a plain partial failure.
 */
export function projectOperation(
  row: PersistedErasureOperation,
  requiredTargets: readonly string[] = [],
): ErasureOperationRecord {
  const { workStatus, ...rest } = row;
  return {
    ...rest,
    status: receiptStatusFor({
      workStatus,
      legalHoldPolicyId: row.legalHoldPolicyId,
      outcomes: row.outcomes,
      requiredTargets,
    }),
  };
}

/** Whether a retry is permitted, and why not when it is not. */
export function canRetry(operation: Pick<ErasureOperationRecord, "status">): {
  readonly allowed: boolean;
  readonly reason: string | null;
} {
  if (operation.status === "blocked_legal_hold") {
    return { allowed: false, reason: "legal hold in force; retry blocked until released" };
  }
  if (operation.status === "completed") {
    return { allowed: false, reason: "already completed; retry would be a no-op" };
  }
  return { allowed: true, reason: null };
}

/**
 * Which targets a retry should re-run.
 *
 * Only the ones that did not settle, plus every required target that has not
 * reported at all. Re-running a settled target would re-issue deletes against
 * data already gone — harmless, but the record would then report fresh counts
 * for work that finished hours earlier, which misleads whoever reads it as
 * evidence.
 */
export function targetsNeedingRetry(
  operation: Pick<ErasureOperationRecord, "outcomes">,
  targetNames: readonly string[],
): readonly string[] {
  const byName = new Map(operation.outcomes.map((outcome) => [outcome.target, outcome]));
  return targetNames.filter((name) => {
    const outcome = byName.get(name);
    return outcome === undefined || !isTargetSettled(outcome);
  });
}

/**
 * Fold this pass's outcomes into the record's, preserving the target order the
 * pass ran in and keeping outcomes for targets it did not touch.
 */
export function mergeOutcomes(
  previous: readonly TargetOutcome[],
  next: readonly TargetOutcome[],
): readonly TargetOutcome[] {
  const merged = new Map(previous.map((outcome) => [outcome.target, outcome]));
  for (const outcome of next) merged.set(outcome.target, outcome);
  return [...merged.values()];
}

/**
 * Discovery finding nothing is NOT success.
 *
 * It usually means the subject was resolved by the wrong key, and reporting
 * "completed, 0 destroyed" would certify an erasure that never looked in the
 * right place. `verification_failed` is the honest landing: we deleted nothing
 * and cannot prove the subject is gone.
 */
export function isEmptySubjectStatus(): ErasureStatus {
  return "verification_failed";
}
