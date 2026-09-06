// Driven ports this context needs.
//
// `JobsRepository` and `ApprovalsRepository` are the canonical-store ports behind
// which this context's sole-writer ownership of `Job` and `AgentApproval` is
// realised. `IdempotencyStore` and `JobHandlerRuntime` are the two pieces of
// infrastructure the execution path cannot do without — a reserve-once keyspace
// and an isolate — each reduced to the meaning this context needs rather than the
// capability its vendor offers.
//
// ADR M0.3 §13 assigns no adapter-facing port to `jobs`, so unlike `files` this
// entrypoint publishes nothing another package OWNS: it exists because the
// adapters that implement these four import them from here, and for no other
// reason.
//
// Implemented under `packages/adapters/*`, wired in `apps/core-api`, never
// imported by `domain/` (ADR M0.3 §2).
export * from "./jobs-repository.js";
export * from "./approvals-repository.js";
export * from "./idempotency-store.js";
export * from "./job-handler-runtime.js";

// WIN-258 T5 — the kernel values and the domain values the two canonical-store
// ports' SIGNATURES already name.
//
// WITHOUT THIS BLOCK BOTH ARE UNIMPLEMENTABLE OUTSIDE THIS PACKAGE. The four
// port modules above import their entities from `../../domain/index.js` as TYPES
// and re-export none of them, and `contracts/index.ts` publishes the read VIEWS
// rather than the aggregates — so `JobsRepository.insertJob` was declared in
// terms of `Job`, and `ApprovalsRepository.resolve` in terms of `Approval`, and
// neither is a name an adapter package had any way to spell. The same omission
// was found on `EndUserStore`, on `SessionRevocationOrder`, on
// `cost-monitoring`'s whole aggregate set and on `governance`'s; this is the
// fifth, repaired the same way. The port entry point publishes exactly what the
// port signatures use, and nothing more.
//
// THE TWO STORED-VOCABULARY TABLES ARE HERE FOR A STRONGER REASON THAN THE
// TYPES. `Job.triggerType` is a plain `TEXT` column and `Job.status` is the
// FIVE-member `WorkStatus` enum of which a `Job` row only ever holds two
// (`domain/job.ts`), so in both cases the closed set an adapter must hold a row
// to lives HERE and nowhere in the database. A store that CAST either would put
// a value outside the union into `assertDispatchable`, whose authorization table
// is keyed BY the union — and an unknown invocation type would then authorize
// nothing while reporting no error at all. `isStoredInvocationType`,
// `JOB_STATUS_TO_STORED` and `fromStoredStatus` are what let an adapter refuse
// such a row by name instead of casting it.
//
// `environmentFallsWithin` is published for the reason the predicates are: the
// erasure selector carries a `TenantScope` that may address an organization
// while every row it reaches is environment-keyed, and an adapter that re-derived
// that containment would be a second copy of a rule `domain/scope.ts` owns.
//
// The kernel values these signatures name are republished for the reason
// `identity-access`'s, `cost-monitoring`'s and `governance`'s port entry points
// republish theirs: `EnvironmentScope`, `TenantScope`, `TransactionScope`,
// `Result` and `JsonValue` are in nearly every method above, and an adapter
// reaching for `@platos/kernel` directly would be a second import edge into the
// kernel from a package whose only declared dependency is the context whose
// ports it satisfies.
export type {
  EnvironmentScope,
  JsonValue,
  Result,
  TenantScope,
  TransactionScope,
} from "@platos/kernel";
export { asIdentifier, contains, environmentScope, err, ok } from "@platos/kernel";

export type {
  AgentId,
  Approval,
  ApprovalDecision,
  ApprovalEdit,
  ApprovalId,
  ApprovalResolution,
  ApprovalRowId,
  ApprovalSource,
  ApprovalStatus,
  Job,
  JobExecutionBudget,
  JobId,
  JobKey,
  JobSchedule,
  JobStatus,
  RequestDigest,
  StoredApprovalStatus,
  StoredInvocationType,
  ThreadId,
  TurnId,
} from "../../domain/index.js";
export {
  environmentFallsWithin,
  fromStoredStatus,
  isJobKey,
  isStoredInvocationType,
  JOB_STATUS_TO_STORED,
  repositoryUnavailable,
  toStoredStatus,
} from "../../domain/index.js";
