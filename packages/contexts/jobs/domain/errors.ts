// The `jobs` error catalogue.
//
// M0.4 §2 fixes `code` as a SCREAMING_SNAKE string that is immutable within a
// major, and the kernel makes an error a VALUE rather than a thrown class.
//
// WHY THIS CATALOGUE HAS TWO NAMING FAMILIES. Every other context extracted so
// far prefixes its codes with its own name (`FILES_*`, `SECRETS_*`). This one
// does so only for codes it is MINTING. The eleven codes in
// `JOB_EXECUTION_ERROR_CODES` already exist on the live wire: they are the
// `JobExecutionErrorCode` union that `apps/agent`'s job-execution controller
// returns as `{ status: "failed", error: { code } }`. M0.4 §2 says renaming a
// code is a breaking change, so an extraction that renamed them to
// `JOBS_EXECUTION_TIMEOUT` and friends would be a contract break dressed up as a
// refactor. They are carried across verbatim and pinned by a test.
//
// Codes with no live counterpart — the approval half, which today returns
// booleans and nulls rather than codes — are minted `JOBS_*` like every other
// context. The split is therefore: inherited codes keep their names, new codes
// follow the house style.
//
// NO HTTP STATUS APPEARS HERE. ADR M0.3 §2 keeps the domain free of transport
// vocabulary and the kernel notes that the code -> status table belongs to
// WIN-260. The live statuses are recorded beside each code as a COMMENT so that
// table can be built without re-deriving them from the deleted service, but they
// are not data this layer carries.

import { domainError, type DomainError, type ErrorCategory, type FieldViolation } from "@platos/kernel";

/**
 * The live `JobExecutionErrorCode` union, verbatim. Order is the declaration
 * order in `apps/agent/src/agent-runtime/job-execution.service.ts`.
 */
export const JOB_EXECUTION_ERROR_CODES = [
  "INVALID_REQUEST",
  "JOB_NOT_FOUND_OR_INACTIVE",
  "JOB_NOT_AUTHORIZED",
  "JOB_NOT_REGISTERED",
  "IDEMPOTENCY_CONFLICT",
  "IDEMPOTENCY_IN_PROGRESS",
  "IDEMPOTENCY_UNAVAILABLE",
  "JOB_SERVICE_UNAVAILABLE",
  "JOB_TIMEOUT",
  "JOB_EXECUTION_FAILED",
  "JOB_RESULT_REJECTED",
] as const;

export type JobExecutionErrorCode = (typeof JOB_EXECUTION_ERROR_CODES)[number];

/**
 * The category each inherited code carries, as a total table.
 *
 * It exists because a cached failure is replayed from its CODE alone (the live
 * idempotency record stores nothing else), so the category has to be recoverable
 * from the code without the original error. Deriving it at each call site is what
 * would let two sites disagree about what `JOB_TIMEOUT` is.
 */
export const JOB_EXECUTION_ERROR_CATEGORY: Readonly<Record<JobExecutionErrorCode, ErrorCategory>> =
  Object.freeze({
    INVALID_REQUEST: "invalid_input",
    JOB_NOT_FOUND_OR_INACTIVE: "not_found",
    JOB_NOT_AUTHORIZED: "forbidden",
    JOB_NOT_REGISTERED: "precondition_failed",
    IDEMPOTENCY_CONFLICT: "conflict",
    IDEMPOTENCY_IN_PROGRESS: "conflict",
    IDEMPOTENCY_UNAVAILABLE: "unavailable",
    JOB_SERVICE_UNAVAILABLE: "unavailable",
    JOB_TIMEOUT: "unavailable",
    JOB_EXECUTION_FAILED: "internal",
    JOB_RESULT_REJECTED: "invalid_input",
  });

export function isJobExecutionErrorCode(code: string): code is JobExecutionErrorCode {
  return Object.prototype.hasOwnProperty.call(JOB_EXECUTION_ERROR_CATEGORY, code);
}

/**
 * Rebuild the error a cached failure stands for.
 *
 * Only the code survives in a reservation, so the message and details of the
 * original failure are gone. Reconstructing a faithful-LOOKING error with
 * invented details would be worse than an honest one: the code is what a caller
 * branches on, and the rest would be fiction. `details.replayed` marks it so an
 * operator reading a log can tell a replay from a first failure.
 */
export function replayedExecutionFailure(code: JobExecutionErrorCode): DomainError {
  return domainError(code, JOB_EXECUTION_ERROR_CATEGORY[code], "replayed from a cached failure for this request id", {
    details: { replayed: true },
  });
}

