// Driven ports this context needs, and the adapter-facing port it OWNS.
//
// `ObservabilitySink` is published from here rather than from the kernel: ADR
// M0.3 §13 assigns it to `observability`, and
// `packages/adapters/clickhouse-observability` has exactly one import edge, to
// this entrypoint.
//
// The other three are driven ports with no vendor of their own:
// `ProjectionOutbox` is the drain side of the one transactional outbox,
// `ObservabilityRepository` is the canonical-store port behind this context's
// sole-writer ownership of `AdminAudit`, and `ErasedSubjectRegister` is the
// fail-closed question the drain must ask before it delivers.
//
// All four are implemented under `packages/adapters/*`, wired in
// `apps/core-api`, and never imported by `domain/` (ADR M0.3 §2).
export * from "./observability-sink.js";
export * from "./projection-outbox.js";
export * from "./observability-repository.js";
export * from "./erased-subject-register.js";

// WIN-258 T5 — the domain values `ObservabilityRepository`'s SIGNATURES already
// name.
//
// WITHOUT THIS BLOCK THE CANONICAL-STORE PORT IS UNIMPLEMENTABLE OUTSIDE THIS
// PACKAGE. `observability-repository.ts` above imports `AdminAuditRecord` and
// `AdminAuditQuery` from `../../domain/index.js` as TYPES and re-exports
// neither, and `contracts/index.ts` publishes the read VIEWS rather than the
// record. So all four methods were declared in terms of names an adapter
// package — the only kind of package ADR M0.3 §2 permits to implement a driven
// port — had no way to spell. The same omission was found five times already on
// this issue, on `EndUserStore`, on `SessionRevocationOrder`, on
// `BudgetRepository`, on `ChannelsRepository` and on `memory`'s pair; this is
// the sixth, and it is repaired the same way: the port entry point publishes
// exactly what the port's own signatures use, plus the values an implementation
// must not re-derive, and nothing more.
//
// THE FUNCTIONS AND CONSTANTS ARE HERE FOR A STRONGER REASON THAN THE TYPES.
// `AUDIT_STATE_MAX_BYTES`, `AUDIT_ACTION_MAX_LENGTH` and
// `AUDIT_REASON_MAX_LENGTH` are the caps `buildAdminAuditRecord` already
// applies, and a store that re-derived any of them would hold a second copy of a
// bound the domain owns and the two would drift. `asObject` is the object-root
// test `AdminAudit_before_json_root` and `AdminAudit_after_json_root` install in
// the migration, so a store reading a `before` an older binary wrote uses the
// domain's own reader rather than a cast. `repositoryUnavailable` is published
// because a store must report an outage with the SAME error the in-memory
// double reports, or the shared conformance transcript compares two
// vocabularies and calls the difference a divergence.
//
// The kernel values these signatures name are republished for the same reason
// `identity-access`'s, `cost-monitoring`'s, `channels`' and `memory`'s port
// entry points republish their own: `Result` and `TransactionScope` are in every
// method and `EnvironmentScope` in the record, and an adapter that reached for
// `@platos/kernel` directly would be a second import edge into the kernel from a
// package whose only declared dependency is the context whose port it satisfies.
export type {
  EnvironmentId,
  EnvironmentScope,
  OrganizationId,
  PrincipalId,
  ProjectId,
  Result,
  TransactionScope,
} from "@platos/kernel";
export { asIdentifier, environmentScope, err, ok } from "@platos/kernel";

export type {
  AdminAuditId,
  AdminAuditQuery,
  AdminAuditRecord,
  AuditState,
  JsonObject,
} from "../../domain/index.js";
export {
  asObject,
  AUDIT_ACTION_MAX_LENGTH,
  AUDIT_PAGE_MAX,
  AUDIT_REASON_MAX_LENGTH,
  AUDIT_STATE_MAX_BYTES,
  DEFAULT_AUDIT_SOURCE,
  repositoryUnavailable,
  resolveAuditLimit,
} from "../../domain/index.js";
