// Driven ports this context needs.
//
// `PrivacyRepository` is the canonical-store port behind which this context's
// sole-writer ownership of `ErasureOperation` and `ErasureTombstone` is
// realised. `SubjectDirectory`, `SubjectHasher` and `LegalHoldRegister` are the
// three things an erasure needs that this context is not allowed to reach for
// itself: who the person is, the salt, and the operator's hold list.
//
// The kernel `ErasureTarget[]` is NOT a port declared here. It is a kernel port
// implemented by every context that owns subject-keyed rows and injected as an
// array at the composition root (ADR M0.3 §3), so it arrives as a dependency
// rather than as something this package defines.
//
// Implemented under `packages/adapters/*` and `apps/core-api`, wired at the
// composition root, never imported by `domain/` (ADR M0.3 §2).
export * from "./privacy-repository.js";
export * from "./subject-directory.js";
export * from "./subject-hasher.js";
export * from "./legal-hold-register.js";

// WIN-258 T5 — the domain values the canonical-store port's SIGNATURES already
// name.
//
// WITHOUT THIS BLOCK `PrivacyRepository` IS UNIMPLEMENTABLE OUTSIDE THIS
// PACKAGE. `privacy-repository.ts` above imports `PersistedErasureOperation`,
// `ErasureTombstone`, `TombstoneDraft`, `WorkStatus` and eight more from
// `../../domain/index.js` as TYPES and re-exports none of them, and
// `contracts/index.ts` publishes the receipt VIEWS rather than the stored rows.
// So every method of the port was declared in terms of names an adapter package
// — the only kind of package ADR M0.3 §2 permits to implement a driven port —
// had no way to spell. The same omission was found five times already on this
// issue, on `EndUserStore`, on `SessionRevocationOrder`, on `BudgetRepository`,
// on `ChannelsRepository` and on `memory`'s pair; this is the sixth, and it is
// repaired the same way: the port entry point publishes exactly what the port's
// own signatures use, plus the values an implementation must not re-derive, and
// nothing more.
//
// THE FUNCTIONS ARE HERE FOR A STRONGER REASON THAN THE TYPES. `isActive` and
// `hasElapsed` ARE the read-time expiry rule `findActiveTombstones` and
// `purgeExpiredTombstones` are required to apply, and they are exact
// complements at the boundary instant; a store that wrote its own comparison
// would be a second definition of a rule the domain already owns, and the two
// would drift on exactly the tick nobody tests. `isLeaseFree` is the same for
// the compare-and-set in `claimLease`. `ZERO_COUNTS` is the empty
// `TargetCounts` a stored outcome is read back against, so a store that spelled
// its own zeroes would disagree with the domain the day a fifth method joins the
// split.
// `idempotencyKeyConflict`, `operationNotFound`, `operationStoreUnavailable`
// and `erasureRegisterUnavailable` are published because a store must report a
// conflict, a miss and an outage with the SAME errors the in-memory double
// reports, or the shared conformance transcript compares two vocabularies and
// calls the difference a divergence.
//
// The kernel values these signatures name are republished for the same reason
// `identity-access`'s, `cost-monitoring`'s, `channels`' and `memory`'s port
// entry points republish their own: `Result` and `TransactionScope` are in
// every method and `OrganizationId` in most, and an adapter that reached for
// `@platos/kernel` directly would be a second import edge into the kernel from
// a package whose only declared dependency is the context whose port it
// satisfies.
export type { EnvironmentScope, NotResult, OrganizationId, OrganizationScope, ProjectScope, Result, TenantScope, TransactionScope } from "@platos/kernel";
// WIN-260 (M2.5): `runResult` joins them, and `NotResult` beside it.
// `UnitOfWork.run` REFUSES a callback whose answer is a `Result` — such a
// callback RESOLVES, and a resolved callback COMMITS, which is the defect
// `cost-monitoring` shipped — so `runResult` is the only way to end a unit of
// work with a failure, and every canonical store's suite needs it. It is
// republished HERE rather than imported from `@platos/kernel` in the adapter,
// for the reason stated above: that would be the second import edge into the
// kernel this paragraph exists to refuse.
export { asIdentifier, environmentScope, err, ok, organizationScope, projectScope, runResult } from "@platos/kernel";

export type {
  AliasHash,
  ErasureOperationId,
  ErasureOperationProgress,
  ErasureTombstone,
  ErasureTombstoneId,
  IdempotencyKey,
  LeaseToken,
  PersistedErasureOperation,
  SubjectKeyHash,
  TargetCounts,
  TargetOutcome,
  TargetStatus,
  TombstoneDraft,
  VerificationStatus,
  WorkStatus,
} from "../../domain/index.js";
export {
  erasureRegisterUnavailable,
  hasElapsed,
  idempotencyKeyConflict,
  isActive,
  isLeaseFree,
  operationNotFound,
  operationStoreUnavailable,
  ZERO_COUNTS,
} from "../../domain/index.js";