/** Codes this context mints for the halves the live system left uncoded. */
export const JOBS_ERROR_CODES = [
  "JOBS_JOB_KEY_INVALID",
  "JOBS_JOB_ALREADY_EXISTS",
  "JOBS_JOB_NOT_FOUND",
  "JOBS_JOB_DEFINITION_INVALID",
  "JOBS_INVOCATION_TYPE_INVALID",
  "JOBS_APPROVAL_NOT_FOUND",
  "JOBS_APPROVAL_ALREADY_RESOLVED",
  "JOBS_APPROVAL_ELAPSED",
  "JOBS_APPROVAL_EDIT_MISSING",
  "JOBS_APPROVAL_SUSPENSION_UNAVAILABLE",
  "JOBS_REPOSITORY_UNAVAILABLE",
  "JOBS_ERASURE_PLAN_FOREIGN",
  "JOBS_IDEMPOTENCY_RECORD_ABSENT",
  "JOBS_IDEMPOTENCY_RECORD_MALFORMED",
  "JOBS_IDEMPOTENCY_REPLAY_CODE_UNPROMISED",
] as const;

export type JobsMintedErrorCode = (typeof JOBS_ERROR_CODES)[number];

export type JobsErrorCode = JobExecutionErrorCode | JobsMintedErrorCode;

// --- the inherited execution codes -----------------------------------------

/** Live status 400. */
export function invalidRequest(message: string, fields: readonly FieldViolation[] = []): DomainError {
  return domainError("INVALID_REQUEST", "invalid_input", message, { fields });
}

/** Live status 404. Absent and inactive are ONE code on purpose: telling them
 * apart would let a caller probe another environment's job ids by difference. */
export function jobNotFoundOrInactive(jobId: string): DomainError {
  return domainError("JOB_NOT_FOUND_OR_INACTIVE", "not_found", "job is not active in this scope", {
    details: { jobId },
  });
}

/** Live status 403. */
export function jobNotAuthorized(reason: string, details: Readonly<Record<string, string>> = {}): DomainError {
  return domainError("JOB_NOT_AUTHORIZED", "forbidden", reason, { details });
}

/** Live status 422. The row exists and is active but carries no dispatchable
 * handler — a different fact from "no such job", and separately actionable. */
export function jobNotRegistered(reason: string): DomainError {
  return domainError("JOB_NOT_REGISTERED", "precondition_failed", reason);
}

/** Live status 409. The request id was reused with a DIFFERENT body. */
export function idempotencyConflict(): DomainError {
  return domainError(
    "IDEMPOTENCY_CONFLICT",
    "conflict",
    "this request id was already used with a different request body",
  );
}

/** Live status 409. The same body is still running under this request id. */
export function idempotencyInProgress(): DomainError {
  return domainError("IDEMPOTENCY_IN_PROGRESS", "conflict", "an identical request is still in progress");
}

// --- WIN-260: the three unreadable-reservation refusals ---------------------
//
// All three are `conflict`, and that is deliberate: a reservation exists under
// this request id and cannot be honoured, so retrying the SAME id will keep
// getting the same answer until it expires. The STATUS being shared is fine; the
// CODE being shared was not. Until WIN-260 all three left through
// `idempotencyConflict()`, which also carries the genuine "same id, different
// body" — four incidents, one code, indistinguishable in a log and to a caller.

/** The key was held a moment ago and the record was gone when it was read. */
export function idempotencyRecordAbsent(): DomainError {
  return domainError(
    "JOBS_IDEMPOTENCY_RECORD_ABSENT",
    "conflict",
    "the reservation for this request id was held but had gone by the time it was read",
  );
}

/** The record was present and is not a reservation this version can read. */
export function idempotencyRecordMalformed(): DomainError {
  return domainError(
    "JOBS_IDEMPOTENCY_RECORD_MALFORMED",
    "conflict",
    "the reservation for this request id did not decode to a reservation",
  );
}

/**
 * The record decodes and holds a cached failure whose code is outside the closed
 * set. Refused rather than replayed: M0.4 §2 makes the execution codes a contract
 * and handing back one that is not in it would put an unrecognisable code on the
 * wire under a contract that says the set is closed.
 */
export function idempotencyReplayCodeUnpromised(): DomainError {
  return domainError(
    "JOBS_IDEMPOTENCY_REPLAY_CODE_UNPROMISED",
    "conflict",
    "the cached failure for this request id names a code outside the promised set",
  );
}

