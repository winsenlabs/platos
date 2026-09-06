// One scenario, written once, so `jobs`' two in-memory doubles and this adapter
// can be asked the SAME questions and their answers compared.
//
// Same instrument as `./conformance.ts`, `./governance-conformance.ts` and the
// nine others in this directory, and the same reason: two independently written
// suites measure two things and agree by coincidence. This module drives one
// sequence of port calls and records what came back; a test runs it twice and
// compares verbatim. A divergence is then a named step with a value on each
// side.
//
// EVERY IDENTIFIER THE SCENARIO IS GIVEN IS A UUID, AND THAT IS THE FIRST THING
// THIS DIFFERENTIAL FOUND. `application/testing/builders.ts` mints
// `jobId: "job-0001"` and `rowId: "appr-row-0001"`; both satisfy every double in
// the context and both are refused by `@db.Uuid`, and every use-case suite in
// `packages/contexts/jobs` passes with them. The scenario is handed real ones by
// its environment, so a divergence here is a behaviour difference rather than a
// shape difference. The shape refusals have their own named cases in
// `jobs-constraints.integration.test.ts`.
//
// UNLIKE `governance`'s, THIS SCENARIO CARRIES ITS OWN INSTANTS. Neither of
// these ports mints one: `insertJob` is handed a whole `Job` and
// `insertApproval` a whole `Approval`, each already carrying its `createdAt` and
// `updatedAt`. So the ORDER a listing returns is decided by values the scenario
// wrote, not by either store's clock — which is why `conformanceClock` below
// advances a whole second per reading rather than a millisecond: `createdAt` is
// `TIMESTAMP(3)` and every listing here breaks its tie on `id`, and a scenario
// whose rows tie would be comparing two arbitrary orders.
//
// FIVE THINGS ARE DELIBERATELY NOT IN THIS SCENARIO, because on each the double
// is WRONG rather than different, and a conformance run is for comparing
// answers:
//
//   A SECOND INSERT OF THE SAME ROW. `InMemoryApprovalsRepository.insertApproval`
//   APPENDS, leaving two rows with one `rowId` and `findByRowId` answering the
//   first — a state the primary key cannot hold. `InMemoryJobsRepository` does
//   check the `(environmentId, externalId)` clash, but not the id, and
//   overwrites in place.
//
//   A LISTING WITH NO `sinceDays`. The double applies NO date filter at all,
//   and the live `list` this store reproduces defaults to a 30-day window
//   measured back from NOW — so a scenario whose rows are stamped in the past
//   would be asking the two stores different questions. Every listing here
//   passes a window wide enough to hold every row it wrote, and the default is
//   pinned against the real database instead.
//
//   A NEGATIVE OR ZERO `limit`. The double answers `query.limit ?? 50` without
//   looking at the value; PostgreSQL reads a negative `take` as "page backwards
//   from the offset". This store refuses it under its own code.
//
//   AN `ApprovalEdit` WHOSE `editedArguments` IS JSON `null`. The live envelope
//   stores that in the same field it stores the ABSENCE of an edit in, so the
//   two are one row and a round trip turns the first into the second. It is
//   refused rather than lost; `jobs-guards.ts` says why at length.
//
//   A `Job` WHOSE `payloadSchema` IS AN ARRAY. The domain field is
//   `JsonValue | null` and `Job_payloadSchema_json_root` admits an object or SQL
//   NULL. The double stores an array happily.
//
// All five are pinned against the real database instead, and all five are
// reported.

import type {
  Approval,
  ApprovalId,
  ApprovalRowId,
  AgentId,
  EnvironmentScope,
  Job,
  JobId,
  JobKey,
  Result,
  ThreadId,
  TransactionScope,
  TurnId,
} from "@platos/context-jobs/application/ports/index.js";
import { asIdentifier } from "@platos/context-jobs/application/ports/index.js";
import type { NotResult } from "@platos/context-jobs/application/ports/index.js";
import { runResult } from "@platos/context-jobs/application/ports/index.js";

import { runApprovalConformance } from "./jobs-conformance-approvals.js";
import type { JobsStores } from "./jobs-repository.js";

