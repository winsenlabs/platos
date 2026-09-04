// The `conversations` error catalogue.
//
// M0.4 §2 fixes `code` as a SCREAMING_SNAKE string immutable within a major, and
// the kernel makes an error a VALUE rather than a thrown class. Every code this
// context can produce is minted here, once, so a transport builds its status
// table from one list and an operator grepping a log finds one definition.
//
// ONE CODE PER GUARD, BECAUSE TWO GUARDS SHARING A CODE CANNOT BE TOLD APART.
// That is not a style preference. A mutation ledger proves a guard exists by
// deleting it and watching a named case go red; if the guard beside it answers
// with the same code, the case stays green and the deletion is invisible. The
// extraction source throws bare `Error("Thread not found")`,
// `Error("Turn not found")` and `new BadRequestException("Invalid input")` from
// dozens of places, and several of its refusals are genuinely different
// decisions wearing one sentence:
//
//   * a thread that is ARCHIVED, a thread being COMPACTED and a thread whose
//     TURN CEILING is spent are three refusals with three operator remedies, so
//     they are three codes;
//   * a fork whose boundary turn belongs to another thread and a fork that is
//     too deep are different bugs in the caller;
//   * a step whose token counts are unusable and a step whose RATES are missing
//     are the two halves of the money path, and collapsing them is exactly how
//     a fixture with no rate card left the whole path dead while every case
//     stayed green.
//
// WHERE ONE CODE COVERS MORE THAN ONE DECISION IT IS SAID SO AT THE
// CONSTRUCTOR, and it is always one of two kinds.
//
// DELIBERATE CONCEALMENT, where telling the two apart would be the probe:
// `CONVERSATIONS_THREAD_NOT_FOUND` covers a thread that is absent and one that
// is present in another environment, because an end user who can distinguish
// them can enumerate another tenant's threads by id. The same holds for a turn,
// a step and a postman execution.
//
// A SHARED SHAPE, where the remedy is the same and the payload says which: a
// negative offset and an unusable limit both answer
// `CONVERSATIONS_PAGE_REQUEST_INVALID` with a `fields` violation naming the one
// at fault.
//
// The known limit of `errors.test.ts` is that it can check CONSTRUCTORS for
// uniqueness, not guards. Two guards calling one constructor are invisible to
// it, and `mutations.json` is the control on that.

import { domainError, type DomainError, type FieldViolation } from "@platos/kernel";