/** Live status 503. The reservation store could not be reached — fail CLOSED. */
export function idempotencyUnavailable(reason: string): DomainError {
  return domainError("IDEMPOTENCY_UNAVAILABLE", "unavailable", "idempotency store is unavailable", {
    retryAfterSeconds: 5,
    details: { reason },
  });
}

/** Live status 503. */
export function jobServiceUnavailable(reason: string): DomainError {
  return domainError("JOB_SERVICE_UNAVAILABLE", "unavailable", "job store is unavailable", {
    retryAfterSeconds: 5,
    details: { reason },
  });
}

/** Live status 504. */
export function jobTimeout(timeoutMs: number): DomainError {
  return domainError("JOB_TIMEOUT", "unavailable", "job handler exceeded its timeout", {
    details: { timeoutMs },
  });
}

/** Live status 500. */
export function jobExecutionFailed(reason: string): DomainError {
  return domainError("JOB_EXECUTION_FAILED", "internal", "job handler failed", { details: { reason } });
}

/** Live status 422. The handler returned something that is not admissible
 * output — unserialisable, oversized, or carrying sensitive material. */
export function jobResultRejected(reason: string): DomainError {
  return domainError("JOB_RESULT_REJECTED", "invalid_input", "job result was rejected", {
    details: { reason },
  });
}

// --- codes this context mints ----------------------------------------------

export function jobKeyInvalid(message: string): DomainError {
  return domainError("JOBS_JOB_KEY_INVALID", "invalid_input", message);
}

export function jobAlreadyExists(jobKey: string): DomainError {
  return domainError("JOBS_JOB_ALREADY_EXISTS", "conflict", "a job with that key already exists here", {
    details: { jobKey },
  });
}

export function jobNotFound(jobId: string): DomainError {
  return domainError("JOBS_JOB_NOT_FOUND", "not_found", "job is not visible in this scope", {
    details: { jobId },
  });
}

export function jobDefinitionInvalid(message: string, fields: readonly FieldViolation[] = []): DomainError {
  return domainError("JOBS_JOB_DEFINITION_INVALID", "invalid_input", message, { fields });
}

export function invocationTypeInvalid(value: string, permitted: readonly string[]): DomainError {
  return domainError("JOBS_INVOCATION_TYPE_INVALID", "invalid_input", `unknown invocation type "${value}"`, {
    details: { value, permitted: [...permitted] },
  });
}

export function approvalNotFound(approvalId: string): DomainError {
  return domainError("JOBS_APPROVAL_NOT_FOUND", "not_found", "approval is not visible in this scope", {
    details: { approvalId },
  });
}

/**
 * `conflict`, not a silent false. The live `resolve()` returns a boolean and a
 * double-click is indistinguishable from a store failure; a caller that must
 * tell "someone already decided this" from "the write did not land" cannot.
 */
export function approvalAlreadyResolved(approvalId: string, status: string): DomainError {
  return domainError("JOBS_APPROVAL_ALREADY_RESOLVED", "conflict", "approval has already been decided", {
    details: { approvalId, status },
  });
}

export function approvalElapsed(approvalId: string, deadlineAt: string, now: string): DomainError {
  return domainError("JOBS_APPROVAL_ELAPSED", "precondition_failed", "approval deadline has elapsed", {
    details: { approvalId, deadlineAt, now },
  });
}

/** The live `ApprovalEditMissingError`, expressed as a value. */
export function approvalEditMissing(): DomainError {
  return domainError(
    "JOBS_APPROVAL_EDIT_MISSING",
    "invalid_input",
    "editedArguments required for an approved-with-edits decision",
  );
}

export function approvalSuspensionUnavailable(reason: string): DomainError {
  return domainError(
    "JOBS_APPROVAL_SUSPENSION_UNAVAILABLE",
    "unavailable",
    "durable runtime could not park or resume the suspended run",
    { retryAfterSeconds: 5, details: { reason } },
  );
}

export function repositoryUnavailable(reason: string): DomainError {
  return domainError("JOBS_REPOSITORY_UNAVAILABLE", "unavailable", "jobs repository is unavailable", {
    retryAfterSeconds: 5,
    details: { reason },
  });
}

/**
 * The kernel's `ErasurePlan` carries no subject, so a target handed a plan it did
 * not mint cannot know whose rows to destroy. Refusing is the only safe answer.
 */
export function erasurePlanForeign(targetName: string): DomainError {
  return domainError(
    "JOBS_ERASURE_PLAN_FOREIGN",
    "precondition_failed",
    "erasure plan was not produced by this target and carries no subject to act on",
    { details: { targetName } },
  );
}
