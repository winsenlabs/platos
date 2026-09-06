// Every value the canonical schema will not hold, refused BEFORE the statement
// is sent.
//
// WHY BEFORE. On PostgreSQL a violated constraint aborts the WHOLE transaction,
// not the statement. `run-turn.ts` composes a turn out of a sequence
// allocation, a create, a settlement and an outbox append inside one unit of
// work, so a `Step` whose cache figures exceed its own input total would take
// the append down with it and the caller would see an infrastructure failure
// where a value was wrong. Checking first turns that into a `Result` with a code
// on it and leaves the transaction alive.
//
// EVERY GUARD HERE RESTATES A RULE THAT LIVES ONLY IN THE MIGRATIONS. Not one of
// them is visible in `schema.prisma`, and the four in-memory doubles this
// context ships enforce none of them — which is exactly why they are listed with
// the constraint each one stands beside, and why
// `conversations-rules.integration.test.ts` proves the DATABASE refuses the same
// value the guard does. A guard whose constraint has been dropped is a guard
// nobody can delete safely.
//
//   Thread_sessionContext_json_root   sessionContext is an object root or NULL
//   Thread_ancestry                   forkedUpToTurnId is the LAST forkedTurnId,
//                                     the array is distinct, and both are empty
//                                     together
//   Turn_usage_check                  sequence > 0, costCents >= 0,
//                                     latencyMs >= 0, completedAt >= startedAt
//   Turn_input/output_json_root       both are object roots or NULL
//   Step_usage_check                  sequence > 0, retryCount >= 0, five token
//                                     counts >= 0, cacheCreation + cacheRead
//                                     <= inputTokens, and — the big one — a
//                                     priced step carries its WHOLE price
//                                     snapshot
//   PostmanExecution_requestFingerprint_check   64 lowercase hex
//   PostmanExecution_contextHandle_check        an RFC-4122 uuid, version 1-8
//   PostmanExecution_ancestry         a turn link requires a thread link
//
// AND EVERY IDENTIFIER COLUMN IS `@db.Uuid`. A non-uuid is not a constraint
// failure at all — it is a driver conversion error partway through a
// transaction, with no SQLSTATE a caller can act on — so it is refused here
// first, exactly as `cost-monitoring`'s and `secrets`' stores refuse theirs.
//
// THE CODES ARE DISTINCT, ALL FOURTEEN OF THEM. Two guards sharing a code cannot
// be told apart in a log, which is the defect WIN-258 T1 recorded in `privacy`
// and in `identity-access`; the sweep beside this package proves each one is
// killed by a case that names it.

import type {
  PostmanExecution,
  Step,
  Thread,
  Turn,
} from "@platos/context-conversations/application/ports/index.js";

/** An identifier bound for a `@db.Uuid` column that is not a uuid. */
export const CONVERSATIONS_IDENTIFIER_NOT_UUID = "conversations.write.identifier_not_uuid";

/** `Thread.sessionContext` is not a JSON object at its root. */
export const SESSION_CONTEXT_NOT_OBJECT = "conversations.write.session_context_not_object";

/** `Thread.forkedUpToTurnId` and `Thread.forkedTurnIds` do not agree. */
export const FORK_LINEAGE_INCOHERENT = "conversations.write.fork_lineage_incoherent";

/** `Thread.forkedTurnIds` names one turn twice. */
export const FORK_LINEAGE_REPEATED = "conversations.write.fork_lineage_repeated";

/** A `Turn.sequence` or `Step.sequence` outside `> 0`. */
export const SEQUENCE_OUT_OF_RANGE = "conversations.write.sequence_out_of_range";

/** A negative `costCents`, `latencyMs` or `retryCount`. */
export const MEASUREMENT_NEGATIVE = "conversations.write.measurement_negative";

/** `completedAt` precedes `startedAt` on a turn or a step. */
export const TIMESTAMPS_INCOHERENT = "conversations.write.timestamps_incoherent";

/** `Turn.input` or `Turn.output` is not a JSON object at its root. */
export const TURN_JSON_NOT_OBJECT = "conversations.write.turn_json_not_object";

/** A `Step` token count is negative. */
export const STEP_USAGE_NEGATIVE = "conversations.write.step_usage_negative";

/** A `Step`'s cache figures exceed the input total they are parts of. */
export const STEP_CACHE_EXCEEDS_INPUT = "conversations.write.step_cache_exceeds_input";

/** A priced `Step` is missing part of the price snapshot that explains it. */
export const STEP_PRICE_SNAPSHOT_INCOMPLETE = "conversations.write.step_price_snapshot_incomplete";

/** `PostmanExecution.requestFingerprint` is not 64 lowercase hex characters. */
export const REQUEST_FINGERPRINT_MALFORMED = "conversations.write.request_fingerprint_malformed";

/** `PostmanExecution.contextHandle` is not the uuid shape the CHECK demands. */
export const CONTEXT_HANDLE_MALFORMED = "conversations.write.context_handle_malformed";

