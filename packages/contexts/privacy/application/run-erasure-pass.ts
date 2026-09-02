// One destructive pass — the part that carries legal weight.
//
// THREE PHASES, AND THE SPLIT IS THE DESIGN
//
//   0. PLAN, outside any transaction. `ErasureTarget.plan` must not mutate, so
//      this is free, and it is what a legal hold is adjudicated against.
//   1. DESTROY, in ONE transaction spanning every target. ADR M0.3 §3 puts the
//      kernel `ErasureTarget.erase` inside the caller's transaction so a
//      multi-context erasure is atomic or is not done at all.
//   2. RECORD, in a SECOND transaction. The receipt is evidence, not
//      destruction, and it must survive a rolled-back sweep — an operation that
//      crashes leaving no record is indistinguishable from one never requested.
//
// EVERY TARGET IS RUN, EVEN AFTER ONE REJECTS. A crash in one target that
// stopped the rest from running would leave far more personal data in place than
// it protected. What a rejection changes is the COMMIT, not the run: the
// loop finishes, then the transaction is rolled back as a whole.
//
// This is a deliberate departure from a per-store-independent sweep, and it is
// the ADR's call rather than this module's. Under the kernel port a target
// cannot commit alone, and a sibling target already relies on it —
// `packages/contexts/files` destroys blobs before rows precisely so that a
// rollback leaves dangling pointers a retry finishes, rather than orphaned bytes
// no sweep can find. Independence would have to be bought back by giving each
// target its own transaction, which would break that ordering guarantee.
//
// A ROLLED-BACK PASS CERTIFIES NOTHING. The post-delete probe runs inside the
// transaction, so a `passed` verification observed a state that is about to stop
// existing. `demoteForRollback` refuses it. Without that, a pass where target A
// verified clean and target B rejected would record A as settled while A's rows
// were quietly restored — an erasure certifying data it did not destroy, which
// is the exact failure the whole verification apparatus exists to prevent.

import type { ErasurePlan, ErasureSubject, ErasureTarget, TransactionScope } from "@platos/kernel";

import {
  combineOutcomes,
  demoteForRollback,
  rejectedTarget,
  settleTarget,
  unwiredTarget,
  type TargetOutcome,
} from "../domain/index.js";
import type { PrivacyDependencies } from "./dependencies.js";
import { planErasure, rejectionCode, type PlannedTarget } from "./plan-erasure.js";

/**
 * Carries a rolled-back pass's outcomes out of the transaction that discarded
 * them.
 *
 * `UnitOfWork.run` rolls back when the work rejects, so the only way to both
 * roll back AND keep what was learned is to throw a carrier. The same shape a
 * sibling context uses to get a typed failure out through a port with no failure
 * channel.
 */
export class ErasurePassRolledBack extends Error {
  readonly outcomes: readonly TargetOutcome[];

  constructor(outcomes: readonly TargetOutcome[]) {
    super("erasure pass rolled back; at least one target refused its plan");
    this.name = "ErasurePassRolledBack";
    this.outcomes = outcomes;
  }
}

export interface ErasurePassResult {
  readonly outcomes: readonly TargetOutcome[];
  /** True when the destructive transaction was discarded. Nothing was erased. */
  readonly rolledBack: boolean;
}

async function eraseOneSubject(
  target: ErasureTarget,
  plan: ErasurePlan,
  subject: ErasureSubject,
  transaction: TransactionScope,
): Promise<TargetOutcome> {
  const receipt = await target.erase(plan, transaction);
  // The probe. A re-plan of the SAME subject, inside the same transaction, so it
  // sees the deletes. A receipt's own counts cannot prove absence: a target that
  // deleted nothing and reported nothing would satisfy them exactly.
  let reprobe: ErasurePlan | null = null;
  try {
    reprobe = await target.plan(subject);
  } catch {
    reprobe = null;
  }
  return settleTarget({ plan, receipt, reprobe });
}

async function eraseOneTarget(
  entry: PlannedTarget,
  subjects: readonly ErasureSubject[],
  transaction: TransactionScope,
): Promise<{ readonly outcome: TargetOutcome; readonly rejected: boolean }> {
  if (entry.target === null) return { outcome: unwiredTarget(entry.name), rejected: false };
  if (entry.failure !== null) {
    return { outcome: rejectedTarget(entry.name, entry.failure), rejected: true };
  }

  const parts: TargetOutcome[] = [];
  for (const [index, plan] of entry.plans.entries()) {
    const subject = subjects[index];
    if (subject === undefined) continue;
    try {
      parts.push(await eraseOneSubject(entry.target, plan, subject, transaction));
    } catch (error) {
      return { outcome: rejectedTarget(entry.name, rejectionCode(error)), rejected: true };
    }
  }
  return { outcome: combineOutcomes(entry.name, parts), rejected: false };
}

async function destroy(
  planned: readonly PlannedTarget[],
  subjects: readonly ErasureSubject[],
  transaction: TransactionScope,
): Promise<readonly TargetOutcome[]> {
  const outcomes: TargetOutcome[] = [];
  let rejected = false;
  for (const entry of planned) {
    const result = await eraseOneTarget(entry, subjects, transaction);
    outcomes.push(result.outcome);
    if (result.rejected) rejected = true;
  }
  // The loop finished first, on purpose: every target is run before any
  // decision about the commit is taken.
  if (rejected) throw new ErasurePassRolledBack(outcomes.map(demoteForRollback));
  return outcomes;
}

/**
 * Run one pass over `only` (or the whole roster) for every resolved subject.
 *
 * Never throws for target-level problems: a pass that crashes leaves no record,
 * and a missing record is indistinguishable from an erasure that was never
 * requested. `ErasurePassRolledBack` is caught here and turned into a value.
 */
export async function runErasurePass(
  dependencies: PrivacyDependencies,
  args: {
    readonly subjects: readonly ErasureSubject[];
    readonly only?: readonly string[];
  },
): Promise<ErasurePassResult> {
  const planned = await planErasure(dependencies, args.subjects, args.only);
  try {
    const outcomes = await dependencies.unitOfWork.run((transaction) =>
      destroy(planned, args.subjects, transaction),
    );
    return { outcomes, rolledBack: false };
  } catch (error) {
    if (error instanceof ErasurePassRolledBack) {
      return { outcomes: error.outcomes, rolledBack: true };
    }
    // A unit of work that failed for its own reasons — the transaction could not
    // be opened, the commit was refused. Nothing was destroyed and nothing was
    // proved, so every target this pass touched is unknown rather than clean.
    const code = rejectionCode(error);
    return {
      outcomes: planned.map((entry) => rejectedTarget(entry.name, code)),
      rolledBack: true,
    };
  }
}
