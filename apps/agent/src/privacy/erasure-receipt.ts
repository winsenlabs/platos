/**
 * Erasure receipt — the durable, idempotent record of what was destroyed.
 *
 * The receipt is the product. Deletion counts are not evidence: a route that
 * reports "deleted 14 rows" has proved only that it issued a statement, not
 * that the person is gone. What makes an erasure defensible is the combination
 * of a stable operation id, per-store outcomes, and post-delete verification —
 * so this module owns the state machine and refuses to let an operation reach a
 * reassuring status without the evidence to justify it.
 *
 * THREE RULES, EACH FROM A WAY THIS GOES WRONG
 *
 * 1. UNKNOWN IS NOT SUCCESS. An in-flight ClickHouse mutation or an object
 *    delete with no confirmation is `unknown`, and `unknown` blocks completion.
 *    Reporting "completed" while a mutation is still running is how a system
 *    signs a legal statement it cannot support.
 *
 * 2. NEVER ROLL BACK A SUCCESSFUL DELETE. If Postgres purges and MinIO fails,
 *    the Postgres data stays gone. Restoring it to reach a tidy all-or-nothing
 *    state would recreate personal data the subject asked to be destroyed, to
 *    make a status field look neater. Partial failure is an honest state.
 *
 * 3. NOT-PROVISIONED IS NOT VERIFIED. A store that does not exist in this
 *    deployment cannot prove anything. Measured here: ClickHouse currently has
 *    zero user tables, so a verification query trivially returns nothing. That
 *    must surface as `not_provisioned`, never as a pass — otherwise the day the
 *    store is provisioned, a guarantee that was never exercised silently
 *    becomes false.
 *
 * Pure and dependency-free so the state machine is testable without any store.
 */

export type ErasureStatus =
  | "pending"
  | "running"
  | "blocked_legal_hold"
  | "partial_failure"
  | "completed"
  | "verification_failed";

export type StoreName = "postgres" | "redis" | "clickhouse" | "minio";

export type StoreStatus =
  | "pending"
  | "running"
  | "done"
  | "failed"
  | "not_provisioned";

export type VerificationStatus =
  | "not_run"
  | "pending"
  | "passed"
  | "failed"
  | "unknown"
  | "not_applicable";

export interface StoreOutcome {
  store: StoreName;
  status: StoreStatus;
  discovered: number;
  deleted: number;
  anonymized: number;
  retained: number;
  failures: number;
  verificationStatus: VerificationStatus;
  /** Content-free operational detail: mutation ids, retained-key policy, error class. */
  note?: string;
}

export interface ErasureReceipt {
  operationId: string;
  subjectKeyHash: string;
  requestedAt: string;
  startedAt?: string;
  completedAt?: string;
  status: ErasureStatus;
  scopes: Array<{ organizationId: string; projectId: string; environmentId: string }>;
  stores: StoreOutcome[];
  policyVersion: string;
  attempts: number;
  /** Set only when status is blocked_legal_hold. Identifier, never content. */
  legalHoldPolicyId?: string;
}

/** Stores that must pass before an operation may claim completion. */
export const REQUIRED_STORES: StoreName[] = ["postgres", "redis", "clickhouse", "minio"];

/**
 * A store counts as settled when it has finished AND proved it.
 *
 * `not_provisioned` settles deliberately: a store absent from the deployment
 * cannot hold subject data, so it must not block an otherwise complete
 * operation. It is still reported distinctly so nobody reads it as verified.
 */
export function isStoreSettled(o: StoreOutcome): boolean {
  if (o.status === "not_provisioned") return true;
  return o.status === "done" && o.verificationStatus === "passed";
}

/** A store that finished its work but could not prove it. */
export function isUnproven(o: StoreOutcome): boolean {
  return (
    o.status === "done" &&
    (o.verificationStatus === "unknown" ||
      o.verificationStatus === "pending" ||
      o.verificationStatus === "not_run")
  );
}

/**
 * Derive the operation status from store outcomes. Single place, so a receipt
 * cannot disagree with the evidence attached to it.
 *
 * Order matters: legal hold outranks everything (we never started), an explicit
 * verification failure outranks a plain failure (we deleted and it is still
 * there, which is worse than not having deleted), and anything unproven keeps
 * the operation open.
 */
export function deriveStatus(
  stores: StoreOutcome[],
  opts: { legalHold?: boolean; started?: boolean } = {},
): ErasureStatus {
  if (opts.legalHold) return "blocked_legal_hold";
  if (!opts.started) return "pending";

  const required = stores.filter((s) => REQUIRED_STORES.includes(s.store));
  if (required.length < REQUIRED_STORES.length) return "running";

  if (required.some((s) => s.verificationStatus === "failed")) return "verification_failed";
  if (required.some((s) => s.status === "failed" || s.failures > 0)) return "partial_failure";
  // Unproven is not failure and is not success. Keep it open rather than
  // rounding an unknown up to completed.
  if (required.some(isUnproven)) return "partial_failure";
  if (required.some((s) => s.status === "pending" || s.status === "running")) return "running";
  if (required.every(isStoreSettled)) return "completed";
  return "running";
}

/** Whether a retry is permitted, and why not when it is not. */
export function canRetry(r: ErasureReceipt): { allowed: boolean; reason?: string } {
  if (r.status === "blocked_legal_hold") {
    return { allowed: false, reason: "legal hold in force; retry blocked until released" };
  }
  if (r.status === "completed") {
    return { allowed: false, reason: "already completed; retry would be a no-op" };
  }
  return { allowed: true };
}

/**
 * Which stores a retry should re-run.
 *
 * Only the ones that did not settle. Re-running a settled store would re-issue
 * deletes against data already gone — harmless but it muddies the receipt, and
 * a retry that reports fresh "deleted" counts for a store finished an hour ago
 * misleads whoever reads it.
 */
export function storesNeedingRetry(r: ErasureReceipt): StoreName[] {
  const byName = new Map(r.stores.map((s) => [s.store, s]));
  return REQUIRED_STORES.filter((name) => {
    const o = byName.get(name);
    return !o || !isStoreSettled(o);
  });
}

/** An outcome for a store that has not been attempted yet. */
export function pendingStore(store: StoreName): StoreOutcome {
  return {
    store,
    status: "pending",
    discovered: 0,
    deleted: 0,
    anonymized: 0,
    retained: 0,
    failures: 0,
    verificationStatus: "not_run",
  };
}

/**
 * Reject anything that would put personal data into the receipt.
 *
 * The receipt is retained as the audit trail of a deletion, so leaking the
 * subject's identifiers into it defeats the operation it documents. Checked
 * rather than trusted, because the tempting thing when debugging is to drop the
 * raw id into a note field.
 */
export function assertContentFree(r: ErasureReceipt, forbidden: string[]): void {
  const blob = JSON.stringify({
    stores: r.stores.map((s) => s.note ?? ""),
    hash: r.subjectKeyHash,
    hold: r.legalHoldPolicyId ?? "",
  });
  for (const needle of forbidden) {
    if (!needle) continue;
    if (blob.includes(needle)) {
      throw new Error(
        `erasure receipt ${r.operationId} would leak a subject identifier; refusing to persist`,
      );
    }
  }
}