export const CONVERSATIONS_ERROR_CODES = [
  "CONVERSATIONS_SCOPE_MISMATCH",
  "CONVERSATIONS_REPOSITORY_UNAVAILABLE",
  "CONVERSATIONS_QUEUE_UNAVAILABLE",
  "CONVERSATIONS_PAGE_REQUEST_INVALID",
  "CONVERSATIONS_THREAD_NOT_FOUND",
  "CONVERSATIONS_THREAD_FORBIDDEN",
  "CONVERSATIONS_THREAD_ARCHIVED",
  "CONVERSATIONS_THREAD_TITLE_INVALID",
  "CONVERSATIONS_THREAD_TAGS_INVALID",
  "CONVERSATIONS_SESSION_CONTEXT_INVALID",
  "CONVERSATIONS_SESSION_CONTEXT_TOO_LARGE",
  "CONVERSATIONS_FORK_TURN_FOREIGN",
  "CONVERSATIONS_FORK_CEILING_EXCEEDED",
  "CONVERSATIONS_FORK_DEPTH_EXCEEDED",
  "CONVERSATIONS_COMPACTION_IN_PROGRESS",
  "CONVERSATIONS_COMPACTION_LOCK_HELD",
  "CONVERSATIONS_COMPACTION_CURSOR_REGRESSED",
  "CONVERSATIONS_COMPACTION_SUMMARY_TOO_LONG",
  "CONVERSATIONS_TURN_NOT_FOUND",
  "CONVERSATIONS_TURN_INPUT_INVALID",
  "CONVERSATIONS_TURN_INPUT_TOO_LARGE",
  "CONVERSATIONS_TURN_SEQUENCE_TAKEN",
  "CONVERSATIONS_TURN_IDEMPOTENCY_CONFLICT",
  "CONVERSATIONS_TURN_ALREADY_SETTLED",
  "CONVERSATIONS_TURN_CEILING_EXCEEDED",
  "CONVERSATIONS_TURNS_DISABLED",
  "CONVERSATIONS_TURN_ABORTED",
  "CONVERSATIONS_STEP_NOT_FOUND",
  "CONVERSATIONS_STEP_SEQUENCE_TAKEN",
  "CONVERSATIONS_STEP_CEILING_EXCEEDED",
  "CONVERSATIONS_STEP_USAGE_INVALID",
  "CONVERSATIONS_STEP_RATE_MISSING",
  "CONVERSATIONS_STEP_ALREADY_SETTLED",
  "CONVERSATIONS_TOOL_NOT_OFFERED",
  "CONVERSATIONS_TOOL_CATALOGUE_EXCEEDED",
  "CONVERSATIONS_SUB_AGENT_DEPTH_EXCEEDED",
  "CONVERSATIONS_SUB_AGENT_FAN_OUT_EXCEEDED",
  "CONVERSATIONS_SUB_AGENT_CYCLE",
  "CONVERSATIONS_SUB_AGENTS_DISABLED",
  "CONVERSATIONS_ATTACHMENT_TOO_LARGE",
  "CONVERSATIONS_ATTACHMENT_TURN_TOO_LARGE",
  "CONVERSATIONS_ATTACHMENT_MEDIA_TYPE_REFUSED",
  "CONVERSATIONS_ATTACHMENT_COUNT_EXCEEDED",
  "CONVERSATIONS_ATTACHMENT_FOREIGN",
  "CONVERSATIONS_OUTPUT_SCHEMA_INVALID",
  "CONVERSATIONS_OUTPUT_UNPARSABLE",
  "CONVERSATIONS_POSTMAN_NOT_FOUND",
  "CONVERSATIONS_POSTMAN_HANDLE_EXPIRED",
  "CONVERSATIONS_POSTMAN_REQUEST_REPLAYED",
  "CONVERSATIONS_POSTMAN_FINGERPRINT_MISMATCH",
  "CONVERSATIONS_POSTMAN_ALREADY_SETTLED",
  "CONVERSATIONS_AGENT_NOT_VISIBLE",
  "CONVERSATIONS_AGENT_VERSION_NOT_VISIBLE",
  "CONVERSATIONS_GENERATION_FAILED",
  "CONVERSATIONS_BUDGET_EXHAUSTED",
  "CONVERSATIONS_ERASURE_PLAN_FOREIGN",
] as const;

export type ConversationsErrorCode = (typeof CONVERSATIONS_ERROR_CODES)[number];

// ---------------------------------------------------------------------------
// Scope, infrastructure and paging
// ---------------------------------------------------------------------------

/** The grant does not reach the scope the command names. Never a `not_found`. */
export function scopeMismatch(expectedPath: string, grantedPath: string): DomainError {
  const message = `this grant authorizes ${grantedPath}, not ${expectedPath}`;
  return domainError("CONVERSATIONS_SCOPE_MISMATCH", "forbidden", message, {
    details: { expectedPath, grantedPath },
  });
}

/**
 * A store could not answer.
 *
 * `unavailable`, never `internal`: the caller may retry, and the transport needs
 * to say so. The reason is already redacted by the adapter that raised it.
 */
export function repositoryUnavailable(reason: string): DomainError {
  return domainError("CONVERSATIONS_REPOSITORY_UNAVAILABLE", "unavailable", reason, {
    retryAfterSeconds: 1,
  });
}

/** The durable seam could not accept the work. Same retry contract as above. */
export function queueUnavailable(reason: string): DomainError {
  return domainError("CONVERSATIONS_QUEUE_UNAVAILABLE", "unavailable", reason, {
    retryAfterSeconds: 1,
  });
}

/** A shared shape: `fields` names the offset or the limit that is at fault. */
export function pageRequestInvalid(message: string, fields: readonly FieldViolation[] = []): DomainError {
  return domainError("CONVERSATIONS_PAGE_REQUEST_INVALID", "invalid_input", message, { fields });
}

// ---------------------------------------------------------------------------
// Threads
// ---------------------------------------------------------------------------

