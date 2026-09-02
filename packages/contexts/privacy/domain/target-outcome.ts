// One erasure target's result, and the rules that stop it overstating.
//
// ADR M0.3 §3 hosts `ErasureTarget` in the kernel: each context implements it
// for the rows it is sole writer of, and the composition root injects the array.
// This module is the other half of that seam — how `privacy` records what a
// target reported, and what it refuses to conclude from it.
//
// THREE RULES, EACH FROM A WAY THIS GOES WRONG
//
// 1. UNKNOWN IS NOT SUCCESS. A target whose post-erase probe did not run, or
//    could not run, is `unknown`, and `unknown` blocks completion. Reporting
//    "completed" while nobody has checked is how a system signs a legal
//    statement it cannot support.
//
// 2. NOT PROVISIONED IS NOT VERIFIED. A target whose plan names no model at all
//    is structurally incapable of holding this subject's data, so it settles —
//    but it is reported distinctly, never as a pass, because the day it gains a
//    model a guarantee that was never exercised would silently become false.
//
// 3. A LATER PASS MAY NOT SOFTEN AN EARLIER FAILURE. `failed` verification is
//    positive evidence that data survived a delete. A retry that comes back
//    `unknown` has not refuted it; it has failed to gather any evidence.
//
// VERIFICATION IS A RE-PLAN, NOT A COUNT. `ErasureTarget.plan` is required not
// to mutate, so asking a target to plan the SAME subject again after erasing it
// is a genuine post-delete probe: every item must come back at zero rows. A
// receipt's own counts cannot prove this — a target that deleted nothing and
// reported nothing would satisfy them exactly.

import type { ErasureMethod, ErasurePlan, ErasureReceipt } from "@platos/kernel";

export type TargetStatus =
  | "pending"
  | "running"
  | "done"
  | "failed"
  /** The target owns no model that could hold this subject. */
  | "not_provisioned";

export type VerificationStatus =
  | "not_run"
  | "pending"
  | "passed"
  | "failed"
  | "unknown"
  | "not_applicable";

/**
 * What an erasure did to the rows it reached, split by the kernel's method.
 *
 * Kept per-method rather than as one total because the methods make materially
 * different claims: `delete` removes the row, `anonymize` keeps it and strips
 * identity, `crypto-shred` keeps the ciphertext and destroys the key. An
 * operator asked "what survived" needs the split, and collapsing it would let a
 * fully-anonymised outcome read as a fully-deleted one.
 */
export interface TargetCounts {
  readonly deleted: number;
  readonly anonymized: number;
  readonly cryptoShredded: number;
  /** Items a hold or a retention rule kept. Reported, never silently dropped. */
  readonly retained: number;
}

export const ZERO_COUNTS: TargetCounts = Object.freeze({
  deleted: 0,
  anonymized: 0,
  cryptoShredded: 0,
  retained: 0,
});

export interface TargetOutcome {
  /** The owning context's name, exactly as the target reports it. */
  readonly target: string;
  readonly status: TargetStatus;
  readonly verification: VerificationStatus;
  /** Rows the plan said it held, before anything ran. */
  readonly discovered: number;
  readonly counts: TargetCounts;
  readonly failures: number;
  /** Content-free operational detail: an error CLASS, a demotion reason. */
  readonly note: string | null;
}

/** An outcome for a target that has not been processed yet. */
export function pendingTarget(target: string): TargetOutcome {
  return {
    target,
    status: "pending",
    verification: "not_run",
    discovered: 0,
    counts: ZERO_COUNTS,
    failures: 0,
    note: null,
  };
}

/**
 * A target that threw rather than returning a receipt.
 *
 * Recorded as `failed` with verification `unknown` — NOT `failed` verification.
 * The distinction matters: a thrown target proves nothing either way, whereas a
 * failed verification is positive evidence that data survived. Collapsing the
 * two would let a transient error read as "we deleted and it is still there",
 * which is a materially different claim.
 *
 * The note carries the error CODE, never its message: messages routinely embed
 * the identifiers being erased.
 */
