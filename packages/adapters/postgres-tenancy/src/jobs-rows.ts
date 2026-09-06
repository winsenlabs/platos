// Stored rows to domain aggregates, and the envelope the canonical schema has
// no columns for.
//
// TEN OF `Approval`'s TWENTY FIELDS HAVE NO COLUMN. `AgentApproval` predates the
// approval model this context extracted: the table carries an `action`, a
// `status`, a `timeoutSeconds` and four foreign keys, and the live service put
// everything else — the business `approvalId`, the `source`, who asked, the
// dedupe digest, the MCP token, the consumption instant and the human's edits —
// inside the `arguments` JSON under `__platosApproval`, with the caller's own
// arguments beside it under `value`. That is a WIRE FORMAT, not an
// implementation detail: rows written by `apps/agent` are in the database right
// now and rows written here have to be readable by it, so the marker, the key
// names and the shape are reproduced exactly rather than improved.
//
// A ROW WITHOUT THE MARKER IS A LEGACY ROW, AND IT IS READ RATHER THAN REFUSED.
// The whole object is then the caller's arguments and the ten carried fields
// take their absent values. That differs from the live `readArguments`, which
// answers `value: null` for such a row and therefore DISCARDS its arguments on
// every read; discarding a column this port's own round-trip contract promises
// to return is data loss, so it is not reproduced. The divergence is deliberate,
// is in one direction only — this store shows a row's arguments where the live
// dashboard showed none — and is reported.
//
// `Approval.outcome` RIDES IN ITS OWN ENVELOPE, and for a reason the metadata
// does not have. `AgentApproval_resolution_json_root` admits an OBJECT or SQL
// NULL, and `outcome` is `JsonValue | null` — so an array, a string and a number
// are all values the port admits and the column refuses. The live
// `markMcpConsumed` wraps a non-object as `{ value: x }`, which is
// indistinguishable on read from an outcome that IS `{ value: x }`. This store
// wraps EVERY outcome under `__platosOutcome` instead, so the unwrap is total,
// and reads an object without the marker as itself — which is exactly how a row
// the live path wrote comes back, lossily but honestly, as the object it holds.
//
// THREE STORED VOCABULARIES ARE VALIDATED, NOT CAST. `Job.status` is the
// FIVE-member `WorkStatus` enum of which a `Job` row only ever holds two,
// `Job.triggerType` is a plain `TEXT` column whose closed set lives only in
// `domain/invocation.ts`, and `AgentApproval.status` is a four-member enum whose
// `EXPIRED` member is the one pair in the whole vocabulary that does not match
// its domain name. A store that cast any of the three would put a value outside
// its union into `assertDispatchable` or `authorizeInvocation`, whose tables are
// keyed BY the union — and an unknown invocation type would then authorize
// nothing while reporting no error at all.

import type {
  AgentId,
  Approval,
  ApprovalDecision,
  ApprovalEdit,
  ApprovalResolution,
  ApprovalRowId,
  ApprovalId,
  ApprovalSource,
  ApprovalStatus,
  EnvironmentScope,
  Job,
  JobId,
  JobKey,
  JsonValue,
  StoredInvocationType,
  TenantScope,
  ThreadId,
  TurnId,
} from "@platos/context-jobs/application/ports/index.js";
import {
  asIdentifier,
  fromStoredStatus,
  isStoredInvocationType,
} from "@platos/context-jobs/application/ports/index.js";

import { UnreadableRowError } from "./mapping.js";

/** `Job.status` holds a `WorkStatus` member a `Job` row never takes. */
export const JOBS_UNKNOWN_WORK_STATUS = "jobs.row.unknown_work_status";

/** `Job.triggerType` holds an invocation type this binary does not know. */
export const UNKNOWN_INVOCATION_TYPE = "jobs.row.unknown_invocation_type";

/** `AgentApproval.status` holds a value outside the four-member vocabulary. */
export const UNKNOWN_APPROVAL_STATUS = "jobs.row.unknown_approval_status";

/** `AgentApproval.arguments` holds an envelope this binary cannot decode. */
export const UNREADABLE_APPROVAL_ENVELOPE = "jobs.row.unreadable_approval_envelope";

/** `Job.payloadSchema` holds something the `_json_root` CHECK would refuse. */
export const UNREADABLE_PAYLOAD_SCHEMA = "jobs.row.unreadable_payload_schema";

/** The discriminator that tells this store's outcome envelope from a legacy value. */
export const APPROVAL_OUTCOME_MARKER = "__platosOutcome";