/**
 * Absent, or present in another environment, or another end user's.
 *
 * DELIBERATE CONCEALMENT. Thread ids are uuids but they travel in URLs, and an
 * end user able to tell "no such thread" from "not yours" can enumerate a
 * tenant's threads. The operator surfaces get `threadForbidden` instead, because
 * an operator holding an environment grant is already entitled to know the row
 * exists.
 */
export function threadNotFound(threadId: string): DomainError {
  return domainError("CONVERSATIONS_THREAD_NOT_FOUND", "not_found", "no such thread", {
    details: { threadId },
  });
}

/** The thread exists in this environment and belongs to a different end user. */
export function threadForbidden(threadId: string, endUserId: string): DomainError {
  const message = "this thread belongs to another end user";
  return domainError("CONVERSATIONS_THREAD_FORBIDDEN", "forbidden", message, {
    details: { threadId, endUserId },
  });
}

/** A write reached a thread that was archived. Reads of it still succeed. */
export function threadArchived(threadId: string): DomainError {
  const message = "this thread is archived and takes no further turns";
  return domainError("CONVERSATIONS_THREAD_ARCHIVED", "precondition_failed", message, {
    details: { threadId },
  });
}

/** A shared shape: blank and over-long titles both land here, `fields` says which. */
export function threadTitleInvalid(fields: readonly FieldViolation[]): DomainError {
  return domainError("CONVERSATIONS_THREAD_TITLE_INVALID", "invalid_input", "unusable thread title", {
    fields,
  });
}

/** A tag that is blank, over-long, or one tag too many for the policy ceiling. */
export function threadTagsInvalid(fields: readonly FieldViolation[]): DomainError {
  return domainError("CONVERSATIONS_THREAD_TAGS_INVALID", "invalid_input", "unusable thread tags", {
    fields,
  });
}

/**
 * `Thread.sessionContext` is documented in the schema as an OBJECT ROOT.
 *
 * An array or a scalar at the root is refused rather than coerced: the shape
 * registry the column's comment names validates object roots, and a scalar
 * stored there is a row no reader can interpret.
 */
export function sessionContextInvalid(reason: string): DomainError {
  return domainError("CONVERSATIONS_SESSION_CONTEXT_INVALID", "invalid_input", reason, {});
}

/** Distinct from the shape refusal: a well-formed object that is simply too big. */
export function sessionContextTooLarge(bytes: number, maximum: number): DomainError {
  const message = `session context is ${bytes} bytes, over the ${maximum}-byte ceiling`;
  return domainError("CONVERSATIONS_SESSION_CONTEXT_TOO_LARGE", "invalid_input", message, {
    details: { bytes, maximum },
  });
}

// ---------------------------------------------------------------------------
// Forking and compaction
// ---------------------------------------------------------------------------

/**
 * The boundary turn named by a fork is not in the thread being forked.
 *
 * `Thread.forkedUpToTurn` is `onDelete: Restrict`, so a foreign turn here would
 * pin another thread's row alive forever as well as producing a fork whose
 * history is somebody else's.
 */
export function forkTurnForeign(threadId: string, turnId: string): DomainError {
  const message = "the fork boundary turn is not in this thread";
  return domainError("CONVERSATIONS_FORK_TURN_FOREIGN", "invalid_input", message, {
    details: { threadId, turnId },
  });
}

/**
 * A cap on how many forks ONE thread may have.
 *
 * Distinct from the depth ceiling below, and it has to be: a thread inside the
 * fan-out ceiling can still breach the depth one, and the reverse. Sharing a
 * code would make the two indistinguishable to the test that proves each exists.
 */
export function forkCeilingExceeded(count: number, maximum: number): DomainError {
  const message = `this thread has ${count} forks, at the ${maximum}-fork ceiling`;
  return domainError("CONVERSATIONS_FORK_CEILING_EXCEEDED", "precondition_failed", message, {
    details: { count, maximum },
  });
}

/** A cap on how LONG a chain of forks may get. Depth is not fan-out. */
export function forkDepthExceeded(depth: number, maximum: number): DomainError {
  const message = `fork depth ${depth} is over the ${maximum}-deep ceiling`;
  return domainError("CONVERSATIONS_FORK_DEPTH_EXCEEDED", "precondition_failed", message, {
    details: { depth, maximum },
  });
}

/**
 * A second compaction started while one was running.
 *
 * `Thread.compactionState` is the lock. Two concurrent compactions would each
 * summarise a prefix and the second would overwrite the first's cursor, losing
 * the turns between them.
 */
