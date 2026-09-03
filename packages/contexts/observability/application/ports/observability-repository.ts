// The canonical-store port behind this context's sole-writer ownership of
// `AdminAudit` (ADR M0.3 §1, row 12).
//
// Only one model. The four analytical tables are not here — they are reached
// through `ObservabilitySink`, because they live in a different store with a
// different failure model, and giving them one interface would mean one of the
// two sets of methods lying about its guarantees.
//
// EVERY WRITE TAKES THE CALLER'S TRANSACTION. An admin action and its audit row
// commit together or neither commits: an audit trail that can disagree with what
// actually happened is worse than no audit trail, because it is believed. The
// handle is the kernel's opaque `TransactionScope`, never a vendor session
// (ADR M0.3 §3).

import type { Result, TransactionScope } from "@platos/kernel";

import type { AdminAuditQuery, AdminAuditRecord } from "../../domain/index.js";

/** Which audit rows an actor-scoped erasure addresses. */
export interface AdminAuditActorSelector {
  /** The tenant the erasure is scoped to. */
  readonly organizationId: string;
  /** The operator principal recorded in `actorUserId`. Never blank. */
  readonly actorUserId: string;
}

export interface ObservabilityRepository {
  /** Append one audit record inside the caller's transaction. */
  recordAdminAudit(
    record: AdminAuditRecord,
    transaction: TransactionScope,
  ): Promise<Result<AdminAuditRecord>>;

  /** One page of the trail, newest first, never crossing the given scope. */
  listAdminAudit(query: AdminAuditQuery): Promise<Result<readonly AdminAuditRecord[]>>;

  /** How many audit rows name this actor. The pre-count an erasure plan reports. */
  countAdminAuditForActor(selector: AdminAuditActorSelector): Promise<Result<number>>;

  /**
   * Clear `actorUserId` on every row naming this actor. Returns rows changed.
   *
   * UNLINK, NOT DELETE. The row is the record of what was changed and by what
   * kind of actor; destroying it to remove a name destroys the accountability
   * the table exists to provide.
   */
  clearAdminAuditActor(
    selector: AdminAuditActorSelector,
    transaction: TransactionScope,
  ): Promise<Result<number>>;
}
