// The `JobsRepository` — `jobs`' `Job` half, seven methods over one table.
//
// `insertJob` GOES THROUGH `createManyAndReturn` WITH `skipDuplicates`, WHICH IS
// `ON CONFLICT DO NOTHING`, and that is not a style choice. `Job` carries two
// unique indexes — its primary key and `@@unique([environmentId, externalId])` —
// and on PostgreSQL a raised unique violation ABORTS the enclosing transaction:
// every later statement fails with 25P02 until the block ends. `register-job.ts`
// writes the row inside the caller's unit of work, so a store that let the index
// raise would have reported the conflict correctly and taken the caller's
// transaction with it. `ON CONFLICT DO NOTHING` raises nothing, and an empty
// return is the conflict.
//
// A COUNT OF ZERO IS REPORTED AS THE DOUBLE REPORTS IT. `InMemoryJobsRepository`
// answers `repositoryUnavailable("unique(environmentId, externalId) violated")`
// for a duplicate key, and `domain/errors.ts` publishes a `jobAlreadyExists`
// this port's signature has no way to return — `insertJob` returns
// `Result<Job>`, and the conflict a caller can act on is minted by
// `register-job.ts` from its own pre-read. The two stores therefore agree on
// the code, and this file does not invent a richer answer than the port can
// carry.
//
// WHICH INDEX SPOKE IS NOT ASKED, AND CANNOT BE. `Job.id` is supplied by the
// CALLER here rather than defaulted by the database, so unlike
// `governance-criteria.ts` — where a zero count could only be the name — either
// index can be the one that refused. A follow-up read to say which would be a
// second statement on a path whose whole point is to survive without one, and
// the port has one error to return in both cases.
//
// `markStarted` IS THE ONE METHOD THAT TAKES NO `TransactionScope`, and the
// port says why: the live service performs it as a conditional `updateMany`
// guarded on the status and DISCARDS its failure, so "a run that succeeded is
// not retroactively failed because a bookkeeping column did not update". It
// therefore resolves its client through `atomic()`, which joins the caller's
// open transaction when there is one and opens its own when there is not — and
// which resolves through `writer()` either way, so the write is held to the same
// three refusals every other write in this directory is. It is NOT `pool()`: a
// use case that marks a job started inside its own unit of work should have that
// write roll back with it, and `providers`' `touchProviderKey` is the one method
// in this directory whose port asks for the opposite.
//
// EVERY READ IS SCOPED AND THE SCOPE IS IN THE KEY, not applied afterwards.
// `findJob(scope, id)` is `findFirst({ where: { id, environmentId } })` and not
// a `findUnique` followed by a comparison: the second shape answers from the
// database and then discards, which is one round trip's worth of another
// tenant's row inside this process.

import type {
  EnvironmentScope,
  Job,
  JobId,
  JobKey,
  JobsRepository,
  Result,
  TransactionScope,
} from "@platos/context-jobs/application/ports/index.js";
import {
  err,
  JOB_STATUS_TO_STORED,
  ok,
  repositoryUnavailable,
} from "@platos/context-jobs/application/ports/index.js";

import { nullableJson } from "./client.js";
import { guardJob, requireUuid } from "./jobs-guards.js";
import { refuseJobs } from "./jobs-refusal.js";
import { readJob, scopedWhere, type JobRow } from "./jobs-rows.js";
import type { TenancyTransactions } from "./transaction.js";

/**
 * Every column `readJob` needs, and no other.
 *
 * Spelled out rather than left to the client's default projection so that a
 * column added by a later migration does not silently join every read this
 * store performs — the expand half of expand/contract is a column appearing,
 * and a `SELECT *` is how a store starts depending on one it never asked for.
 */
const JOB_COLUMNS = {
  id: true,
  environmentId: true,
  externalId: true,
  displayName: true,
  description: true,
  invocationType: true,
  scheduleCron: true,
  scheduleTimezone: true,
  allowedAgentIds: true,
  payloadSchema: true,
  handler: true,
  timeoutSeconds: true,
  maxRetries: true,
  status: true,
  createdBy: true,
  lastStartedAt: true,
  createdAt: true,
  updatedAt: true,
} as const;

/**
 * The row a `Job` becomes, minus its identity and its scope.
 *
 * `invocationType` is the CLIENT PROPERTY and `triggerType` is the column behind
 * it. `domain/invocation.ts` carries a note for whoever wrote this adapter:
 * `apps/agent`'s `agent-runtime/job-persistence.ts` assembles the pre-cutover
 * column name at runtime from string fragments and addresses a field the
 * generated client does not have, because `@map` renames the COLUMN and not the
 * property. That helper is not copied. This is the property.
 */
function jobColumns(job: Job) {
  return {
    externalId: job.jobKey,
    displayName: job.displayName,
    description: job.description,
    invocationType: job.invocationType,
    scheduleCron: job.schedule.cron,
    scheduleTimezone: job.schedule.timezone,
    allowedAgentIds: [...job.allowedAgentIds],
    payloadSchema: nullableJson(job.payloadSchema),
    handler: job.handler,
    timeoutSeconds: job.budget.timeoutSeconds,
    maxRetries: job.budget.maxRetries,
    status: JOB_STATUS_TO_STORED[job.status],
    createdBy: job.createdBy,
    lastStartedAt: job.lastStartedAt,
    updatedAt: job.updatedAt,
  };
}