export function compactionInProgress(threadId: string): DomainError {
  const message = "a compaction is already running on this thread";
  return domainError("CONVERSATIONS_COMPACTION_IN_PROGRESS", "conflict", message, {
    details: { threadId },
  });
}

/**
 * Another worker holds the row lock. A DIFFERENT CODE FROM THE ONE ABOVE, and
 * the difference is the point.
 *
 * `compactionInProgress` is what `beginCompaction` answers when THIS caller's
 * own snapshot of the row already says IN_PROGRESS. This one is what the
 * repository answers when the conditional update lost a race to another worker.
 * Both mean "somebody is compacting", but they are detected in different places
 * and only one of them is a race, so an operator reading the log needs to know
 * which fired. While they shared a code, deleting the lock check left every case
 * green — the domain check answered identically — and a lock that nothing can
 * turn red is not a lock.
 */
export function compactionLockHeld(threadId: string): DomainError {
  const message = "another worker holds the compaction lock on this thread";
  return domainError("CONVERSATIONS_COMPACTION_LOCK_HELD", "conflict", message, {
    details: { threadId },
  });
}

/** The cursor may only move forward. A regression would re-expose compacted turns. */
export function compactionCursorRegressed(from: number, to: number): DomainError {
  const message = `compaction cursor moved backwards, from sequence ${from} to ${to}`;
  return domainError("CONVERSATIONS_COMPACTION_CURSOR_REGRESSED", "precondition_failed", message, {
    details: { from, to },
  });
}

/** A cap on the summary that replaces the compacted prefix in every later prompt. */
export function compactionSummaryTooLong(length: number, maximum: number): DomainError {
  const message = `summary is ${length} characters, over the ${maximum}-character ceiling`;
  return domainError("CONVERSATIONS_COMPACTION_SUMMARY_TOO_LONG", "invalid_input", message, {
    details: { length, maximum },
  });
}

// ---------------------------------------------------------------------------
// Turns
// ---------------------------------------------------------------------------

/** Absent, or in another environment's thread. Concealed for the same reason. */
export function turnNotFound(turnId: string): DomainError {
  return domainError("CONVERSATIONS_TURN_NOT_FOUND", "not_found", "no such turn", {
    details: { turnId },
  });
}

/** A turn with neither text nor structured input has nothing to run. */
export function turnInputInvalid(reason: string): DomainError {
  return domainError("CONVERSATIONS_TURN_INPUT_INVALID", "invalid_input", reason, {});
}

/** A cap, distinct from the emptiness refusal: well-formed input that is too big. */
export function turnInputTooLarge(bytes: number, maximum: number): DomainError {
  const message = `turn input is ${bytes} bytes, over the ${maximum}-byte ceiling`;
  return domainError("CONVERSATIONS_TURN_INPUT_TOO_LARGE", "invalid_input", message, {
    details: { bytes, maximum },
  });
}

/** `@@unique([threadId, sequence])` refused the write. Two writers raced. */
export function turnSequenceTaken(threadId: string, sequence: number): DomainError {
  const message = `sequence ${sequence} is already taken in this thread`;
  return domainError("CONVERSATIONS_TURN_SEQUENCE_TAKEN", "conflict", message, {
    details: { threadId, sequence },
  });
}

/**
 * The same idempotency key arrived with DIFFERENT input.
 *
 * A redelivery of the same request answers the turn it already made; that is not
 * an error and has no code. This is the other case — one key, two requests —
 * which `@@unique([threadId, idempotencyKey])` would silently collapse into
 * whichever arrived first.
 */
export function turnIdempotencyConflict(key: string): DomainError {
  const message = "this idempotency key was already used for different input";
  return domainError("CONVERSATIONS_TURN_IDEMPOTENCY_CONFLICT", "conflict", message, {
    details: { idempotencyKey: key },
  });
}

/** A settled turn is immutable: SUCCEEDED, FAILED and CANCELLED are terminal. */
export function turnAlreadySettled(turnId: string, status: string): DomainError {
  const message = `this turn is already ${status}`;
  return domainError("CONVERSATIONS_TURN_ALREADY_SETTLED", "conflict", message, {
    details: { turnId, status },
  });
}

