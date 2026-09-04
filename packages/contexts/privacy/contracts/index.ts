// The published surface of the `privacy` context.
//
// ADR M0.3 §2: another context may import THIS entrypoint and nothing else —
// never `domain/`, never `application/`, never an adapter. It is types only.
// Nothing here has a runtime representation, so importing this module costs a
// consumer no code and cannot drag an implementation across a context boundary.
// The implementation is `createPrivacyContract` in `application/`, and it is
// reached only through the composition root.
//
// TWO KINDS OF CALLER, AND THE SECOND IS THE INTERESTING ONE.
//
// The first is an operator surface: request an erasure, retry one, read a
// receipt, enumerate a subject's footprint. Those are rare and deliberate.
//
// The second is the WRITE BARRIER — `assertSubjectNotErased` and
// `erasedAliases`. Those sit on the hot path of every identity chokepoint in the
// system, and they are the reason this contract exists at all: an erasure that
// nothing consults is undone by the next request. They are published here rather
// than left to a shared helper precisely so the check cannot drift from the
// register that backs it.
//
// The driven ports (`PrivacyRepository`, `SubjectDirectory`, `SubjectHasher`,
// `LegalHoldRegister`) are NOT re-exported here. They are adapter-facing, not
// context-facing, and are published from `application/ports/index.js` where
// their adapters import them (ADR M0.3 §13).

import type { OrganizationId, Result, TenantScope } from "@platos/kernel";

import type {
  AliasHash,
  ErasureOperationId,
  ErasureStatus,
  IdempotencyKey,
  SubjectAlias,
  SubjectKeyHash,
  TargetStatus,
  VerificationStatus,
} from "../domain/index.js";

// The identifier and alias vocabulary a caller needs to build a command. Branded
// types, so a raw handle cannot reach a digest parameter across the boundary any
// more than it can inside it.
export type {
  AliasHash,
  ErasureOperationId,
  ErasureStatus,
  ErasureTombstoneId,
  IdempotencyKey,
  SubjectAlias,
  SubjectKeyHash,
  TargetStatus,
  VerificationStatus,
  WorkStatus,
} from "../domain/index.js";

export { CANONICAL_ALIAS_CHANNEL } from "../domain/alias.js";
export { LEGAL_HOLD_REFERENCE_PREFIX, isLegalHoldReference } from "../domain/legal-hold.js";

export * from "./events.js";

// --- read models -------------------------------------------------------------

/** One target's result, as seen from outside. Counts only, never content. */
export interface TargetOutcomeView {
  readonly target: string;
  readonly status: TargetStatus;
  readonly verification: VerificationStatus;
  readonly discovered: number;
  readonly deleted: number;
  readonly anonymized: number;
  readonly cryptoShredded: number;
  readonly retained: number;
  readonly failures: number;
  readonly note: string | null;
}

/**
 * The receipt.
 *
 * `subjectKeyHash` and not a subject: this value is retained indefinitely as the
 * evidence an erasure happened, so it must not carry the identifier the erasure
 * destroyed. `legalHoldPolicyId` is a register position plus a truncated digest
 * for the same reason.
 */
export interface ErasureOperationView {
  readonly operationId: ErasureOperationId;
  readonly organizationId: OrganizationId;
  readonly idempotencyKey: IdempotencyKey;
  readonly subjectKeyHash: SubjectKeyHash;
  readonly status: ErasureStatus;
  readonly scopes: readonly TenantScope[];
  readonly outcomes: readonly TargetOutcomeView[];
  readonly policyVersion: string;
  readonly legalHoldPolicyId: string | null;
  readonly retryCount: number;
  readonly requestedAt: Date;
  readonly startedAt: Date | null;
  readonly completedAt: Date | null;
  readonly nextRetryAt: Date | null;
}

/** What a subject's footprint looks like without destroying any of it. */
export interface SubjectInventoryView {
  readonly subjectKeyHash: SubjectKeyHash;
  readonly resolvedSubjects: number;
  readonly scopes: readonly TenantScope[];
  /** Per-target planned row counts. A target absent here reported nothing. */
  readonly planned: readonly { readonly target: string; readonly rowCount: number }[];
  readonly discovered: number;
  /** Set when a hold would block the erasure. A reference, never an entry. */
  readonly legalHoldPolicyId: string | null;
}

