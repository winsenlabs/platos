// The `PrivacyRepository` port — the canonical store, seen only as an interface.
//
// ADR M0.3 §1 makes this context the SOLE WRITER of `ErasureOperation` and
// `ErasureTombstone`. This port is where that ownership is expressed: every
// mutation of either table in the V1 system passes through one of the methods
// below, and there is deliberately no generic `save(row)` or `query(where)`
// escape hatch through which another context could reach the tables sideways.
//
// EVERY READ IS ORGANIZATION-SCOPED. There is no `findOperation(id)`. There is
// `findOperation(organizationId, id)`, and an implementation MUST return `null`
// — not another tenant's row — when the id exists elsewhere. Making the scope a
// parameter rather than an ambient means a scope-less lookup does not compile.
// The tombstone register is scoped for a second reason as well: its digests are
// organization-salted, so a cross-tenant lookup could not match anyway, and a
// method that appeared to allow one would invite an implementation that tried.
//
// EVERY MUTATION TAKES A `TransactionScope`. The kernel's handle is opaque by
// construction (ADR M0.3 §3: no context passes a vendor transaction handle
// across a port), which is what lets a row write and an outbox append be atomic
// without either side naming the other's technology.
//
// Every method returns `Result`. A rejected promise is a defect, not an outcome
// — with one consequence worth stating: `PRIVACY_ERASURE_REGISTER_UNAVAILABLE`
// is a VALUE the barrier turns into a refusal, so an implementation that threw
// instead would bypass the fail-closed rule rather than fire it.

import type { OrganizationId, Result, TransactionScope } from "@platos/kernel";

import type {
  AliasHash,
  ErasureOperationId,
  ErasureOperationProgress,
  ErasureTombstone,
  ErasureTombstoneId,
  IdempotencyKey,
  LeaseToken,
  PersistedErasureOperation,
  SubjectKeyHash,
  TombstoneDraft,
  WorkStatus,
} from "../../domain/index.js";

/**
 * What one pass writes back.
 *
 * The identity columns are absent by construction rather than by convention: a
 * pass that could rewrite `subjectKeyHash` or `requestedAt` could quietly
 * re-point a finished receipt at a different person.
 */
export interface OperationProgressWrite extends ErasureOperationProgress {
  readonly workStatus: WorkStatus;
}

export interface OperationRepository {
  /**
   * The idempotency probe. Unique on `(organizationId, idempotencyKey)`, which
   * is the constraint that makes a duplicate request return the first answer
   * rather than start a second destruction.
   */
  findByIdempotencyKey(
    organizationId: OrganizationId,
    idempotencyKey: IdempotencyKey,
  ): Promise<Result<PersistedErasureOperation | null>>;

  findOperation(
    organizationId: OrganizationId,
    operationId: ErasureOperationId,
  ): Promise<Result<PersistedErasureOperation | null>>;

  /**
   * Insert one operation.
   *
   * An implementation MUST surface a unique-constraint violation on
   * `(organizationId, idempotencyKey)` as
   * `PRIVACY_IDEMPOTENCY_KEY_CONFLICT` and MUST NOT convert the insert into an
   * update: two callers racing the same key must not both start a destruction.
   */
  insertOperation(
    operation: PersistedErasureOperation,
    transaction: TransactionScope,
  ): Promise<Result<PersistedErasureOperation>>;

  /** Persist one pass's progress. The immutable columns are not writable here. */
  updateProgress(
    organizationId: OrganizationId,
    operationId: ErasureOperationId,
    progress: OperationProgressWrite,
    transaction: TransactionScope,
  ): Promise<Result<PersistedErasureOperation>>;

  /**
   * Take the lease, or report that another pass holds it.
   *
   * A compare-and-set, not a read-then-write: the check and the claim must be
   * one operation or two resumes racing both see a free lease. `false` means
   * somebody else won, which is a normal outcome and not an error.
   */
  claimLease(
    organizationId: OrganizationId,
    operationId: ErasureOperationId,
    lease: { readonly token: LeaseToken; readonly expiresAt: Date },
    now: Date,
    transaction: TransactionScope,
  ): Promise<Result<boolean>>;

  /** Operations the queue should re-drive, oldest due first. */
  listDueOperations(asOf: Date, limit: number): Promise<Result<readonly PersistedErasureOperation[]>>;

  /** Every operation recorded for one subject digest, newest first. */
  listOperationsForSubject(
    organizationId: OrganizationId,
    subjectKeyHash: SubjectKeyHash,
  ): Promise<Result<readonly PersistedErasureOperation[]>>;
}

export interface TombstoneRepository {
  /**
   * Which of these alias digests still refuse writes, as of `now`.
   *
   * Read-time expiry is the implementation's job as well as the domain's: the
   * retention rule must hold whether or not anything sweeps, so a row past its
   * `expiresAt` MUST NOT be returned even when it is still in the table.
   */
  findActiveTombstones(
    organizationId: OrganizationId,
    aliasHashes: readonly AliasHash[],
    now: Date,
  ): Promise<Result<readonly ErasureTombstone[]>>;

  /**
   * Seal an alias set: insert what is missing, then extend what already exists.
   *
   * INSERT-THEN-EXTEND, never delete-then-insert. A re-seal on retry must not
   * leave the barrier momentarily open, and a delete-then-insert does exactly
   * that for the width of its own transaction.
   *
   * Returns `{ sealed, extended }`: rows created, and rows whose expiry moved.
   */
  sealTombstones(
    drafts: readonly TombstoneDraft[],
    ids: readonly ErasureTombstoneId[],
    transaction: TransactionScope,
  ): Promise<Result<{ readonly sealed: number; readonly extended: number }>>;

  /**
   * Drop tombstones past their retention window.
   *
   * Correctness does not depend on this running — `findActiveTombstones` already
   * ignores elapsed rows — so it is safe to call opportunistically and safe
   * never to call at all beyond the table growing.
   */
  purgeExpiredTombstones(now: Date, transaction: TransactionScope): Promise<Result<number>>;
}

/** Both halves of this context's canonical-store ownership, in one handle. */
export interface PrivacyRepository extends OperationRepository, TombstoneRepository {}