/** A cap on turns per thread. Distinct from the step ceiling inside one turn. */
export function turnCeilingExceeded(count: number, maximum: number): DomainError {
  const message = `this thread has ${count} turns, at the ${maximum}-turn ceiling`;
  return domainError("CONVERSATIONS_TURN_CEILING_EXCEEDED", "precondition_failed", message, {
    details: { count, maximum },
  });
}

/** The kill switch. An installation can stop every turn without a code change. */
export function turnsDisabled(): DomainError {
  const message = "turn execution is disabled for this installation";
  return domainError("CONVERSATIONS_TURNS_DISABLED", "precondition_failed", message, {});
}

/**
 * The caller abandoned the turn.
 *
 * A `Result`, not a thrown `AbortError`: the turn is marked CANCELLED and the
 * steps already paid for are kept, so an abort is billed for what it used.
 */
export function turnAborted(turnId: string): DomainError {
  return domainError("CONVERSATIONS_TURN_ABORTED", "conflict", "this turn was abandoned", {
    details: { turnId },
  });
}

// ---------------------------------------------------------------------------
// Steps and the money path
// ---------------------------------------------------------------------------

/** Absent, or in another environment's turn. */
export function stepNotFound(stepId: string): DomainError {
  return domainError("CONVERSATIONS_STEP_NOT_FOUND", "not_found", "no such step", {
    details: { stepId },
  });
}

/** `@@unique([turnId, sequence])` refused the write. */
export function stepSequenceTaken(turnId: string, sequence: number): DomainError {
  const message = `step sequence ${sequence} is already taken in this turn`;
  return domainError("CONVERSATIONS_STEP_SEQUENCE_TAKEN", "conflict", message, {
    details: { turnId, sequence },
  });
}

/** The step budget is spent. This is the bound on an open-ended tool loop. */
export function stepCeilingExceeded(count: number, maximum: number): DomainError {
  const message = `this turn has ${count} steps, at the ${maximum}-step ceiling`;
  return domainError("CONVERSATIONS_STEP_CEILING_EXCEEDED", "precondition_failed", message, {
    details: { count, maximum },
  });
}

/** A negative or non-integer token count. The first half of the money path. */
export function stepUsageInvalid(field: string, value: number): DomainError {
  const message = `${field} must be a non-negative integer, not ${value}`;
  return domainError("CONVERSATIONS_STEP_USAGE_INVALID", "invalid_input", message, {
    fields: [{ field, code: "NOT_A_TOKEN_COUNT", message }],
  });
}

/**
 * A token count is non-zero and the rate that prices it is absent.
 *
 * THE SECOND HALF OF THE MONEY PATH, AND ITS OWN CODE FOR A MEASURED REASON. A
 * fixture that carried no rate card left every pricing branch unexecuted while
 * every case stayed green, because "no rate" and "no tokens" both produced a
 * zero cost. Refusing the first and returning zero for the second is what makes
 * the two distinguishable, and `step-cost.test.ts` asserts both.
 */
export function stepRateMissing(field: string, tokens: number): DomainError {
  const message = `${field} is unset while ${tokens} tokens were charged against it`;
  return domainError("CONVERSATIONS_STEP_RATE_MISSING", "precondition_failed", message, {
    details: { field, tokens },
  });
}

/** A settled step is immutable, exactly as a settled turn is. */
export function stepAlreadySettled(stepId: string, status: string): DomainError {
  const message = `this step is already ${status}`;
  return domainError("CONVERSATIONS_STEP_ALREADY_SETTLED", "conflict", message, {
    details: { stepId, status },
  });
}

// ---------------------------------------------------------------------------
// Tools and sub-agents
// ---------------------------------------------------------------------------

/**
 * The model asked for a tool that was not in the catalogue it was given.
 *
 * Refused here rather than dispatched: the catalogue IS the authorization
 * decision for this turn, and a name that was not in it has not been through
 * the four-tier gate `tools` owns.
 */
export function toolNotOffered(toolName: string): DomainError {
  const message = `this turn was not offered a tool named ${toolName}`;
  return domainError("CONVERSATIONS_TOOL_NOT_OFFERED", "forbidden", message, {
    details: { toolName },
  });
}