export interface SealSummaryView {
  readonly aliases: number;
  readonly sealed: number;
  readonly extended: number;
  readonly purged: number;
}

// --- commands ----------------------------------------------------------------

export interface RequestErasureCommand {
  readonly organizationId: OrganizationId;
  /** The handle the caller named. Resolved to every alias before anything runs. */
  readonly externalUserId: string;
  /** Unique within the organization. Two requests sharing one are one request. */
  readonly idempotencyKey: IdempotencyKey;
  /**
   * A hold the caller already knows about. ADDS to the server-side register
   * rather than replacing it: a caller who knows of no hold must not be able to
   * erase a subject the register protects.
   */
  readonly legalHoldPolicyId?: string | null;
}

export interface RetryErasureCommand {
  readonly organizationId: OrganizationId;
  readonly operationId: ErasureOperationId;
  /**
   * Re-supplied because the first pass destroyed the rows that resolve it. An
   * operator-driven retry can address the whole subject again; a retry without
   * it could only address what the record still names.
   */
  readonly externalUserId: string;
  readonly cause?: "operator-retry" | "queue-resume";
}

export interface DescribeOperationQuery {
  readonly organizationId: OrganizationId;
  readonly operationId: ErasureOperationId;
}

export interface InventorySubjectQuery {
  readonly organizationId: OrganizationId;
  readonly externalUserId: string;
}

/**
 * A write about to happen, presented for the barrier's approval.
 *
 * `aliases` is every handle the write is keyed by — all of them, not the one the
 * caller finds most convenient. A chokepoint that presented a single alias would
 * let the subject back in through any other.
 */
export interface SubjectWriteCheck {
  readonly organizationId: OrganizationId;
  readonly aliases: readonly SubjectAlias[];
}

export interface PurgeTombstonesCommand {
  readonly organizationId: OrganizationId;
}

// --- the contract ------------------------------------------------------------

/**
 * What privacy offers the rest of the system.
 *
 * Every method returns the kernel's `Result`: a failure a caller must handle is
 * visible in the type, and no vendor exception crosses this boundary.
 */
export interface PrivacyContract {
  readonly name: "privacy";

  /** Request an erasure. Idempotent on `(organization, idempotencyKey)`. */
  requestErasure(command: RequestErasureCommand): Promise<Result<ErasureOperationView>>;

  /** Re-run only the targets that did not settle. */
  retryErasure(command: RetryErasureCommand): Promise<Result<ErasureOperationView>>;

  describeOperation(query: DescribeOperationQuery): Promise<Result<ErasureOperationView>>;

  /** Enumerate a subject's footprint. Must not mutate anything. */
  inventorySubject(query: InventorySubjectQuery): Promise<Result<SubjectInventoryView>>;

  /**
   * The write barrier. Fails with `PRIVACY_SUBJECT_ERASED` when any presented
   * alias belongs to an erased subject, and with
   * `PRIVACY_ERASURE_REGISTER_UNAVAILABLE` when it cannot tell — both of which
   * REFUSE the write. "We lost the ability to tell" must never read as "nobody
   * here is erased".
   */
  assertSubjectNotErased(check: SubjectWriteCheck): Promise<Result<void>>;

  /**
   * The batch form, for the one caller that decides row by row rather than
   * refusing a single write: a drain holding a full batch of queued projections
   * must drop the erased subjects' rows while delivering everyone else's.
   *
   * Returns the ERASED subset as alias digests, which are content-free: the
   * caller digests its own aliases and looks its rows up in the result. Nothing
   * reversible crosses this boundary in either direction.
   */
  erasedAliases(check: SubjectWriteCheck): Promise<Result<readonly AliasHash[]>>;

  /** Drop tombstones past their retention window. Never load-bearing. */
  purgeExpiredTombstones(command: PurgeTombstonesCommand): Promise<Result<number>>;
}

/**
 * Retained from the generated skeleton so no sibling placeholder breaks. The
 * "aggregate" privacy hands out is the receipt: an operation, not a row.
 */
export type PrivacyAggregate = ErasureOperationView;
