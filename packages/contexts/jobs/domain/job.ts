// The `Job` aggregate — the Platos-side record of a unit of durable work.
//
// A `Job` is a DEFINITION, not a run. It carries the handler source, how it may
// be started, who may start it, and its execution budget. The runs themselves
// live behind the kernel's `DurableRuntime` port and are owned by the
// durable-runtime adapter (ADR M0.3 §1, context 11), which is why nothing here
// has a run id, an execution count or a state machine over runs.
//
// STATUS IS NOT A LIFECYCLE. The baseline `WorkStatus` enum has five members and
// a `Job` row only ever holds two of them: `ACTIVE`, or `FAILED` when its handler
// failed to parse at registration. `PENDING`, `SUCCEEDED` and `CANCELLED` are
// members of the shared enum used by other tables. Modelling all five here would
// invent transitions the system does not have, so this module models exactly the
// two that occur and names the rest as what they are.

import { err, ok, type JsonValue, type Result } from "@platos/kernel";

import { jobNotFoundOrInactive, jobNotRegistered } from "./errors.js";
import type { AgentId, JobId, JobKey } from "./identifiers.js";
import type { StoredInvocationType } from "./invocation.js";

/**
 * The `WorkStatus` values a `Job` row actually takes.
 *
 * `registration-failed` is the domain name for the row the live MCP tool writes
 * as `status: "FAILED"` when `checkSyntax` rejects the handler. The row is kept
 * rather than discarded so the author can see why, which is why it is a status
 * and not an absent row.
 */
export type JobStatus = "active" | "registration-failed";

/** The two-way mapping to the persisted `WorkStatus` enum, kept in one place. */
export const JOB_STATUS_TO_STORED: Readonly<Record<JobStatus, "ACTIVE" | "FAILED">> = Object.freeze({
  active: "ACTIVE",
  "registration-failed": "FAILED",
});

export interface JobSchedule {
  /** A cron expression. Meaningful only for a `schedule` job. */
  readonly cron: string | null;
  /** An IANA zone name. Null means the host default, never "UTC". */
  readonly timezone: string | null;
}

export interface JobExecutionBudget {
  /** Seconds. The live column default is 300. */
  readonly timeoutSeconds: number;
  /** The live column default is 0; the MCP create path passes 3. */
  readonly maxRetries: number;
}

export interface Job {
  readonly jobId: JobId;
  /**
   * Null for a row that was never given a registered name. Such a row can be
   * read and listed but never dispatched — see `assertDispatchable`.
   */
  readonly jobKey: JobKey | null;
  readonly displayName: string;
  readonly description: string | null;
  readonly invocationType: StoredInvocationType;
  readonly schedule: JobSchedule;
  /** Empty means "any agent". A populated list is a restriction. */
  readonly allowedAgentIds: readonly AgentId[];
  /** A JSON Schema describing admissible payloads, or null. Never executed. */
  readonly payloadSchema: JsonValue | null;
  /** The handler source. Executed only inside the sandbox port. */
  readonly handler: string;
  readonly budget: JobExecutionBudget;
  readonly status: JobStatus;
  readonly createdBy: string;
  readonly lastStartedAt: Date | null;
  readonly createdAt: Date;
  readonly updatedAt: Date;
}

export function isActive(job: Job): boolean {
  return job.status === "active";
}

/**
 * A job that is merely `active` is not yet runnable. The live execute path
 * additionally requires a registered name that still satisfies the key rule and
 * a handler that is not blank:
 *
 *     if (!job.externalId || !REGISTERED_JOB_ID_RE.test(job.externalId) ||
 *         !job.handler.trim()) return failure(422, "JOB_NOT_REGISTERED");
 *
 * The key is re-checked at dispatch and not trusted from the row, because a row
 * predating a narrowing of the rule would otherwise stay dispatchable forever.
 */
export function assertDispatchable(job: Job, keyIsValid: (value: string) => boolean): Result<JobKey> {
  if (!isActive(job)) return err(jobNotFoundOrInactive(job.jobId));
  if (job.jobKey === null) return err(jobNotRegistered("job has no registered key"));
  if (!keyIsValid(job.jobKey)) return err(jobNotRegistered("job key no longer satisfies the key rule"));
  if (job.handler.trim().length === 0) return err(jobNotRegistered("job has no handler source"));
  return ok(job.jobKey);
}

/**
 * The effective timeout of one execution, in milliseconds.
 *
 * `Math.min(Math.max(timeoutSeconds, 1) * 1000, MAX_JOB_TIMEOUT_MS)` in the live
 * service. The floor stops a zero or negative column value from producing an
 * instant timeout; the ceiling is below the platform's own request budget so the
 * sandbox is always the thing that gives up first, and the caller gets
 * `JOB_TIMEOUT` rather than a severed connection.
 */
export const MAX_JOB_TIMEOUT_MS = 580_000;

export function effectiveTimeoutMs(budget: JobExecutionBudget): number {
  return Math.min(Math.max(budget.timeoutSeconds, 1) * 1000, MAX_JOB_TIMEOUT_MS);
}

/** Record that a run began. The live service writes this after a successful run. */
export function withLastStartedAt(job: Job, startedAt: Date): Job {
  return { ...job, lastStartedAt: startedAt, updatedAt: startedAt };
}
