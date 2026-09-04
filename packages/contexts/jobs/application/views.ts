// Projecting the aggregates onto the shapes the contract publishes.
//
// A VIEW IS NOT A ROW. `JobView` deliberately omits `handler`: the source is the
// most sensitive column this context owns and the live `publicJob(job,
// includeHandler)` makes including it an explicit, per-call decision. Making the
// safe projection the DEFAULT and the revealing one a separate function means a
// new call site leaks nothing by omission.
//
// TIME IS A PARAMETER. `secondsRemaining` and `expired` are computed against a
// supplied instant rather than the wall clock, so a rendered approval is
// reproducible in a test and two fields of one view cannot be computed a
// millisecond apart.

import type { JsonValue } from "@platos/kernel";

import {
  deadlineOf,
  hasElapsed,
  isPending,
  secondsRemaining,
  type Approval,
  type ApprovalStatus,
  type Job,
  type StoredInvocationType,
} from "../domain/index.js";

export interface JobView {
  readonly id: string;
  /** The registered key, falling back to the row id — the live `publicJob`. */
  readonly jobId: string;
  readonly displayName: string;
  readonly description: string | null;
  readonly invocationType: StoredInvocationType;
  readonly scheduleCron: string | null;
  readonly scheduleTimezone: string | null;
  readonly allowedAgentIds: readonly string[];
  readonly payloadSchema: JsonValue | null;
  readonly timeoutSeconds: number;
  readonly maxRetries: number;
  readonly isActive: boolean;
  readonly createdBy: string;
  readonly lastStartedAt: Date | null;
  readonly createdAt: Date;
  readonly updatedAt: Date;
}

export function toJobView(job: Job): JobView {
  return {
    id: job.jobId,
    jobId: job.jobKey ?? job.jobId,
    displayName: job.displayName,
    description: job.description,
    invocationType: job.invocationType,
    scheduleCron: job.schedule.cron,
    scheduleTimezone: job.schedule.timezone,
    allowedAgentIds: job.allowedAgentIds,
    payloadSchema: job.payloadSchema,
    timeoutSeconds: job.budget.timeoutSeconds,
    maxRetries: job.budget.maxRetries,
    isActive: job.status === "active",
    createdBy: job.createdBy,
    lastStartedAt: job.lastStartedAt,
    createdAt: job.createdAt,
    updatedAt: job.updatedAt,
  };
}

/** The view WITH the handler source. Every call site is a deliberate one. */
export interface JobSourceView extends JobView {
  readonly handler: string;
}

export function toJobSourceView(job: Job): JobSourceView {
  return { ...toJobView(job), handler: job.handler };
}

export interface ApprovalView {
  readonly id: string;
  readonly approvalId: string;
  readonly source: string;
  readonly agentId: string | null;
  readonly threadId: string | null;
  readonly turnId: string | null;
  readonly action: string;
  readonly details: string | null;
  readonly toolName: string | null;
  readonly arguments: JsonValue | null;
  readonly requestedBy: string | null;
  readonly status: ApprovalStatus;
  readonly timeoutSeconds: number;
  readonly createdAt: Date;
  readonly updatedAt: Date;
  readonly resolvedAt: Date | null;
  readonly respondedBy: string | null;
  readonly comment: string | null;
  /** Null once the approval is no longer pending — the live semantics. */
  readonly deadlineAt: Date | null;
  readonly secondsRemaining: number | null;
  readonly expired: boolean;
  readonly editedArguments: JsonValue | null;
  readonly editedBy: string | null;
  readonly consumedAt: Date | null;
  readonly outcome: JsonValue | null;
}

export function toApprovalView(approval: Approval, now: Date): ApprovalView {
  const pending = isPending(approval);
  return {
    id: approval.rowId,
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
    status: approval.status,
    timeoutSeconds: approval.timeoutSeconds,
    createdAt: approval.createdAt,
    updatedAt: approval.updatedAt,
    resolvedAt: approval.resolution?.resolvedAt ?? null,
    respondedBy: approval.resolution?.respondedBy ?? null,
    comment: approval.resolution?.comment ?? null,
    deadlineAt: pending ? deadlineOf(approval) : null,
    secondsRemaining: secondsRemaining(approval, now),
    expired: hasElapsed(approval, now),
    editedArguments: approval.resolution?.edit?.editedArguments ?? null,
    editedBy: approval.resolution?.edit?.editedBy ?? null,
    consumedAt: approval.consumedAt,
    outcome: approval.outcome,
  };
}