/**
 * The live metadata marker, verbatim.
 *
 * `apps/agent/src/monitoring/approvals.service.ts` writes and reads this exact
 * key, and rows carrying it are in the database. Renaming it would make every
 * approval in flight at cutover unfindable by `findByApprovalId`, which resolves
 * a business id through this very path.
 */
export const APPROVAL_METADATA_MARKER = "__platosApproval";

/** Restrict a read to one environment. Every scoped read in both stores uses it. */
export function scopedWhere(scope: EnvironmentScope): { readonly environmentId: string } {
  return { environmentId: scope.environmentId };
}

/**
 * Restrict a read to the environments a TENANT scope reaches.
 *
 * An erasure addresses a subject at an organization, a project or an
 * environment, and `AgentApproval` stores exactly one `environmentId`. The
 * containment is therefore a RELATION filter through `Environment` and
 * `Project`, resolved by the database in the SAME statement — not a widening
 * read of the tree followed by an `IN` list, which is the N+1 this shape is easy
 * to write by accident, and which `domain/scope.ts` names as the thing
 * `environmentFallsWithin` exists to keep out of callers.
 */
export function tenantWhere(scope: TenantScope): Record<string, unknown> {
  if (scope.level === "environment") return { environmentId: scope.environmentId };
  if (scope.level === "project") return { environment: { projectId: scope.projectId } };
  return { environment: { project: { organizationId: scope.organizationId } } };
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

// -------------------------------------------------------------------- Job

export interface JobRow {
  readonly id: string;
  readonly environmentId: string;
  readonly externalId: string | null;
  readonly displayName: string;
  readonly description: string | null;
  readonly invocationType: string;
  readonly scheduleCron: string | null;
  readonly scheduleTimezone: string | null;
  readonly allowedAgentIds: readonly string[] | null;
  readonly payloadSchema: unknown;
  readonly handler: string;
  readonly timeoutSeconds: number;
  readonly maxRetries: number;
  readonly status: string;
  readonly createdBy: string;
  readonly lastStartedAt: Date | null;
  readonly createdAt: Date;
  readonly updatedAt: Date;
}

/**
 * `WorkStatus` -> `JobStatus`, as a total function over the FIVE stored members.
 *
 * `domain/job.ts` models exactly the two a `Job` row takes and names the other
 * three as what they are: "members of the shared enum used by other tables". A
 * row holding one of them is not a job this binary can describe — every
 * predicate in that module is written over two states — so it is refused by
 * name rather than mapped to whichever of the two looks closest.
 */
export function readJobStatus(value: string): "active" | "registration-failed" {
  if (value === "ACTIVE") return "active";
  if (value === "FAILED") return "registration-failed";
  throw new UnreadableRowError(JOBS_UNKNOWN_WORK_STATUS, "Job.status", value);
}

export function readInvocationType(value: string): StoredInvocationType {
  if (!isStoredInvocationType(value)) {
    throw new UnreadableRowError(UNKNOWN_INVOCATION_TYPE, "Job.triggerType", value);
  }
  return value;
}

/**
 * `Job.payloadSchema`, validated against the CHECK rather than cast through it.
 *
 * `Job_payloadSchema_json_root` has admitted only an object or SQL NULL since
 * the initial migration, so this branch is reachable only from a row written
 * while the constraint was absent. It is still a validation and not a cast: an
 * expand/contract window in which a constraint is dropped and re-added is
 * exactly when a store must be able to say what it found.
 */
export function readPayloadSchema(value: unknown): JsonValue | null {
  if (value === null || value === undefined) return null;
  if (!isObject(value)) {
    throw new UnreadableRowError(UNREADABLE_PAYLOAD_SCHEMA, "Job.payloadSchema", typeof value);
  }
  return value as JsonValue;
}

export function readJob(row: JobRow): Job {
  return {
    jobId: asIdentifier<JobId>(row.id),
    jobKey: row.externalId === null ? null : asIdentifier<JobKey>(row.externalId),
    displayName: row.displayName,
    description: row.description,
    invocationType: readInvocationType(row.invocationType),
    schedule: { cron: row.scheduleCron, timezone: row.scheduleTimezone },
    // `allowedAgentIds TEXT[] DEFAULT ARRAY[]::TEXT[]` is declared WITHOUT
    // `NOT NULL` in the initial migration, so a row can hold SQL NULL where
    // `schema.prisma`'s `String[] @default([])` says it cannot. An empty list
    // and a null one mean the same thing to `authorizeAgent` — "any agent" —
    // so the null is read as the empty list rather than refused.
    allowedAgentIds: (row.allowedAgentIds ?? []).map((value) => asIdentifier<AgentId>(value)),
    payloadSchema: readPayloadSchema(row.payloadSchema),
    handler: row.handler,
    budget: { timeoutSeconds: row.timeoutSeconds, maxRetries: row.maxRetries },
    status: readJobStatus(row.status),
    createdBy: row.createdBy,
    lastStartedAt: row.lastStartedAt,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

// ---------------------------------------------------------- AgentApproval

/** The ten fields the canonical table has no column for, plus the arguments. */
export interface ApprovalEnvelope {
  readonly approvalId: string;
  readonly source: string;
  readonly requestedBy: string | null;
  readonly requestHash: string | null;
  readonly requestedByMcpTokenId: string | null;
  readonly consumedAt: string | null;
  readonly editedArgs: JsonValue | null;
  readonly editedByUserId: string | null;
  /** The caller's own arguments, stored beside the metadata under `value`. */
  readonly value: JsonValue | null;
}

/**
 * The absent envelope: what a row with no marker, and a row with no
 * `arguments` at all, both read as.
 *
 * `source` defaults to `request_approval` because that is what the live
 * `readArguments` falls back to, and a row that predates the marker was written
 * by the only path that existed then.
 */
const ABSENT_ENVELOPE: ApprovalEnvelope = Object.freeze({
  approvalId: "",
  source: "request_approval",
  requestedBy: null,
  requestHash: null,
  requestedByMcpTokenId: null,
  consumedAt: null,
  editedArgs: null,
  editedByUserId: null,
  value: null,
});

function optionalString(value: unknown, column: string): string | null {
  if (value === null || value === undefined) return null;
  if (typeof value !== "string") {
    throw new UnreadableRowError(UNREADABLE_APPROVAL_ENVELOPE, column, String(value));
  }
  return value;
}

function requiredString(value: unknown, column: string): string {
  if (typeof value !== "string") {
    throw new UnreadableRowError(UNREADABLE_APPROVAL_ENVELOPE, column, String(value));
  }
  return value;
}

export function readApprovalEnvelope(stored: unknown): ApprovalEnvelope {
  if (stored === null || stored === undefined) return ABSENT_ENVELOPE;
  if (!isObject(stored)) {
    throw new UnreadableRowError(
      UNREADABLE_APPROVAL_ENVELOPE,
      "AgentApproval.arguments",
      typeof stored,
    );
  }
  const metadata = stored[APPROVAL_METADATA_MARKER];
  if (metadata === undefined) {
    // A legacy row: the whole object is what the caller passed.
    return { ...ABSENT_ENVELOPE, value: stored as JsonValue };
  }
  if (!isObject(metadata)) {
    throw new UnreadableRowError(
      UNREADABLE_APPROVAL_ENVELOPE,
      `AgentApproval.arguments.${APPROVAL_METADATA_MARKER}`,
      typeof metadata,
    );
  }
  const value = stored["value"];
  return {
    approvalId: requiredString(metadata["approvalId"], "arguments.__platosApproval.approvalId"),
    source: requiredString(metadata["source"], "arguments.__platosApproval.source"),
    requestedBy: optionalString(metadata["requestedBy"], "arguments.__platosApproval.requestedBy"),
    requestHash: optionalString(metadata["requestHash"], "arguments.__platosApproval.requestHash"),
    requestedByMcpTokenId: optionalString(
      metadata["requestedByMcpTokenId"],
      "arguments.__platosApproval.requestedByMcpTokenId",
    ),
    consumedAt: optionalString(metadata["consumedAt"], "arguments.__platosApproval.consumedAt"),
    editedArgs: (metadata["editedArgs"] ?? null) as JsonValue | null,
    editedByUserId: optionalString(
      metadata["editedByUserId"],
      "arguments.__platosApproval.editedByUserId",
    ),
    value: (value === undefined ? null : value) as JsonValue | null,
  };
}

/** Rebuild the stored `arguments` column from an approval, losing nothing. */
export function writeApprovalEnvelope(approval: Approval): Record<string, unknown> {
  const edit = approval.resolution?.edit ?? null;
  return {
    [APPROVAL_METADATA_MARKER]: {
      approvalId: approval.approvalId,
      source: approval.source,
      requestedBy: approval.requestedBy,
      requestHash: approval.requestDigest,
      requestedByMcpTokenId: approval.requestedByTokenId,
      consumedAt: approval.consumedAt === null ? null : approval.consumedAt.toISOString(),
      editedArgs: edit === null ? null : edit.editedArguments,
      editedByUserId: edit === null ? null : edit.editedBy,
    },
    value: approval.arguments,
  };
}

/** The `resolution` column's payload for an outcome, or `null` for SQL NULL. */
export function writeApprovalOutcome(outcome: JsonValue | null): Record<string, unknown> | null {
  if (outcome === null) return null;
  return { [APPROVAL_OUTCOME_MARKER]: outcome };
}

/**
 * The stored `resolution` column, read back.
 *
 * An object carrying the marker is this store's envelope and unwraps totally. An
 * object without it is a row the live `markMcpConsumed` wrote — that path stored
 * an object outcome verbatim and wrapped a non-object as `{ value: x }` — and it
 * reads back as the object it holds, which is the most that can be recovered
 * from a wrapper that never said whether it was one.
 */
export function readApprovalOutcome(stored: unknown): JsonValue | null {
  if (stored === null || stored === undefined) return null;
  if (!isObject(stored)) return stored as JsonValue;
  if (Object.prototype.hasOwnProperty.call(stored, APPROVAL_OUTCOME_MARKER)) {
    return (stored[APPROVAL_OUTCOME_MARKER] ?? null) as JsonValue | null;
  }
  return stored as JsonValue;
}

export function readApprovalStatus(value: string): ApprovalStatus {
  const status = fromStoredStatus(value);
  if (status === null) {
    throw new UnreadableRowError(UNKNOWN_APPROVAL_STATUS, "AgentApproval.status", value);
  }
  return status;
}

export interface ApprovalRow {
  readonly id: string;
  readonly environmentId: string;
  readonly agentId: string | null;
  readonly threadId: string | null;
  readonly turnId: string | null;
  readonly action: string;
  readonly details: string | null;
  readonly status: string;
  readonly timeoutSeconds: number;
  readonly resolvedAt: Date | null;
  readonly respondedBy: string | null;
  readonly comment: string | null;
  readonly toolName: string | null;
  readonly arguments: unknown;
  readonly resolution: unknown;
  readonly createdAt: Date;
  readonly updatedAt: Date;
}

function readEdit(envelope: ApprovalEnvelope): ApprovalEdit | null {
  if (envelope.editedArgs === null) return null;
  return { editedArguments: envelope.editedArgs, editedBy: envelope.editedByUserId };
}

/**
 * The decision half of a row, present exactly when the status IS a decision.
 *
 * `resolvedAt` falls back to `updatedAt` rather than to null: the column is
 * nullable and a legacy row can hold a decided status with no instant beside it,
 * and `ApprovalResolution.resolvedAt` is not nullable. `resolveApproval` writes
 * the same instant to both, so for every row this store wrote the fallback is
 * unobservable.
 */
function readResolution(row: ApprovalRow, status: ApprovalStatus, envelope: ApprovalEnvelope): ApprovalResolution | null {
  if (status === "pending") return null;
  return {
    status: status as ApprovalDecision,
    respondedBy: row.respondedBy,
    comment: row.comment,
    resolvedAt: row.resolvedAt ?? row.updatedAt,
    edit: readEdit(envelope),
  };
}

function readConsumedAt(envelope: ApprovalEnvelope): Date | null {
  if (envelope.consumedAt === null) return null;
  const at = new Date(envelope.consumedAt);
  if (Number.isNaN(at.getTime())) {
    throw new UnreadableRowError(
      UNREADABLE_APPROVAL_ENVELOPE,
      "arguments.__platosApproval.consumedAt",
      envelope.consumedAt,
    );
  }
  return at;
}

export function readApproval(row: ApprovalRow): Approval {
  const envelope = readApprovalEnvelope(row.arguments);
  const status = readApprovalStatus(row.status);
  return {
    rowId: asIdentifier<ApprovalRowId>(row.id),
    approvalId: asIdentifier<ApprovalId>(envelope.approvalId),
    source: envelope.source as ApprovalSource,
    agentId: row.agentId === null ? null : asIdentifier<AgentId>(row.agentId),
    threadId: row.threadId === null ? null : asIdentifier<ThreadId>(row.threadId),
    turnId: row.turnId === null ? null : asIdentifier<TurnId>(row.turnId),
    action: row.action,
    details: row.details,
    toolName: row.toolName,
    arguments: envelope.value,
    requestedBy: envelope.requestedBy,
    requestDigest: envelope.requestHash,
    requestedByTokenId: envelope.requestedByMcpTokenId,
    status,
    timeoutSeconds: row.timeoutSeconds,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
    resolution: readResolution(row, status, envelope),
    consumedAt: readConsumedAt(envelope),
    outcome: readApprovalOutcome(row.resolution),
  };
}