/** A cap on how many tools one turn may carry into a prompt. */
export function toolCatalogueExceeded(count: number, maximum: number): DomainError {
  const message = `${count} tools offered, over the ${maximum}-tool ceiling`;
  return domainError("CONVERSATIONS_TOOL_CATALOGUE_EXCEEDED", "precondition_failed", message, {
    details: { count, maximum },
  });
}

/** A cap: an agent delegating to an agent delegating to an agent. */
export function subAgentDepthExceeded(depth: number, maximum: number): DomainError {
  const message = `delegation depth ${depth} is over the ${maximum}-deep ceiling`;
  return domainError("CONVERSATIONS_SUB_AGENT_DEPTH_EXCEEDED", "precondition_failed", message, {
    details: { depth, maximum },
  });
}

/** A different cap: how many sub-agents ONE turn may run. Depth is not breadth. */
export function subAgentFanOutExceeded(count: number, maximum: number): DomainError {
  const message = `${count} sub-agent calls in one turn, over the ${maximum} ceiling`;
  return domainError("CONVERSATIONS_SUB_AGENT_FAN_OUT_EXCEEDED", "precondition_failed", message, {
    details: { count, maximum },
  });
}

/**
 * An agent already on the delegation chain was asked for again.
 *
 * A cycle is refused even when it is inside every ceiling, because the ceilings
 * bound the damage rather than name the bug.
 */
export function subAgentCycle(agentId: string): DomainError {
  const message = "this agent is already on the delegation chain";
  return domainError("CONVERSATIONS_SUB_AGENT_CYCLE", "precondition_failed", message, {
    details: { agentId },
  });
}

/** A kill switch of its own: delegation off, ordinary turns still running. */
export function subAgentsDisabled(): DomainError {
  const message = "sub-agent delegation is disabled for this installation";
  return domainError("CONVERSATIONS_SUB_AGENTS_DISABLED", "precondition_failed", message, {});
}

// ---------------------------------------------------------------------------
// Attachments and structured output
// ---------------------------------------------------------------------------

/**
 * ONE attachment over the per-file ceiling.
 *
 * Distinct from the per-turn total below, which the source collapses into one
 * error class carrying a `kind` discriminator. A `kind` inside an error is not
 * a code: a transport switching on the code cannot see it, and a mutation that
 * deletes one of the two ceilings leaves the other's test green.
 */
export function attachmentTooLarge(bytes: number, maximum: number): DomainError {
  const message = `attachment is ${bytes} bytes, over the ${maximum}-byte ceiling`;
  return domainError("CONVERSATIONS_ATTACHMENT_TOO_LARGE", "invalid_input", message, {
    details: { bytes, maximum },
  });
}

/** Every attachment inside the per-file ceiling, and too many bytes together. */
export function attachmentTurnTooLarge(bytes: number, maximum: number): DomainError {
  const message = `attachments total ${bytes} bytes, over the ${maximum}-byte turn ceiling`;
  return domainError("CONVERSATIONS_ATTACHMENT_TURN_TOO_LARGE", "invalid_input", message, {
    details: { bytes, maximum },
  });
}

/** A media type the prompt vocabulary has no content part for. */
export function attachmentMediaTypeRefused(mediaType: string): DomainError {
  const message = `no prompt content part carries ${mediaType}`;
  return domainError("CONVERSATIONS_ATTACHMENT_MEDIA_TYPE_REFUSED", "invalid_input", message, {
    details: { mediaType },
  });
}

/** A cap on how many attachments one turn may carry. Not a size refusal. */
export function attachmentCountExceeded(count: number, maximum: number): DomainError {
  const message = `${count} attachments, over the ${maximum}-attachment ceiling`;
  return domainError("CONVERSATIONS_ATTACHMENT_COUNT_EXCEEDED", "invalid_input", message, {
    details: { count, maximum },
  });
}

/**
 * The file named by an attachment is not this thread's.
 *
 * `files` owns the row and answers where it hangs. This context checks that the
 * answer matches the thread the turn is in, which is the check that stops a
 * caller reading another end user's upload into a prompt.
 */
export function attachmentForeign(fileId: string, threadId: string): DomainError {
  const message = "this file does not belong to this thread";
  return domainError("CONVERSATIONS_ATTACHMENT_FOREIGN", "forbidden", message, {
    details: { fileId, threadId },
  });
}