/** An execution names a turn but no thread; the ancestry rule refuses it. */
export const EXECUTION_TURN_WITHOUT_THREAD = "conversations.write.execution_turn_without_thread";

/** A value the canonical schema will not hold, refused before any statement. */
export class ConversationsWriteRefused extends Error {
  readonly code: string;
  readonly detail: string;

  constructor(code: string, detail: string) {
    super(`${code}: ${detail}`);
    this.name = "ConversationsWriteRefused";
    this.code = code;
    this.detail = detail;
  }
}

function refuse(code: string, detail: string): never {
  throw new ConversationsWriteRefused(code, detail);
}

/**
 * Every canonical uuid, in the ONE shape PostgreSQL will accept for `@db.Uuid`.
 *
 * Deliberately NOT the `PostmanExecution_contextHandle_check` pattern below.
 * That one additionally pins the VERSION nibble to 1-8 and the variant to
 * 8/9/a/b; this one accepts any hex in those places, because `Thread.id` and its
 * siblings carry no such CHECK and a store that demanded one would refuse a row
 * the database would have taken.
 */
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu;

/**
 * `PostmanExecution_contextHandle_check`, restated exactly.
 *
 * LOWERCASE ONLY, version 1-8, variant 8/9/a/b. The uppercase form a caller may
 * reasonably hold is refused BY THE DATABASE, so it is refused here — this is
 * the pattern from the migration, character for character, and not a
 * normalisation of it. Normalising would make the store accept a handle the
 * database would not, and `postman-execution.ts` brands the handle as a
 * CAPABILITY: silently rewriting one is silently issuing a different capability.
 */
const CONTEXT_HANDLE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;

/** `PostmanExecution_requestFingerprint_check`, restated exactly. */
const FINGERPRINT = /^[0-9a-f]{64}$/u;

function requireUuid(field: string, value: string | null): void {
  if (value === null) return;
  if (!UUID.test(value)) {
    refuse(CONVERSATIONS_IDENTIFIER_NOT_UUID, `${field} must be a uuid; received "${value}"`);
  }
}

function requireObjectRoot(field: string, code: string, value: unknown): void {
  if (value === null || value === undefined) return;
  if (typeof value !== "object" || Array.isArray(value)) {
    refuse(code, `${field} must be a JSON object at its root`);
  }
}

function requireNonNegative(field: string, value: number | null): void {
  if (value === null) return;
  if (!Number.isFinite(value) || value < 0) {
    refuse(MEASUREMENT_NEGATIVE, `${field} must not be negative; received ${String(value)}`);
  }
}

function requireOrderedInstants(field: string, startedAt: Date | null, completedAt: Date | null): void {
  if (startedAt === null || completedAt === null) return;
  if (completedAt.getTime() < startedAt.getTime()) {
    refuse(TIMESTAMPS_INCOHERENT, `${field} completed before it started`);
  }
}

/**
 * Refuse a `Thread` the database would refuse.
 *
 * THE FORK LINEAGE IS THE INTERESTING HALF, and it is a rule NOTHING outside the
 * migration states. `enforce_domain_ancestry` demands that `forkedUpToTurnId`
 * equal the LAST element of `forkedTurnIds`, that the array hold no duplicate,
 * and that the array and the boundary be empty together. Two of the three are
 * decidable here without a statement; the third — that every inherited turn
 * belongs to the parent's own lineage — needs the parent row and is left to the
 * database, which is the honest split.
 */
export function guardThreadWrite(thread: Thread): void {
  requireUuid("Thread.id", thread.threadId);
  requireUuid("Thread.agentId", thread.agentId);
  requireUuid("Thread.endUserId", thread.endUserId);
  requireUuid("Thread.clusterId", thread.clusterId);
  requireUuid("Thread.parentThreadId", thread.parentThreadId);
  requireUuid("Thread.forkedUpToTurnId", thread.forkedUpToTurnId);
  requireUuid("Thread.compactedUpToTurnId", thread.compactedUpToTurnId);
  for (const [index, turnId] of thread.forkedTurnIds.entries()) {
    requireUuid(`Thread.forkedTurnIds[${String(index)}]`, turnId);
  }
  requireObjectRoot("Thread.sessionContext", SESSION_CONTEXT_NOT_OBJECT, thread.sessionContext);

  const lineage = thread.forkedTurnIds;
  if (new Set(lineage).size !== lineage.length) {
    refuse(FORK_LINEAGE_REPEATED, "Thread.forkedTurnIds names the same turn more than once");
  }
  if (lineage.length === 0) {
    if (thread.forkedUpToTurnId !== null) {
      refuse(
        FORK_LINEAGE_INCOHERENT,
        "Thread.forkedUpToTurnId is set while Thread.forkedTurnIds is empty",
      );
    }
    return;
  }
  if (thread.forkedUpToTurnId !== lineage[lineage.length - 1]) {
    refuse(
      FORK_LINEAGE_INCOHERENT,
      "Thread.forkedUpToTurnId must be the LAST entry of Thread.forkedTurnIds",
    );
  }
}