/** Every identifier the scenario needs. All uuids; both stores use the same. */
export interface JobsConformanceIds {
  readonly agentId: string;
  readonly threadId: string;
  readonly turnId: string;
  readonly secondTurnId: string;
  /** Three job rows and four approval rows, minted by the suite as uuids. */
  readonly jobIds: readonly [string, string, string];
  readonly approvalRowIds: readonly [string, string, string, string];
  /** A uuid of the right SHAPE that names no row. Every miss uses it. */
  readonly absentId: string;
}

export interface JobsConformanceEnvironment {
  readonly stores: JobsStores;
  readonly scope: EnvironmentScope;
  readonly ids: JobsConformanceIds;
  /** Open one transaction. The doubles' stand-in, or the adapter's unit of work. */
  run<Value>(work: (transaction: TransactionScope) => Promise<NotResult<Value>>): Promise<Value>;
}

export type JobsObservation = Record<string, unknown>;

/**
 * A clock that advances one SECOND per reading.
 *
 * A whole second rather than a millisecond because `createdAt` is
 * `TIMESTAMP(3)`: at millisecond resolution the driver's own rounding is the
 * only thing between two rows and a tie, and a paged listing whose order is not
 * total repeats rows on one page and drops them from the next. Both stores are
 * handed the SAME instants, because both are handed whole aggregates that
 * already carry them.
 */
export function conformanceClock(): () => Date {
  let tick = Date.parse("2026-05-01T09:00:00.000Z");
  return () => {
    tick += 1000;
    return new Date(tick);
  };
}

/** The window every listing in this scenario asks for. See the header. */
export const WIDE_WINDOW_DAYS = 36_500;

/**
 * A `Result`, reduced to what compares across two stores.
 *
 * Exported because `jobs-conformance-approvals.ts` records into the same map and
 * must reduce a `Result` the SAME way — a second projection written beside the
 * first is how two halves of one transcript come to disagree about what "an
 * error" looks like.
 */
export function outcome<Value>(
  result: Result<Value>,
  project: (value: Value) => unknown,
): Record<string, unknown> {
  if (result.ok) return { ok: true, value: project(result.value) };
  return {
    ok: false,
    code: result.error.code,
    category: result.error.category,
    reason: result.error.details["reason"] ?? null,
  };
}

/** Every field of a `Job`, so a round trip that loses one is a divergence. */
export function projectJob(job: Job): Record<string, unknown> {
  return {
    jobId: job.jobId,
    jobKey: job.jobKey,
    displayName: job.displayName,
    description: job.description,
    invocationType: job.invocationType,
    scheduleCron: job.schedule.cron,
    scheduleTimezone: job.schedule.timezone,
    allowedAgentIds: [...job.allowedAgentIds],
    payloadSchema: job.payloadSchema,
    handler: job.handler,
    timeoutSeconds: job.budget.timeoutSeconds,
    maxRetries: job.budget.maxRetries,
    status: job.status,
    createdBy: job.createdBy,
    lastStartedAt: job.lastStartedAt,
    createdAt: job.createdAt,
    updatedAt: job.updatedAt,
  };
}

function maybeJob(job: Job | null): unknown {
  return job === null ? null : projectJob(job);
}

/** A well-formed job, with everything but the axes under test held fixed. */
export function conformanceJob(
  ids: JobsConformanceIds,
  index: 0 | 1 | 2,
  at: Date,
  overrides: Partial<Job> = {},
): Job {
  return {
    jobId: asIdentifier<JobId>(ids.jobIds[index]),
    jobKey: asIdentifier<JobKey>("nightly-rollup"),
    displayName: "Nightly rollup",
    description: null,
    invocationType: "manual",
    schedule: { cron: null, timezone: null },
    allowedAgentIds: [],
    payloadSchema: null,
    handler: "async function run(payload, ctx) { return { ok: true }; }",
    budget: { timeoutSeconds: 300, maxRetries: 3 },
    status: "active",
    createdBy: "operator-1",
    lastStartedAt: null,
    createdAt: at,
    updatedAt: at,
    ...overrides,
  };
}

