// An in-memory `ErasureTarget`, standing in for a context that owns erasable
// rows.
//
// This is the double that makes the whole orchestration exercisable without a
// database: it holds rows keyed by (subject kind, subject id, scope path), plans
// honestly over them, and — crucially — DELETES THEM ON `erase`, so the
// post-delete re-probe is a genuine probe rather than a formality.
//
// The failure switches are the interesting part. Each one reproduces a way a
// real target goes wrong, and each is the only way to reach a branch that
// otherwise only runs in production:
//
//   `planFails`      a target that cannot answer at all.
//   `eraseRejects`   the sibling shape: a typed refusal thrown out through a
//                    port with no failure channel, which rolls the caller's
//                    transaction back.
//   `eraseSilently`  the dangerous one — a target that reports a receipt and
//                    leaves the rows in place. Nothing in the receipt catches
//                    it; only the re-probe does.
//   `reprobeFails`   a target that destroyed but cannot prove it: `unknown`,
//                    which must keep the operation open.

import {
  domainError,
  resolvePath,
  type DomainError,
  type ErasurePlan,
  type ErasureReceipt,
  type ErasureSubject,
  type ErasureTarget,
  type TransactionScope,
} from "@platos/kernel";

/** The typed-refusal shape sibling contexts use. See `eraseRejects`. */
export class TestTargetRejected extends Error {
  readonly domainError: DomainError;

  constructor(code: string) {
    super(`${code}: target refused`);
    this.name = "TestTargetRejected";
    this.domainError = domainError(code, "unavailable", "target refused");
  }
}

export interface TargetRow {
  readonly model: string;
  readonly subjectKind: ErasureSubject["subjectKind"];
  readonly subjectId: string;
  readonly scopePath: string;
}

export class InMemoryErasureTarget implements ErasureTarget {
  private rows: TargetRow[] = [];
  /** Row state as it was when this transaction first touched the target. */
  private readonly snapshots = new Map<string, TargetRow[]>();

  planFails = false;
  eraseRejects = false;
  /**
   * The CODE a rejecting target refuses with.
   *
   * Overridable because a target's failure code is attacker- and
   * accident-reachable content: it is composed by whichever context owns the
   * rows, it lands verbatim in `rejectedTarget`'s note, and the note is copied
   * into the permanently-retained finished event. A code carrying the subject's
   * own handle is the leak `assertContentFree` exists to refuse, and there is no
   * other seam in this package through which a real handle can reach a payload.
   */
  eraseRejectionCode = "TEST_TARGET_ERASE_REFUSED";
  /**
   * Models a hold or retention rule kept, reported as `blockedBy` on the plan.
   *
   * Rows a target RETAINED are the ones an erasure did not destroy, so they are
   * the numbers an operator reading the receipt most needs. Without this the
   * `retained` count is zero on every path and the event field that reports it
   * is unpinned.
   */
  blockedModels: readonly string[] = [];
  /** Reports a receipt without removing anything. Only the re-probe sees it. */
  eraseSilently = false;
  reprobeFails = false;
  /** Every plan/erase call this target saw, so ordering is assertable. */
  readonly calls: string[] = [];

  /**
   * Runs at the top of `erase`, INSIDE the destructive transaction.
   *
   * The one seam from which a mid-sweep write can be observed. "Seal before the
   * targets" is a claim about an instant that exists only while a target is
   * working, and no assertion made before or after the pass can see it: both
   * orderings leave the subject sealed by the time the pass returns.
   */
  duringErase: (() => Promise<void>) | null = null;

  constructor(
    readonly targetName: string,
    /** Models this target owns. An empty list is the `not_provisioned` case. */
    private readonly models: readonly string[] = ["TestRow"],
  ) {}

  seed(row: TargetRow): void {
    this.rows.push(row);
  }

  remaining(): readonly TargetRow[] {
    return [...this.rows];
  }

  private matches(row: TargetRow, subject: ErasureSubject): boolean {
    return (
      row.subjectKind === subject.subjectKind &&
      row.subjectId === subject.subjectId &&
      row.scopePath === resolvePath(subject.scope)
    );
  }

  private countsByModel(subject: ErasureSubject): ReadonlyMap<string, number> {
    const counts = new Map<string, number>(this.models.map((model) => [model, 0]));
    for (const row of this.rows) {
      if (!this.matches(row, subject)) continue;
      counts.set(row.model, (counts.get(row.model) ?? 0) + 1);
    }
    return counts;
  }

  async plan(subject: ErasureSubject): Promise<ErasurePlan> {
    this.calls.push(`plan:${subject.subjectId}`);
    if (this.planFails) throw new TestTargetRejected("TEST_TARGET_PLAN_FAILED");
    // The re-probe IS a `plan` call, so a target that cannot prove its work is
    // one whose plan throws only after an erase has happened.
    if (this.reprobeFails && this.calls.some((call) => call.startsWith("erase:"))) {
      throw new TestTargetRejected("TEST_TARGET_PROBE_FAILED");
    }
    return {
      targetName: this.targetName,
      items: [...this.countsByModel(subject)].map(([model, rowCount]) => ({
        model,
        method: "delete" as const,
        rowCount,
        blockedBy: this.blockedModels.includes(model) ? "TEST_RETENTION_RULE" : null,
      })),
    };
  }

  /**
   * Undo everything this transaction erased.
   *
   * Wired to the unit of work by `buildPrivacyTestContext`. Without it the
   * rolled-back-pass rule would be untestable: the orchestrator would report a
   * discarded transaction while the double's rows stayed deleted, and every
   * assertion about what a rollback restores would pass vacuously.
   */
  rollback(transaction: TransactionScope): void {
    const snapshot = this.snapshots.get(transaction.transactionId);
    if (snapshot === undefined) return;
    this.rows = snapshot;
    this.snapshots.delete(transaction.transactionId);
  }

  async erase(plan: ErasurePlan, transaction: TransactionScope): Promise<ErasureReceipt> {
    this.calls.push(`erase:${plan.targetName}`);
    if (this.duringErase !== null) await this.duringErase();
    if (!this.snapshots.has(transaction.transactionId)) {
      this.snapshots.set(transaction.transactionId, [...this.rows]);
    }
    if (this.eraseRejects) throw new TestTargetRejected(this.eraseRejectionCode);
    // The plan carries no subject, exactly as the kernel type says, so a target
    // that must act on one carries its own rider. This double records the
    // subject on the call log instead and erases everything the plan counted.
    const wanted = new Map(
      plan.items
        .filter((item) => item.blockedBy === null)
        .map((item) => [item.model, item.rowCount]),
    );
    if (!this.eraseSilently) {
      const kept: TargetRow[] = [];
      for (const row of this.rows) {
        const budget = wanted.get(row.model) ?? 0;
        if (budget > 0) {
          wanted.set(row.model, budget - 1);
          continue;
        }
        kept.push(row);
      }
      this.rows = kept;
    }
    return { targetName: plan.targetName, erasedAt: new Date(0), items: plan.items };
  }
}
