// The `JobsRepository` port — the canonical store, seen only as an interface.
//
// ADR M0.3 §1 makes this context the SOLE WRITER of `Job` and `AgentApproval`.
// This port and its sibling are where that ownership is expressed: every mutation
// of either table in the V1 system passes through one of these methods, and there
// is deliberately no generic `save(row)` or `query(where)` escape hatch through
// which another context could reach the tables sideways.
//
// EVERY READ IS SCOPED. There is no `findJob(id)`. There is
// `findJob(scope, id)`, and an implementation MUST return `null` — not a row from
// another environment — when the id exists elsewhere. Making the scope a
// parameter rather than an ambient means a scope-less lookup does not compile.
//
// EVERY MUTATION TAKES A `TransactionScope`. The kernel's handle is opaque by
// construction (ADR M0.3 §3: no context passes a vendor transaction handle across
// a port), which is what lets a caller make a row write and an outbox append
// atomic without either side naming the other's technology.
//
// Every method returns `Result`. A rejected promise is a defect, not an outcome.

import type { EnvironmentScope, Result, TransactionScope } from "@platos/kernel";

import type { Job, JobId, JobKey } from "../../domain/index.js";

export interface JobsRepository {
  insertJob(scope: EnvironmentScope, job: Job, transaction: TransactionScope): Promise<Result<Job>>;

  findJob(scope: EnvironmentScope, jobId: JobId): Promise<Result<Job | null>>;

  /** Resolves the `@@unique([environmentId, externalId])` the schema declares. */
  findJobByKey(scope: EnvironmentScope, jobKey: JobKey): Promise<Result<Job | null>>;

  listJobs(scope: EnvironmentScope): Promise<Result<readonly Job[]>>;

  updateJob(scope: EnvironmentScope, job: Job, transaction: TransactionScope): Promise<Result<Job>>;

  /**
   * Stamp `lastStartedAt` on a job that is still ACTIVE in this scope.
   *
   * Separate from `updateJob` because the live service performs it as a
   * conditional `updateMany` guarded on the status and DISCARDS its failure
   * (`.catch(() => undefined)`): a run that succeeded is not retroactively failed
   * because a bookkeeping column did not update. `Result` here reports that
   * outcome instead of swallowing it, and the use case decides to ignore it —
   * visibly, at the call site.
   */
  markStarted(scope: EnvironmentScope, jobId: JobId, startedAt: Date): Promise<Result<boolean>>;

  deleteJob(scope: EnvironmentScope, jobId: JobId, transaction: TransactionScope): Promise<Result<boolean>>;
}
