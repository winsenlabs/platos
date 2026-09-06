// What the real database refuses, checked BEFORE the statement is sent.
//
// WHY BEFORE. On PostgreSQL a statement that violates a constraint ABORTS the
// enclosing transaction: every later statement fails with 25P02 until the block
// ends. Every write on both of this context's ports takes the CALLER's
// `TransactionScope`, and `request-approval.ts` writes an approval inside the
// same unit of work that then parks the turn on a `DurableRuntime` suspension —
// so a store that let a CHECK raise would have reported the refusal correctly
// and left the caller unable to write anything else. `cost-guards.ts` and
// `governance-guards.ts` found the same thing on the same database; the answer
// is the same. Refuse in TypeScript, send nothing, keep the transaction.
//
// EVERY GUARD BELOW IS A CONSTRAINT THAT EXISTS ONLY IN THE MIGRATIONS OR ONLY
// IN THE COLUMN TYPE, AND THAT NEITHER IN-MEMORY DOUBLE IN THIS CONTEXT HOLDS.
//
//   `@db.Uuid` on both primary keys and on all four foreign keys they carry.
//   `aJob()` in `application/testing/builders.ts` mints
//   `jobId: "job-0001"` and `anApproval()` mints `rowId: "appr-row-0001"`.
//   BOTH are accepted by their doubles and refused by PostgreSQL, and every
//   use-case suite in this context passes with them. That is the same class of
//   defect tranche 3 found in tenancy's `InvitationTokenIssuer`, one context
//   over.
//
//   `Job_payloadSchema_json_root CHECK ("payloadSchema" IS NULL OR
//   jsonb_typeof("payloadSchema") = 'object')`. The domain field is
//   `JsonValue | null`, so an ARRAY is a value the type admits and the column
//   refuses — and a JSON Schema written as a bare array of sub-schemas is the
//   obvious way to reach it.
//
//   `AgentApproval_resolution_json_root`, the same shape over the column this
//   store keeps `Approval.outcome` in. `outcome` is `JsonValue | null` and the
//   column takes only an object or SQL NULL, which is why the outcome rides in
//   the envelope `jobs-rows.ts` defines and why the marker is reserved here.
//
//   `Int` is int4. `Job.timeoutSeconds`, `Job.maxRetries` and
//   `AgentApproval.timeoutSeconds` are all `INTEGER`, and JavaScript hands the
//   driver a `number` that may be 2^53. `clampTimeoutSeconds` in
//   `domain/approval.ts` has a FLOOR and deliberately no ceiling, so a caller
//   asking for a century of decision time reaches this column.
//
//   `TIMESTAMP(3)` on all five instants. An `Invalid Date` is a `Date` to the
//   type checker and a driver error at the wire.
//
// EVERY REFUSAL HAS ITS OWN CODE. Two guards sharing one code cannot be told
// apart in a log, which is how two defects hid behind one code in `privacy` and
// in `identity-access`.

import type {
  Approval,
  ApprovalEdit,
  Job,
  JsonValue,
} from "@platos/context-jobs/application/ports/index.js";

import { APPROVAL_OUTCOME_MARKER } from "./jobs-rows.js";

/**
 * An identifier bound for a `@db.Uuid` column that is not a uuid.
 *
 * Prefixed at the source rather than aliased at the package entry point.
 * `cost-monitoring`, `channels`, `secrets` and `skills` each already publish an
 * `IDENTIFIER_NOT_UUID`, and `conversations-guards.ts` records why the fifth
 * mints its own prefixed name instead of taking a fifth alias: four aliases of
 * one name are four chances to export the wrong one.
 */
export const JOBS_IDENTIFIER_NOT_UUID = "jobs.write.identifier_not_uuid";

/** `Job.payloadSchema` is neither null nor a JSON object. */
export const PAYLOAD_SCHEMA_NOT_OBJECT = "jobs.write.payload_schema_not_object";

/** `Job.timeoutSeconds` or `Job.maxRetries` is not a non-negative int4. */
export const JOB_BUDGET_NOT_STORABLE = "jobs.write.job_budget_not_storable";

/** `AgentApproval.timeoutSeconds` is not a non-negative int4. */
export const APPROVAL_TIMEOUT_NOT_STORABLE = "jobs.write.approval_timeout_not_storable";

/** A caller's `Approval.outcome` object carries the envelope's reserved marker. */
export const APPROVAL_OUTCOME_RESERVED = "jobs.write.approval_outcome_reserved";