export function rejectedTarget(target: string, code: string): TargetOutcome {
  return { ...pendingTarget(target), status: "failed", failures: 1, verification: "unknown", note: `target rejected (${code})` };
}

/** A target the composition root did not inject. Not the same as nothing to erase. */
export function unwiredTarget(target: string): TargetOutcome {
  return {
    ...pendingTarget(target),
    status: "failed",
    failures: 1,
    verification: "unknown",
    note: "no target wired for this context",
  };
}

/** Total rows a plan says it holds. */
export function plannedRowCount(plan: ErasurePlan): number {
  return plan.items.reduce((total, item) => total + item.rowCount, 0);
}

/** Items a hold or retention rule blocked. */
export function blockedRowCount(plan: ErasurePlan): number {
  return plan.items.reduce((total, item) => (item.blockedBy === null ? total : total + item.rowCount), 0);
}

function countsFor(items: ErasureReceipt["items"]): TargetCounts {
  const totals: Record<ErasureMethod, number> = { delete: 0, anonymize: 0, "crypto-shred": 0 };
  let retained = 0;
  for (const item of items) {
    if (item.blockedBy !== null) {
      retained += item.rowCount;
      continue;
    }
    totals[item.method] += item.rowCount;
  }
  return {
    deleted: totals.delete,
    anonymized: totals.anonymize,
    cryptoShredded: totals["crypto-shred"],
    retained,
  };
}

/**
 * Combine a plan, a receipt and the post-erase re-plan into one outcome.
 *
 * `reprobe` is `null` when the probe could not be taken — that is `unknown`, and
 * `unknown` keeps the operation open. An empty PLAN is `not_provisioned`: rule 2
 * above. A non-empty re-probe with surviving rows is `failed`: positive evidence.
 */
export function settleTarget(args: {
  readonly plan: ErasurePlan;
  readonly receipt: ErasureReceipt;
  readonly reprobe: ErasurePlan | null;
  readonly note?: string | null;
}): TargetOutcome {
  const target = args.plan.targetName;
  const discovered = plannedRowCount(args.plan);
  const counts = countsFor(args.receipt.items);
  const base = {
    target,
    discovered,
    counts,
    failures: 0,
    note: args.note ?? null,
  };
  if (args.plan.items.length === 0) {
    return { ...base, status: "not_provisioned", verification: "not_applicable" };
  }
  if (args.reprobe === null) {
    return { ...base, status: "done", verification: "unknown" };
  }
  const survivors = plannedRowCount(args.reprobe) - blockedRowCount(args.reprobe);
  if (survivors > 0) {
    return {
      ...base,
      status: "done",
      verification: "failed",
      note: appendNote(base.note, `${survivors} row(s) survived the erasure`),
    };
  }
  return { ...base, status: "done", verification: "passed" };
}

/**
 * A target counts as settled when it has finished AND proved it.
 *
 * `not_provisioned` settles deliberately: a target with no model cannot hold
 * subject data, so it must not block an otherwise complete operation. It is
 * still reported distinctly so nobody reads it as verified.
 */
export function isTargetSettled(outcome: TargetOutcome): boolean {
  if (outcome.status === "not_provisioned") return true;
  return outcome.status === "done" && outcome.verification === "passed";
}

/** A target that finished its work but could not prove it. */
export function isUnproven(outcome: TargetOutcome): boolean {
  return (
    outcome.status === "done" &&
    (outcome.verification === "unknown" ||
      outcome.verification === "pending" ||
      outcome.verification === "not_run")
  );
}

/**
 * A retry may not soften an earlier verification failure.
 *
 * A genuine `passed` DOES clear it: that is a fresh, positive probe proving
 * absence, which is exactly what a retry is for. A `failed` replaces it with
 * itself. Anything weaker is refused, and the reason is recorded.
 */
