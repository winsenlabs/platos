// Use case: execute one registered job.
//
// THE ORDER OF THE FIVE STAGES IS THE SECURITY PROPERTY, and it is preserved
// exactly from the live service:
//
//   1. resolve the job inside the caller's scope        -> 404 if absent/inactive
//   2. is it dispatchable at all                        -> 422 if unregistered
//   3. may THIS caller start it                         -> 403 if not
//   4. reserve the request id                           -> 409/503 on contention
//   5. run it
//
// Authorization precedes reservation. Reserving first would let an unauthorized
// caller burn another caller's request id for seven days: the reservation
// survives the 403 and every later legitimate retry of that id would replay the
// failure. Running before reserving would defeat idempotency altogether.
//
// THE RESERVATION IS SETTLED ON EVERY PATH THAT REACHED IT, success or failure,
// so a retry replays the outcome rather than re-running the handler. A failure to
// settle is DELIBERATELY IGNORED — see `IdempotencyStore.settle`.

import { err, ok, type EnvironmentScope, type JsonValue, type Result } from "@platos/kernel";

import {
  authorizeAgent,
  authorizeInvocation,
  completedReservation,
  decideReplay,
  digestSubject,
  digestOf,
  effectiveTimeoutMs,
  failedReservation,
  isJobExecutionErrorCode,
  isJobKey,
  jobExecutionFailed,
  jobNotFoundOrInactive,
  jobResultRejected,
  jobTimeout,
  replayedExecutionFailure,
  runningReservation,
  assertDispatchable,
  IDEMPOTENCY_TTL_SECONDS,
  isAdmissibleJson,
  withinSizeCap,
  type ExecutionRequest,
  type Job,
  type RequestDigest,
} from "../domain/index.js";
import type { JobsDependencies } from "./dependencies.js";
import type { HandlerOutcome, IdempotencyKey } from "./ports/index.js";

export interface ExecuteJobCommand {
  readonly scope: EnvironmentScope;
  readonly request: ExecutionRequest;
}

export interface ExecuteJobResult {
  readonly value: JsonValue | null;
  /** True when this outcome came from a reservation rather than a fresh run. */
  readonly replayed: boolean;
}

/** Resolve the job and prove this caller may start it. Stages 1-3. */
async function authorize(
  dependencies: JobsDependencies,
  command: ExecuteJobCommand,
): Promise<Result<Job>> {
  const found = await dependencies.jobs.findJob(command.scope, command.request.jobId);
  if (!found.ok) return err(found.error);
  const job = found.value;
  if (job === null) return err(jobNotFoundOrInactive(command.request.jobId));

  const dispatchable = assertDispatchable(job, isJobKey);
  if (!dispatchable.ok) return err(dispatchable.error);

  const invocation = authorizeInvocation(command.request.invokedBy, job.invocationType);
  if (!invocation.ok) return err(invocation.error);

  const agent = authorizeAgent(command.request.invokedBy, job.allowedAgentIds, command.request.agentId);
  if (!agent.ok) return err(agent.error);

  return ok(job);
}

/** Translate a terminal handler outcome into this context's vocabulary. */
function classify(
  dependencies: JobsDependencies,
  outcome: HandlerOutcome,
  timeoutMs: number,
): Result<JsonValue | null> {
  switch (outcome.kind) {
    case "timed-out":
      return err(jobTimeout(timeoutMs));
    case "result-rejected":
      return err(jobResultRejected(outcome.reason));
    case "failed":
      return err(jobExecutionFailed(outcome.reason));
    case "completed": {
      const value = outcome.value;
      if (value === null) return ok(null);
      // The result is re-admitted against the SAME rules as the payload: a
      // handler is untrusted code, and its output is persisted and replayed.
      if (!isAdmissibleJson(value, dependencies.knownSecrets)) {
        return err(jobResultRejected("result is not admissible"));
      }
      if (!withinSizeCap(value)) return err(jobResultRejected("result exceeds the size cap"));
      return ok(value);
    }
  }
}

async function runHandler(
  dependencies: JobsDependencies,
  command: ExecuteJobCommand,
  job: Job,
): Promise<Result<JsonValue | null>> {
  const timeoutMs = effectiveTimeoutMs(job.budget);
  const outcome = await dependencies.handlers.run({
    source: job.handler,
    jobKey: job.jobKey ?? job.jobId,
    payload: command.request.payload,
    timeoutMs,
  });
  if (!outcome.ok) return err(outcome.error);

  const classified = classify(dependencies, outcome.value, timeoutMs);
  if (!classified.ok) return err(classified.error);

  // Bookkeeping only. The live service discards this failure explicitly, and so
  // does this: a run that succeeded is not retroactively failed because a
  // timestamp column did not update.
  await dependencies.jobs.markStarted(command.scope, job.jobId, dependencies.clock.now());
  return ok(classified.value);
}

export async function executeJob(
  dependencies: JobsDependencies,
  command: ExecuteJobCommand,
): Promise<Result<ExecuteJobResult>> {
  const authorized = await authorize(dependencies, command);
  if (!authorized.ok) return err(authorized.error);

  const digest = digestOf(dependencies.digest, digestSubject(command.request));
  const key: IdempotencyKey = {
    environmentId: command.scope.environmentId,
    requestId: command.request.requestId,
  };

  const reserved = await dependencies.idempotency.reserve(
    key,
    runningReservation(digest),
    IDEMPOTENCY_TTL_SECONDS,
  );
  if (!reserved.ok) return err(reserved.error);

  if (reserved.value.kind === "held") {
    const replay = decideReplay(reserved.value.held, digest);
    if (!replay.ok) return err(replay.error);
    if (replay.value.kind === "replay-success") {
      return ok({ value: replay.value.result, replayed: true });
    }
    return err(replayedExecutionFailure(replay.value.code));
  }

  const outcome = await runHandler(dependencies, command, authorized.value);
  await settle(dependencies, key, digest, outcome);

  if (!outcome.ok) return err(outcome.error);
  return ok({ value: outcome.value, replayed: false });
}

/**
 * Record the terminal state against the reservation.
 *
 * A failure is cached ONLY when its code is one of the eleven inherited
 * execution codes. Anything else — a repository or sandbox-port error — leaves
 * the `running` reservation to expire on its own, which is the fail-closed
 * behaviour: a caller retrying that id is told `IDEMPOTENCY_IN_PROGRESS` rather
 * than being handed a cached failure whose code it was never promised. Casting an
 * arbitrary port error into the execution union instead would put an
 * unrecognisable code on the wire under a contract that says the set is closed.
 *
 * The settle result is discarded on purpose; see `IdempotencyStore.settle`.
 */
async function settle(
  dependencies: JobsDependencies,
  key: IdempotencyKey,
  digest: RequestDigest,
  outcome: Result<JsonValue | null>,
): Promise<void> {
  if (outcome.ok) {
    await dependencies.idempotency.settle(
      key,
      completedReservation(digest, outcome.value),
      IDEMPOTENCY_TTL_SECONDS,
    );
    return;
  }
  if (!isJobExecutionErrorCode(outcome.error.code)) return;
  await dependencies.idempotency.settle(
    key,
    failedReservation(digest, outcome.error.code),
    IDEMPOTENCY_TTL_SECONDS,
  );
}