/**
 * An `ApprovalEdit` whose `editedArguments` is JSON `null`.
 *
 * THIS IS A PORT CONTRACT THE CANONICAL SCHEMA CANNOT HONOUR, refused rather
 * than silently lost. The live envelope carries a human's edits as two FLAT
 * metadata fields, `editedArgs` and `editedByUserId`, and the absence of an edit
 * as `editedArgs: null` — so an edit whose `editedArguments` IS `null` and no
 * edit at all are the same stored bytes, and a round trip turns the first into
 * the second with nothing to report. Adding a third field to discriminate them
 * would make every row this store writes unreadable by `apps/agent`, which reads
 * the same two keys today.
 *
 * `requireEdit` in `domain/approval.ts` already names that exact shape as a
 * caller mistake — `approvalEditMissing()`, "editedArguments required for an
 * approved-with-edits decision" — so the value this store refuses is one the
 * domain refuses one layer up. It is refused HERE as well because
 * `resolveApproval` does not itself enforce `requireEdit`, and a store that
 * accepted it would answer a different approval than it was handed.
 */
export const APPROVAL_EDIT_NOT_STORABLE = "jobs.write.approval_edit_not_storable";

/** A `Date` bound for a `TIMESTAMP(3)` column that the driver cannot carry. */
export const JOBS_INSTANT_NOT_REPRESENTABLE = "jobs.write.instant_not_representable";

/**
 * A page window the store will not turn into an unbounded scan.
 *
 * `ApprovalQuery.limit` and `.offset` are `number | null` on the port and the
 * double answers `query.limit ?? 50` without looking at the value, so a
 * negative `take` — which PostgreSQL reads as "page BACKWARDS from the offset" —
 * is a shape both stores accept and only one of them survives.
 */
export const APPROVAL_PAGE_WINDOW_INVALID = "jobs.write.approval_page_window_invalid";

export class JobsWriteRefused extends Error {
  readonly code: string;
  readonly detail: string;

  constructor(code: string, detail: string) {
    super(`${code}: ${detail}`);
    this.name = "JobsWriteRefused";
    this.code = code;
    this.detail = detail;
  }
}

/**
 * The canonical uuid shape, as the database itself parses it.
 *
 * Deliberately the same expression the migrations' own
 * `PostmanExecution_contextHandle_check` uses rather than a looser
 * hex-and-dashes pattern: PostgreSQL's `uuid` input accepts several spellings,
 * and a guard that admitted one the `@db.Uuid` column then rejected would be a
 * guard that does not guard.
 */
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export function isUuid(value: string): boolean {
  return UUID.test(value);
}

/** Refuse a value bound for a `@db.Uuid` column. `null` is always allowed. */
export function requireUuid(column: string, value: string | null): void {
  if (value === null) return;
  if (!isUuid(value)) {
    throw new JobsWriteRefused(
      JOBS_IDENTIFIER_NOT_UUID,
      `${column} is not a uuid: ${JSON.stringify(value)}`,
    );
  }
}

const INT4_MAX = 2_147_483_647;

function isNonNegativeInt4(value: number): boolean {
  return Number.isInteger(value) && value >= 0 && value <= INT4_MAX;
}

/**
 * Refuse a `Date` the driver cannot bind.
 *
 * `new Date("nonsense")` is an `Invalid Date` — a `Date` to the type checker, a
 * `NaN` epoch at the wire — and every timestamp on both tables is NOT NULL or
 * explicitly nullable rather than defaulted, so a store that passed one through
 * would fail somewhere with the driver's name on it rather than this store's.
 */
export function requireStorableInstant(column: string, value: Date | null): void {
  if (value === null) return;
  if (Number.isNaN(value.getTime())) {
    throw new JobsWriteRefused(
      JOBS_INSTANT_NOT_REPRESENTABLE,
      `${column} is not a representable instant`,
    );
  }
}