/**
 * Drive the whole scenario and record what came back.
 *
 * The sequence is fixed and the observations are keyed by STEP NAME, so a
 * divergence names the call rather than an index into an array.
 */
export async function runJobsConformance(
  environment: JobsConformanceEnvironment,
): Promise<JobsObservation> {
  const { stores, scope, ids } = environment;
  const observed: JobsObservation = {};
  const clock = conformanceClock();
  const agentId = asIdentifier<AgentId>(ids.agentId);
  const absentJobId = asIdentifier<JobId>(ids.absentId);

  // ------------------------------------------------------------------ jobs
  const scheduled = conformanceJob(ids, 1, clock(), {
    jobKey: asIdentifier<JobKey>("hourly-sweep"),
    displayName: "Hourly sweep",
    description: "sweeps the queue",
    invocationType: "schedule",
    schedule: { cron: "0 * * * *", timezone: "Europe/London" },
    allowedAgentIds: [agentId],
    payloadSchema: { type: "object", properties: { since: { type: "string" } } },
    budget: { timeoutSeconds: 90, maxRetries: 0 },
  });
  const unnamed = conformanceJob(ids, 2, clock(), {
    jobKey: null,
    displayName: "Never registered",
    status: "registration-failed",
    handler: "function ( {",
  });
  const nightly = conformanceJob(ids, 0, clock());

  observed["jobs.insert.scheduled"] = outcome(
    await runResult(environment, (transaction) => stores.jobs.insertJob(scope, scheduled, transaction)),
    projectJob,
  );
  observed["jobs.insert.unnamed"] = outcome(
    await runResult(environment, (transaction) => stores.jobs.insertJob(scope, unnamed, transaction)),
    projectJob,
  );
  observed["jobs.insert.nightly"] = outcome(
    await runResult(environment, (transaction) => stores.jobs.insertJob(scope, nightly, transaction)),
    projectJob,
  );

  // THE KEY CLASH. Both stores refuse a second job carrying a key that is
  // already taken in this environment, and both refuse it with the same code and
  // the same reason — the double's own string is what this store's zero-count
  // branch reports, deliberately, because the port has one error to return.
  observed["jobs.insert.duplicateKey"] = outcome(
    await runResult(environment, (transaction) =>
      stores.jobs.insertJob(
        scope,
        conformanceJob(ids, 0, clock(), {
          jobId: asIdentifier<JobId>(ids.absentId),
          jobKey: asIdentifier<JobKey>("nightly-rollup"),
        }),
        transaction,
      ),
    ),
    projectJob,
  );

  observed["jobs.find.byId"] = outcome(
    await stores.jobs.findJob(scope, asIdentifier<JobId>(ids.jobIds[1])),
    maybeJob,
  );
  observed["jobs.find.absent"] = outcome(await stores.jobs.findJob(scope, absentJobId), maybeJob);
  observed["jobs.find.byKey"] = outcome(
    await stores.jobs.findJobByKey(scope, asIdentifier<JobKey>("nightly-rollup")),
    maybeJob,
  );
  observed["jobs.find.byAbsentKey"] = outcome(
    await stores.jobs.findJobByKey(scope, asIdentifier<JobKey>("no-such-job")),
    maybeJob,
  );

  observed["jobs.list.all"] = outcome(await stores.jobs.listJobs(scope), (jobs) =>
    jobs.map((job) => [job.jobId, job.jobKey, job.status]),
  );

  const renamed: Job = { ...nightly, displayName: "Nightly rollup (v2)", updatedAt: clock() };
  observed["jobs.update.rename"] = outcome(
    await runResult(environment, (transaction) => stores.jobs.updateJob(scope, renamed, transaction)),
    projectJob,
  );
  observed["jobs.update.readBack"] = outcome(
    await stores.jobs.findJob(scope, renamed.jobId),
    maybeJob,
  );
  observed["jobs.update.absent"] = outcome(
    await runResult(environment, (transaction) =>
      stores.jobs.updateJob(
        scope,
        { ...nightly, jobId: absentJobId, jobKey: null },
        transaction,
      ),
    ),
    projectJob,
  );

  const startedAt = clock();
  observed["jobs.markStarted.active"] = outcome(
    await stores.jobs.markStarted(scope, nightly.jobId, startedAt),
    (moved) => moved,
  );
  observed["jobs.markStarted.readBack"] = outcome(
    await stores.jobs.findJob(scope, nightly.jobId),
    maybeJob,
  );
  // GUARDED ON `ACTIVE`: the registration-failed row does not get a
  // `lastStartedAt` that says a run began.
  observed["jobs.markStarted.inactive"] = outcome(
    await stores.jobs.markStarted(scope, unnamed.jobId, clock()),
    (moved) => moved,
  );
  observed["jobs.markStarted.absent"] = outcome(
    await stores.jobs.markStarted(scope, absentJobId, clock()),
    (moved) => moved,
  );

  observed["jobs.delete.first"] = outcome(
    await runResult(environment, (transaction) =>
      stores.jobs.deleteJob(scope, unnamed.jobId, transaction),
    ),
    (removed) => removed,
  );
  observed["jobs.delete.again"] = outcome(
    await runResult(environment, (transaction) =>
      stores.jobs.deleteJob(scope, unnamed.jobId, transaction),
    ),
    (removed) => removed,
  );
  observed["jobs.delete.readBack"] = outcome(await stores.jobs.listJobs(scope), (jobs) =>
    jobs.map((job) => job.jobKey),
  );

  // ------------------------------------------------------------- approvals
  await runApprovalConformance(environment, observed, clock, {
    agentId,
    threadId: asIdentifier<ThreadId>(ids.threadId),
    turnId: asIdentifier<TurnId>(ids.turnId),
    secondTurnId: asIdentifier<TurnId>(ids.secondTurnId),
    rowIds: [
      asIdentifier<ApprovalRowId>(ids.approvalRowIds[0]),
      asIdentifier<ApprovalRowId>(ids.approvalRowIds[1]),
      asIdentifier<ApprovalRowId>(ids.approvalRowIds[2]),
      asIdentifier<ApprovalRowId>(ids.approvalRowIds[3]),
    ],
    absentApprovalId: asIdentifier<ApprovalId>("appr-does-not-exist"),
    absentRowId: asIdentifier<ApprovalRowId>(ids.absentId),
  });

  return observed;
}