/** Refuse a `Turn` the database would refuse. */
export function guardTurnWrite(turn: Turn): void {
  requireUuid("Turn.id", turn.turnId);
  requireUuid("Turn.threadId", turn.threadId);
  requireUuid("Turn.parentTurnId", turn.parentTurnId);
  requireUuid("Turn.agentVersionId", turn.agentVersionId);
  if (!Number.isInteger(turn.sequence) || turn.sequence <= 0) {
    refuse(SEQUENCE_OUT_OF_RANGE, `Turn.sequence must be a whole number above zero; received ${String(turn.sequence)}`);
  }
  requireNonNegative("Turn.latencyMs", turn.latencyMs);
  if (turn.cost.amount.microCents < 0n) {
    refuse(MEASUREMENT_NEGATIVE, "Turn.costCents must not be negative");
  }
  requireOrderedInstants("Turn", turn.startedAt, turn.completedAt);
  requireObjectRoot("Turn.input", TURN_JSON_NOT_OBJECT, turn.input);
  requireObjectRoot("Turn.output", TURN_JSON_NOT_OBJECT, turn.output);
}

/**
 * Refuse a `Step` the database would refuse.
 *
 * THE PRICE SNAPSHOT IS THE ONE WORTH READING. `Step_usage_check` says that a
 * step carrying `costCents` must ALSO carry `modelPriceId`, all four rates, all
 * four rate sources and all four observation instants — thirteen columns tied to
 * one. `domain/step-rates.ts` states a DIFFERENT rule at a different boundary —
 * a rate may be absent only where its token count is zero — and both are real: a
 * step priced at zero cents for a zero-token call satisfies the domain and would
 * still be refused by the database if it named a price card without its rates.
 * So this is not a duplicate of the domain guard, and the sweep beside this
 * package carries a case for each.
 */
export function guardStepWrite(step: Step): void {
  requireUuid("Step.id", step.stepId);
  requireUuid("Step.turnId", step.turnId);
  requireUuid("Step.modelPriceId", step.modelPriceId);
  if (!Number.isInteger(step.sequence) || step.sequence <= 0) {
    refuse(SEQUENCE_OUT_OF_RANGE, `Step.sequence must be a whole number above zero; received ${String(step.sequence)}`);
  }
  requireNonNegative("Step.retryCount", step.retryCount);
  requireNonNegative("Step.latencyMs", step.latencyMs);
  requireOrderedInstants("Step", step.startedAt, step.completedAt);

  const usage = step.usage;
  for (const [field, value] of Object.entries(usage)) {
    if (!Number.isInteger(value) || value < 0) {
      refuse(STEP_USAGE_NEGATIVE, `Step.${field} must be a whole number of tokens, not ${String(value)}`);
    }
  }
  if (usage.cacheCreationInputTokens + usage.cacheReadInputTokens > usage.inputTokens) {
    refuse(
      STEP_CACHE_EXCEEDS_INPUT,
      "Step cache figures are PARTS of inputTokens and may not exceed it",
    );
  }

  if (step.cost === null) return;
  if (step.cost.microCents < 0n) refuse(MEASUREMENT_NEGATIVE, "Step.costCents must not be negative");
  if (step.modelPriceId === null) {
    refuse(
      STEP_PRICE_SNAPSHOT_INCOMPLETE,
      "a priced Step must name the ModelPrice it was charged against",
    );
  }
  for (const name of ["input", "output", "cacheRead", "cacheWrite"] as const) {
    if (step.rates[name] === null) {
      refuse(
        STEP_PRICE_SNAPSHOT_INCOMPLETE,
        `a priced Step must carry its ${name} rate, source and observation instant`,
      );
    }
  }
}

/** Refuse a `PostmanExecution` the database would refuse. */
export function guardExecutionWrite(execution: PostmanExecution): void {
  requireUuid("PostmanExecution.id", execution.executionId);
  requireUuid("PostmanExecution.agentId", execution.agentId);
  requireUuid("PostmanExecution.templateId", execution.templateId);
  requireUuid("PostmanExecution.requestId", execution.requestId);
  requireUuid("PostmanExecution.actorUserId", execution.actorUserId);
  requireUuid("PostmanExecution.simulatedEndUserId", execution.simulatedEndUserId);
  requireUuid("PostmanExecution.threadId", execution.threadId);
  requireUuid("PostmanExecution.turnId", execution.turnId);
  if (!FINGERPRINT.test(execution.requestFingerprint)) {
    refuse(
      REQUEST_FINGERPRINT_MALFORMED,
      "PostmanExecution.requestFingerprint must be 64 lowercase hexadecimal characters",
    );
  }
  if (!CONTEXT_HANDLE.test(execution.contextHandle)) {
    refuse(
      CONTEXT_HANDLE_MALFORMED,
      "PostmanExecution.contextHandle must be a lowercase RFC-4122 uuid of version 1-8",
    );
  }
  if (execution.turnId !== null && execution.threadId === null) {
    refuse(
      EXECUTION_TURN_WITHOUT_THREAD,
      "PostmanExecution names a turn without the thread that turn belongs to",
    );
  }
}
