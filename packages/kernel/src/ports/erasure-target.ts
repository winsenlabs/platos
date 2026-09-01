// ADR M0.3 §4 kernel port: ErasureTarget.
//
// ADR M0.3 §3 rejects both obvious shapes for right-to-erasure: "privacy defines
// a port everyone implements" is a fan-in cycle, and "privacy imports every
// context" is a ten-way fan-out. The accepted design hosts the port HERE: each
// context implements it for the rows it is sole writer of, the composition root
// injects `ErasureTarget[]` into `privacy`, and `privacy` depends on nothing but
// `tenancy` and this kernel.
//
// Erasure is two-phase on purpose. A plan is inspectable and reviewable before
// anything is destroyed, and it is what a legal hold is evaluated against.

import type { TransactionScope } from "./unit-of-work.js";
import type { TenantScope } from "../vo/scope.js";

/** Whose data is being erased. Kept abstract: not every subject is an operator. */
export interface ErasureSubject {
  readonly subjectKind: "user" | "end-user" | "entity";
  readonly subjectId: string;
  readonly scope: TenantScope;
}

export type ErasureMethod =
  /** The row is deleted outright. */
  | "delete"
  /** Identifying columns are overwritten; the row survives for referential truth. */
  | "anonymize"
  /** The data-encryption key is destroyed, rendering ciphertext unrecoverable. */
  | "crypto-shred";

export interface ErasurePlanItem {
  readonly model: string;
  readonly method: ErasureMethod;
  readonly rowCount: number;
  /** Set when a legal hold or a retention rule blocks this item. */
  readonly blockedBy: string | null;
}

export interface ErasurePlan {
  readonly targetName: string;
  readonly items: readonly ErasurePlanItem[];
}

export interface ErasureReceipt {
  readonly targetName: string;
  readonly erasedAt: Date;
  readonly items: readonly ErasurePlanItem[];
}

export interface ErasureTarget {
  /** The owning context, so a plan names who is destroying what. */
  readonly targetName: string;

  /** Report what would be erased. Must not mutate. */
  plan(subject: ErasureSubject): Promise<ErasurePlan>;

  /**
   * Carry out a previously produced plan, inside the caller's transaction so a
   * multi-context erasure is atomic or is not done at all.
   */
  erase(plan: ErasurePlan, transaction: TransactionScope): Promise<ErasureReceipt>;
}