function isJsonObject(value: JsonValue): boolean {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * `Job_payloadSchema_json_root`, restated where the transaction still survives.
 *
 * The column takes SQL NULL or a JSON OBJECT and nothing else. `domain/job.ts`
 * types the field `JsonValue | null` and never inspects it — "a JSON Schema
 * describing admissible payloads, or null. Never executed." — so an array, a
 * string and a number all type-check here and all three abort the transaction
 * at the wire.
 */
export function requireStorablePayloadSchema(value: JsonValue | null): void {
  if (value === null) return;
  if (!isJsonObject(value)) {
    throw new JobsWriteRefused(
      PAYLOAD_SCHEMA_NOT_OBJECT,
      "Job.payloadSchema must satisfy CHECK (payloadSchema IS NULL OR jsonb_typeof(payloadSchema) = 'object')",
    );
  }
}

/**
 * Refuse an outcome object that carries the envelope marker at its ROOT.
 *
 * Only the root is inspected. A nested `__platosOutcome` is a handler's own
 * attribute that happens to share a name and reads back unchanged, because
 * `readApprovalOutcome` only ever looks at the root. Refusing it at the root is
 * what stops a stored `{ "__platosOutcome": 7 }` from being read back as `7`.
 */
export function requireUnreservedOutcome(outcome: JsonValue | null): void {
  if (outcome === null) return;
  if (!isJsonObject(outcome)) return;
  if (Object.prototype.hasOwnProperty.call(outcome, APPROVAL_OUTCOME_MARKER)) {
    throw new JobsWriteRefused(
      APPROVAL_OUTCOME_RESERVED,
      `Approval.outcome may not carry the reserved key ${APPROVAL_OUTCOME_MARKER} at its root`,
    );
  }
}

/**
 * Refuse an edit the live envelope cannot tell from no edit at all.
 *
 * See `APPROVAL_EDIT_NOT_STORABLE`. The check is on `editedArguments` alone:
 * `editedBy` is nullable in the envelope AND in the domain, so an edit with a
 * real argument value and no editor round-trips exactly.
 */
export function requireStorableEdit(edit: ApprovalEdit | null): void {
  if (edit === null) return;
  if (edit.editedArguments === null) {
    throw new JobsWriteRefused(
      APPROVAL_EDIT_NOT_STORABLE,
      "ApprovalEdit.editedArguments may not be JSON null: the live envelope stores it in the same field it stores the ABSENCE of an edit in, so the two would be one row",
    );
  }
}

/** Everything a `Job` write must satisfy before a statement is sent. */
export function guardJob(job: Job): void {
  requireUuid("Job.id", job.jobId);
  requireStorablePayloadSchema(job.payloadSchema);
  if (!isNonNegativeInt4(job.budget.timeoutSeconds)) {
    throw new JobsWriteRefused(
      JOB_BUDGET_NOT_STORABLE,
      `Job.timeoutSeconds must be a non-negative int4; received ${String(job.budget.timeoutSeconds)}`,
    );
  }
  if (!isNonNegativeInt4(job.budget.maxRetries)) {
    throw new JobsWriteRefused(
      JOB_BUDGET_NOT_STORABLE,
      `Job.maxRetries must be a non-negative int4; received ${String(job.budget.maxRetries)}`,
    );
  }
  requireStorableInstant("Job.createdAt", job.createdAt);
  requireStorableInstant("Job.updatedAt", job.updatedAt);
  requireStorableInstant("Job.lastStartedAt", job.lastStartedAt);
}

/** Everything an `AgentApproval` write must satisfy before a statement is sent. */
export function guardApproval(approval: Approval): void {
  requireUuid("AgentApproval.id", approval.rowId);
  requireUuid("AgentApproval.agentId", approval.agentId);
  requireUuid("AgentApproval.threadId", approval.threadId);
  requireUuid("AgentApproval.turnId", approval.turnId);
  if (!isNonNegativeInt4(approval.timeoutSeconds)) {
    throw new JobsWriteRefused(
      APPROVAL_TIMEOUT_NOT_STORABLE,
      `AgentApproval.timeoutSeconds must be a non-negative int4; received ${String(approval.timeoutSeconds)}`,
    );
  }
  requireUnreservedOutcome(approval.outcome);
  requireStorableEdit(approval.resolution?.edit ?? null);
  requireStorableInstant("AgentApproval.createdAt", approval.createdAt);
  requireStorableInstant("AgentApproval.updatedAt", approval.updatedAt);
  requireStorableInstant("AgentApproval.resolvedAt", approval.resolution?.resolvedAt ?? null);
  requireStorableInstant("AgentApproval.consumedAt", approval.consumedAt);
}

/**
 * The page window a listing may ask the database for.
 *
 * The live service clamps rather than refuses (`Math.min(Math.max(limit ?? 50,
 * 1), 200)`) and the in-memory double does neither, so the two already disagree
 * about a negative limit. This store refuses it: a clamp turns a caller's
 * mistake into a silently different page, and a page that is silently different
 * is the one kind of wrong a paging bug never announces.
 */
export function requireStorablePageWindow(limit: number, offset: number): void {
  if (!isNonNegativeInt4(limit) || limit === 0) {
    throw new JobsWriteRefused(
      APPROVAL_PAGE_WINDOW_INVALID,
      `ApprovalQuery.limit must be a positive int4; received ${String(limit)}`,
    );
  }
  if (!isNonNegativeInt4(offset)) {
    throw new JobsWriteRefused(
      APPROVAL_PAGE_WINDOW_INVALID,
      `ApprovalQuery.offset must be a non-negative int4; received ${String(offset)}`,
    );
  }
}