/** The requested output schema is not a usable JSON Schema object. */
export function outputSchemaInvalid(reason: string): DomainError {
  return domainError("CONVERSATIONS_OUTPUT_SCHEMA_INVALID", "invalid_input", reason, {});
}

/** A schema-shaped turn whose model answered with something that will not parse. */
export function outputUnparsable(reason: string): DomainError {
  return domainError("CONVERSATIONS_OUTPUT_UNPARSABLE", "unavailable", reason, {
    retryAfterSeconds: 1,
  });
}

// ---------------------------------------------------------------------------
// Postman executions
// ---------------------------------------------------------------------------

/** Absent, or another environment's. */
export function postmanNotFound(executionId: string): DomainError {
  return domainError("CONVERSATIONS_POSTMAN_NOT_FOUND", "not_found", "no such execution", {
    details: { executionId },
  });
}

/** `contextExpiresAt` has passed. The handle is a capability with a deadline. */
export function postmanHandleExpired(handle: string, expiredAt: Date): DomainError {
  const message = "this execution handle has expired";
  return domainError("CONVERSATIONS_POSTMAN_HANDLE_EXPIRED", "precondition_failed", message, {
    details: { handle, expiredAt: expiredAt.toISOString() },
  });
}

/** `@@unique([templateId, requestId])`: the same saved request was launched twice. */
export function postmanRequestReplayed(templateId: string, requestId: string): DomainError {
  const message = "this request has already been executed";
  return domainError("CONVERSATIONS_POSTMAN_REQUEST_REPLAYED", "conflict", message, {
    details: { templateId, requestId },
  });
}

/**
 * One request id, two different bodies.
 *
 * Distinct from the replay above, which is the SAME body arriving twice and is a
 * caller retrying. This one is a caller reusing an id, and answering the first
 * execution would hand back somebody else's result.
 */
export function postmanFingerprintMismatch(requestId: string): DomainError {
  const message = "this request id was already used for a different request";
  return domainError("CONVERSATIONS_POSTMAN_FINGERPRINT_MISMATCH", "conflict", message, {
    details: { requestId },
  });
}

/** A settled execution is immutable. */
export function postmanAlreadySettled(executionId: string, status: string): DomainError {
  const message = `this execution is already ${status}`;
  return domainError("CONVERSATIONS_POSTMAN_ALREADY_SETTLED", "conflict", message, {
    details: { executionId, status },
  });
}

// ---------------------------------------------------------------------------
// What the peers answered
// ---------------------------------------------------------------------------

/** `agents` does not show this agent in this scope. Not a `not_found` of ours. */
export function agentNotVisible(agentId: string): DomainError {
  const message = "this agent is not visible in this scope";
  return domainError("CONVERSATIONS_AGENT_NOT_VISIBLE", "not_found", message, {
    details: { agentId },
  });
}

/** A version that does not resolve. Distinct: the agent is fine, the pin is not. */
export function agentVersionNotVisible(agentId: string): DomainError {
  const message = "this agent has no resolvable version in this scope";
  return domainError("CONVERSATIONS_AGENT_VERSION_NOT_VISIBLE", "not_found", message, {
    details: { agentId },
  });
}

/**
 * `providers` refused or the generation ended in a `failed` event.
 *
 * The provider's own `PROVIDERS_*` error travels in `details.cause` rather than
 * being re-thrown, so a caller sees one code from this context and the
 * underlying reason in the log line.
 */
export function generationFailed(cause: string): DomainError {
  return domainError("CONVERSATIONS_GENERATION_FAILED", "unavailable", "the generation failed", {
    retryAfterSeconds: 1,
    details: { cause },
  });
}

/** `cost-monitoring` refused the spend before the first step was taken. */
export function budgetExhausted(reason: string): DomainError {
  return domainError("CONVERSATIONS_BUDGET_EXHAUSTED", "precondition_failed", reason, {});
}

/**
 * An erasure plan built by another target was handed to this one.
 *
 * `privacy` collects one plan per context and calls each target back with its
 * own. A target that carried out somebody else's plan would delete rows it is
 * not the sole writer of.
 */
export function erasurePlanForeign(targetName: string): DomainError {
  const message = `this plan belongs to ${targetName}`;
  return domainError("CONVERSATIONS_ERASURE_PLAN_FOREIGN", "invalid_input", message, {
    details: { targetName },
  });
}