export function createJobsRepository(transactions: TenancyTransactions): JobsRepository {
  return {
    async insertJob(
      scope: EnvironmentScope,
      job: Job,
      transaction: TransactionScope,
    ): Promise<Result<Job>> {
      return refuseJobs(async () => {
        guardJob(job);
        requireUuid("Job.environmentId", scope.environmentId);
        const client = transactions.writer(transaction);
        const created = await client.job.createManyAndReturn({
          data: [
            {
              id: job.jobId,
              environmentId: scope.environmentId,
              createdAt: job.createdAt,
              ...jobColumns(job),
            },
          ],
          skipDuplicates: true,
          select: JOB_COLUMNS,
        });
        const row = created[0];
        if (row === undefined) {
          return err(repositoryUnavailable("unique(environmentId, externalId) violated"));
        }
        return ok(readJob(row as JobRow));
      }, "jobs insertJob");
    },

    async findJob(scope: EnvironmentScope, jobId: JobId): Promise<Result<Job | null>> {
      return refuseJobs(async () => {
        const row = await transactions.reader().job.findFirst({
          where: { id: jobId, ...scopedWhere(scope) },
          select: JOB_COLUMNS,
        });
        return ok(row === null ? null : readJob(row as JobRow));
      }, "jobs findJob");
    },

    async findJobByKey(scope: EnvironmentScope, jobKey: JobKey): Promise<Result<Job | null>> {
      return refuseJobs(async () => {
        // Resolves `@@unique([environmentId, externalId])` through a `findFirst`
        // on both halves rather than through the compound `findUnique`, because
        // the compound form takes `externalId: string` and this column is
        // nullable: a NULL key would have to be spelled as a different call.
        const row = await transactions.reader().job.findFirst({
          where: { externalId: jobKey, ...scopedWhere(scope) },
          select: JOB_COLUMNS,
        });
        return ok(row === null ? null : readJob(row as JobRow));
      }, "jobs findJobByKey");
    },

    async listJobs(scope: EnvironmentScope): Promise<Result<readonly Job[]>> {
      return refuseJobs(async () => {
        // ONE statement, ordered oldest-first with `id` breaking the tie. The
        // double sorts by `createdAt` alone, which is not a total order:
        // `createdAt` is `TIMESTAMP(3)` and `now()` is the TRANSACTION's start
        // time on PostgreSQL, so two jobs registered in one unit of work carry
        // the identical instant and an untied order would differ per read.
        const rows = await transactions.reader().job.findMany({
          where: scopedWhere(scope),
          select: JOB_COLUMNS,
          orderBy: [{ createdAt: "asc" }, { id: "asc" }],
        });
        return ok(rows.map((row) => readJob(row as JobRow)));
      }, "jobs listJobs");
    },

    async updateJob(
      scope: EnvironmentScope,
      job: Job,
      transaction: TransactionScope,
    ): Promise<Result<Job>> {
      return refuseJobs(async () => {
        guardJob(job);
        const client = transactions.writer(transaction);
        // Keyed on BOTH the id AND the environment, so a row that exists in
        // another tenant is not written by an id this caller happens to hold.
        // `updateMany` rather than `update`, because `update` RAISES when it
        // matches nothing and a raise would take the caller's transaction.
        const outcome = await client.job.updateMany({
          where: { id: job.jobId, ...scopedWhere(scope) },
          data: jobColumns(job),
        });
        if (outcome.count === 0) return err(repositoryUnavailable("job absent from scope"));
        return ok(job);
      }, "jobs updateJob");
    },

    async markStarted(
      scope: EnvironmentScope,
      jobId: JobId,
      startedAt: Date,
    ): Promise<Result<boolean>> {
      return refuseJobs(async () => {
        // GUARDED ON `ACTIVE`, exactly like the live conditional update: a job
        // that was deactivated between the dispatch and the stamp does not get
        // a `lastStartedAt` that says otherwise. `updatedAt` moves with it,
        // matching `withLastStartedAt` in `domain/job.ts`.
        //
        // THROUGH `atomic()` BECAUSE THE SIGNATURE CARRIES NO TOKEN. It joins
        // the caller's open transaction when there is one and opens its own when
        // there is not, and it resolves its client through `writer()` either
        // way — so this write is held to the same three refusals every other
        // write in this directory is, without the port having to name a
        // transaction it deliberately does not take. It is the shape WIN-258 T2
        // built for `IdentityAccessRepository`'s ten token-less writes.
        const outcome = await transactions.atomic((client) =>
          client.job.updateMany({
            where: { id: jobId, status: "ACTIVE", ...scopedWhere(scope) },
            data: { lastStartedAt: startedAt, updatedAt: startedAt },
          }),
        );
        return ok(outcome.count > 0);
      }, "jobs markStarted");
    },

    async deleteJob(
      scope: EnvironmentScope,
      jobId: JobId,
      transaction: TransactionScope,
    ): Promise<Result<boolean>> {
      return refuseJobs(async () => {
        const client = transactions.writer(transaction);
        const outcome = await client.job.deleteMany({
          where: { id: jobId, ...scopedWhere(scope) },
        });
        return ok(outcome.count > 0);
      }, "jobs deleteJob");
    },
  };
}