/** What an `Approval` step needs from the scenario's identifiers. */
export interface ApprovalConformanceIds {
  readonly agentId: AgentId;
  readonly threadId: ThreadId;
  readonly turnId: TurnId;
  readonly secondTurnId: TurnId;
  readonly rowIds: readonly [ApprovalRowId, ApprovalRowId, ApprovalRowId, ApprovalRowId];
  readonly absentApprovalId: ApprovalId;
  readonly absentRowId: ApprovalRowId;
}

/** Every field of an `Approval`, so a round trip that loses one is a divergence. */
export function projectApproval(approval: Approval): Record<string, unknown> {
  return {
    rowId: approval.rowId,
    approvalId: approval.approvalId,
    source: approval.source,
    agentId: approval.agentId,
    threadId: approval.threadId,
    turnId: approval.turnId,
    action: approval.action,
    details: approval.details,
    toolName: approval.toolName,
    arguments: approval.arguments,
    requestedBy: approval.requestedBy,
    requestDigest: approval.requestDigest,
    requestedByTokenId: approval.requestedByTokenId,
    status: approval.status,
    timeoutSeconds: approval.timeoutSeconds,
    createdAt: approval.createdAt,
    updatedAt: approval.updatedAt,
    resolution:
      approval.resolution === null
        ? null
        : {
            status: approval.resolution.status,
            respondedBy: approval.resolution.respondedBy,
            comment: approval.resolution.comment,
            resolvedAt: approval.resolution.resolvedAt,
            edit:
              approval.resolution.edit === null
                ? null
                : {
                    editedArguments: approval.resolution.edit.editedArguments,
                    editedBy: approval.resolution.edit.editedBy,
                  },
          },
    consumedAt: approval.consumedAt,
    outcome: approval.outcome,
  };
}