export function preserveVerificationFailure(
  previous: TargetOutcome | undefined,
  next: TargetOutcome,
): TargetOutcome {
  if (previous?.verification !== "failed") return next;
  if (next.verification === "failed" || next.verification === "passed") return next;
  return {
    ...next,
    verification: "failed",
    note: appendNote(next.note, "earlier verification failure not refuted by this pass"),
  };
}

/**
 * A pass whose transaction rolled back may not certify anything.
 *
 * The post-delete probe ran INSIDE the transaction, so a `passed` verification
 * observed a state that no longer exists — the rows are back. Demoting to
 * `unknown` keeps the operation open, which is exactly right: the destruction
 * did not happen and the retry must redo it.
 *
 * Only `passed` is touched. A `failed` verification is still true after a
 * rollback — restoring rows can only make more of them survive, never fewer —
 * and demoting it would discard the more serious finding. `not_applicable` on an
 * empty plan is unaffected, because a target with no model has nothing to roll
 * back.
 */
export function demoteForRollback(outcome: TargetOutcome): TargetOutcome {
  if (outcome.verification !== "passed") return outcome;
  return {
    ...outcome,
    verification: "unknown",
    note: appendNote(outcome.note, "pass rolled back; verification observed uncommitted state"),
  };
}

/**
 * Fold one target's per-subject results into the single outcome the record
 * carries.
 *
 * A person spans several scopes, so a target is asked once per subject. The fold
 * takes the WORST answer on both axes, because a target that settled three
 * scopes and failed a fourth has not settled: the surviving scope is exactly the
 * one an operator needs to see.
 *
 * An empty `parts` is `not_provisioned` — the roster named a target that
 * reported about nobody, which is the same fact as a plan with no models.
 */
export function combineOutcomes(target: string, parts: readonly TargetOutcome[]): TargetOutcome {
  if (parts.length === 0) {
    return { ...pendingTarget(target), status: "not_provisioned", verification: "not_applicable" };
  }
  const counts = parts.reduce<TargetCounts>(
    (total, part) => ({
      deleted: total.deleted + part.counts.deleted,
      anonymized: total.anonymized + part.counts.anonymized,
      cryptoShredded: total.cryptoShredded + part.counts.cryptoShredded,
      retained: total.retained + part.counts.retained,
    }),
    ZERO_COUNTS,
  );
  const notes = parts.map((part) => part.note).filter((note): note is string => note !== null);
  return {
    target,
    status: worstStatus(parts.map((part) => part.status)),
    verification: worstVerification(parts.map((part) => part.verification)),
    discovered: parts.reduce((total, part) => total + part.discovered, 0),
    counts,
    failures: parts.reduce((total, part) => total + part.failures, 0),
    note: notes.length === 0 ? null : notes.join("; "),
  };
}

/** `failed` beats `pending`/`running` beats `done` beats `not_provisioned`. */
function worstStatus(statuses: readonly TargetStatus[]): TargetStatus {
  if (statuses.includes("failed")) return "failed";
  if (statuses.includes("pending")) return "pending";
  if (statuses.includes("running")) return "running";
  if (statuses.includes("done")) return "done";
  return "not_provisioned";
}

/**
 * `failed` beats every flavour of "we do not know" beats `passed` beats
 * `not_applicable`.
 *
 * `passed` is only reachable when EVERY part passed, which is the whole point: a
 * target that proved three scopes clean and could not probe the fourth has not
 * proved the subject gone.
 */
function worstVerification(statuses: readonly VerificationStatus[]): VerificationStatus {
  if (statuses.includes("failed")) return "failed";
  if (statuses.includes("unknown")) return "unknown";
  if (statuses.includes("pending")) return "pending";
  if (statuses.includes("not_run")) return "not_run";
  if (statuses.includes("passed")) return "passed";
  return "not_applicable";
}

/** Join a note fragment onto an existing note without losing either. */
export function appendNote(existing: string | null, addition: string): string {
  return existing === null || existing === "" ? addition : `${existing}; ${addition}`;
}
