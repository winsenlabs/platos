// An in-memory `JobsRepository`.
//
// It is a real implementation of the port's CONTRACT, not a stub that returns
// whatever a test wants. In particular it enforces the two properties an adapter
// could get wrong silently and that every use-case test depends on:
//
//   * every read is scoped — a row in another environment is invisible, not
//     merely un-asserted;
//   * `@@unique([environmentId, externalId])` is real, so a duplicate key is
//     refused here exactly as Postgres would refuse it.
//
// `failNext` exists because the fail-closed paths are the ones most worth
// testing and a port that cannot be made to fail leaves them unreachable.

import { err, ok, type EnvironmentScope, type Result, type TransactionScope } from "@platos/kernel";

import { repositoryUnavailable, type Job, type JobId, type JobKey } from "../../domain/index.js";
import type { JobsRepository } from "../ports/index.js";

function keyOf(scope: EnvironmentScope, jobId: string): string {
  return `${scope.organizationId}/${scope.projectId}/${scope.environmentId}/${jobId}`;
}

export class InMemoryJobsRepository implements JobsRepository {
  private readonly rows = new Map<string, { readonly scope: EnvironmentScope; job: Job }>();
  private pendingFailure: string | null = null;

  /** Make the NEXT call fail, once. */
  failNext(reason = "injected"): void {
    this.pendingFailure = reason;
  }

  private takeFailure<Value>(): Result<Value> | null {
    if (this.pendingFailure === null) return null;
    const reason = this.pendingFailure;
    this.pendingFailure = null;
    return err(repositoryUnavailable(reason));
  }

  private sameScope(scope: EnvironmentScope, row: { readonly scope: EnvironmentScope }): boolean {
    return (
      row.scope.organizationId === scope.organizationId &&
      row.scope.projectId === scope.projectId &&
      row.scope.environmentId === scope.environmentId
    );
  }

  async insertJob(scope: EnvironmentScope, job: Job, _transaction: TransactionScope): Promise<Result<Job>> {
    const failure = this.takeFailure<Job>();
    if (failure) return failure;
    if (job.jobKey !== null) {
      const clash = [...this.rows.values()].find(
        (row) => this.sameScope(scope, row) && row.job.jobKey === job.jobKey,
      );
      if (clash) return err(repositoryUnavailable("unique(environmentId, externalId) violated"));
    }
    this.rows.set(keyOf(scope, job.jobId), { scope, job });
    return ok(job);
  }

  async findJob(scope: EnvironmentScope, jobId: JobId): Promise<Result<Job | null>> {
    const failure = this.takeFailure<Job | null>();
    if (failure) return failure;
    const row = this.rows.get(keyOf(scope, jobId));
    return ok(row && this.sameScope(scope, row) ? row.job : null);
  }

  async findJobByKey(scope: EnvironmentScope, jobKey: JobKey): Promise<Result<Job | null>> {
    const failure = this.takeFailure<Job | null>();
    if (failure) return failure;
    const row = [...this.rows.values()].find(
      (candidate) => this.sameScope(scope, candidate) && candidate.job.jobKey === jobKey,
    );
    return ok(row ? row.job : null);
  }

  async listJobs(scope: EnvironmentScope): Promise<Result<readonly Job[]>> {
    const failure = this.takeFailure<readonly Job[]>();
    if (failure) return failure;
    return ok(
      [...this.rows.values()]
        .filter((row) => this.sameScope(scope, row))
        .map((row) => row.job)
        .sort((left, right) => left.createdAt.getTime() - right.createdAt.getTime()),
    );
  }

  async updateJob(scope: EnvironmentScope, job: Job, _transaction: TransactionScope): Promise<Result<Job>> {
    const failure = this.takeFailure<Job>();
    if (failure) return failure;
    const key = keyOf(scope, job.jobId);
    const row = this.rows.get(key);
    if (!row || !this.sameScope(scope, row)) return err(repositoryUnavailable("job absent from scope"));
    this.rows.set(key, { scope, job });
    return ok(job);
  }

  async markStarted(scope: EnvironmentScope, jobId: JobId, startedAt: Date): Promise<Result<boolean>> {
    const failure = this.takeFailure<boolean>();
    if (failure) return failure;
    const row = this.rows.get(keyOf(scope, jobId));
    // Guarded on ACTIVE, exactly like the live conditional update.
    if (!row || !this.sameScope(scope, row) || row.job.status !== "active") return ok(false);
    row.job = { ...row.job, lastStartedAt: startedAt, updatedAt: startedAt };
    return ok(true);
  }

  async deleteJob(
    scope: EnvironmentScope,
    jobId: JobId,
    _transaction: TransactionScope,
  ): Promise<Result<boolean>> {
    const failure = this.takeFailure<boolean>();
    if (failure) return failure;
    const key = keyOf(scope, jobId);
    const row = this.rows.get(key);
    if (!row || !this.sameScope(scope, row)) return ok(false);
    this.rows.delete(key);
    return ok(true);
  }

  /** Total rows across every scope — for asserting isolation, not for use cases. */
  size(): number {
    return this.rows.size;
  }
}
