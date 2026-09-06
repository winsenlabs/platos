// The four `conversations` rows as the driver hands them back, and the pure
// functions that turn one into a domain value.
//
// SEPARATE FROM THE STORES FOR THE REASON `identity-rows.ts` AND
// `governance-rows.ts` ARE. A store is about WHICH statement runs; this is about
// what a column MEANS, and the two drift apart if they share a file. Every
// function here is pure and every one of them is exercised without a database by
// `conversations-rows.test.ts`.
//
// IT VALIDATES RATHER THAN CASTS, and the expand/contract rule (ADR M0.3 §7) is
// why. `Thread.status`, `Turn.status`, `Step.status` and `PostmanExecution.status`
// are all the same PostgreSQL enum, `Thread.compactionState` is another and
// `Turn.versionBucket` a third; a release that rolls back to a binary older
// than a migration that ADDED a member reads a value it has never heard of. A
// cast would make that a `"SUPERSEDED" as WorkStatus` flowing into a transition
// table that has no row for it. A refusal names the column and the value.
//
// ---------------------------------------------------------------------------
// THE ONE MAPPING DECISION THAT IS NOT A TRANSCRIPTION: A TURN'S MONEY
// ---------------------------------------------------------------------------
//
// `Turn` the domain value carries `cost: TurnCost` — an amount, a STEP COUNT, an
// UNPRICED COUNT and a COMPLETENESS flag — and `usage: StepUsage`, five token
// figures. The canonical `Turn` row carries `costCents` and nothing else of
// either. Six of those seven numbers have no column.
//
// So they are ROLLED UP FROM THE STEP ROWS, by the context's own
// `rollUpTurnCost` and `sumStepUsage`, and never invented here.
// `domain/turn-cost.ts` is explicit that the rollup "TAKES THE STEPS AND NOTHING
// ELSE" and `domain/step-usage.ts` that "the per-step rows are the record"; a
// store that answered `stepCount` from a column that does not exist, or
// re-derived the sum with arithmetic of its own, would be the second
// implementation of the one thing that context exists to have exactly one of.
//
// THE CONSEQUENCE IS THAT `Turn.costCents` IS WRITE-ONLY HERE. `saveSettlement`
// writes it, because it is the column an operator's SQL and every downstream
// projection reads; no read in this package consults it. A row whose stored
// total disagrees with its own steps — which is exactly what the extraction
// source produced, three code paths giving three answers for one turn — reads
// back as the STEPS say, and `conversations-rows.test.ts` pins that.

import {
  asConversationsIdentifier,
  isWorkStatus,
  moneyFromCentsString,
  RATE_SOURCES,
  rollUpTurnCost,
  sumStepUsage,
  THREAD_COMPACTION_STATES,
  VERSION_BUCKETS,
  type ActorId,
  type AgentId,
  type AgentVersionId,
  type ClusterId,
  type EndUserId,
  type EnvironmentScope,
  type IdempotencyKey,
  type JsonValue,
  type ModelPriceId,
  type Money,
  type PostmanContextHandle,
  type PostmanExecution,
  type PostmanExecutionId,
  type PostmanTemplateId,
  type RateSource,
  type SessionContext,
  type Step,
  type StepId,
  type StepRate,
  type StepRateBook,
  type Thread,
  type ThreadCompactionState,
  type ThreadId,
  type Turn,
  type TurnId,
  type VersionBucket,
  type WorkStatus,
} from "@platos/context-conversations/application/ports/index.js";

import { UnreadableRowError } from "./mapping.js";

/** A stored `WorkStatus` this binary does not recognise. */
export const UNKNOWN_WORK_STATUS = "conversations.row.unknown_work_status";

/** A stored `ThreadCompactionState` this binary does not recognise. */
export const UNKNOWN_COMPACTION_STATE = "conversations.row.unknown_compaction_state";

/** A stored `AgentVersionBucket` this binary does not recognise. */
export const UNKNOWN_VERSION_BUCKET = "conversations.row.unknown_version_bucket";

/** A stored `ModelRateSource` this binary does not recognise. */
export const UNKNOWN_RATE_SOURCE = "conversations.row.unknown_rate_source";

/** A `Json` column whose root is not the object its own CHECK demands. */
export const UNREADABLE_JSON_ROOT = "conversations.row.unreadable_json_root";

/** A `Decimal` the driver handed back in a form this binary cannot parse. */
export const UNREADABLE_DECIMAL = "conversations.row.unreadable_decimal";

/**
 * A `Step` rate present in some of its columns and absent in others.
 *
 * ITS OWN CODE BECAUSE IT IS ITS OWN INCIDENT. Every one of the twelve rate
 * columns is nullable and `Step_usage_check` ties them together only when
 * `costCents` is present, so an UNPRICED step may legally carry a rate with no
 * observation instant. `domain/step-rates.ts` cannot represent that: a
 * `StepRate` has all its fields or the book holds `null`. Folding it into
 * `UNREADABLE_DECIMAL` would report a half-written rate as a broken number.
 */
export const UNREADABLE_STEP_RATE = "conversations.row.unreadable_step_rate";

/** Restrict a read to one environment. Every `Thread` and execution read uses it. */
export function scopedWhere(scope: EnvironmentScope): { readonly environmentId: string } {
  return { environmentId: scope.environmentId };
}

/**
 * Restrict a `Turn` or `Step` read to one environment.
 *
 * NEITHER ROW CARRIES `environmentId`, and that is the schema's decision rather
 * than an omission: a turn belongs to a thread and a thread belongs to an
 * environment, so a turn with an environment column would be a second place for
 * the same fact and a place for the two to disagree. The containment is a
 * RELATION filter the database resolves in the SAME statement, not a read of the
 * thread followed by a read of its turns.
 */
export function turnScopedWhere(scope: EnvironmentScope): Record<string, unknown> {
  return { thread: { environmentId: scope.environmentId } };
}

/**
 * Refuse a column this binary cannot read.
 *
 * `UnreadableRowError` takes the COLUMN and the VALUE separately rather than one
 * message, and that is worth keeping: an operator reading the log wants to know
 * which column of which table drifted, and a message that had folded the two
 * together would have to be parsed to find out.
 */
function unreadable(code: string, column: string, value: string): never {
  throw new UnreadableRowError(code, column, value);
}

function readWorkStatus(column: string, value: string): WorkStatus {
  if (!isWorkStatus(value)) unreadable(UNKNOWN_WORK_STATUS, column, value);
  return value;
}

function readCompactionState(value: string): ThreadCompactionState {
  if (!(THREAD_COMPACTION_STATES as readonly string[]).includes(value)) {
    unreadable(UNKNOWN_COMPACTION_STATE, "Thread.compactionState", value);
  }
  return value as ThreadCompactionState;
}

function readVersionBucket(value: string): VersionBucket {
  if (!(VERSION_BUCKETS as readonly string[]).includes(value)) {
    unreadable(UNKNOWN_VERSION_BUCKET, "Turn.versionBucket", value);
  }
  return value as VersionBucket;
}

function readRateSource(column: string, value: string): RateSource {
  if (!(RATE_SOURCES as readonly string[]).includes(value)) {
    unreadable(UNKNOWN_RATE_SOURCE, column, value);
  }
  return value as RateSource;
}

/**
 * A JSONB column whose own CHECK demands an object root.
 *
 * The CHECK is `IS NULL OR jsonb_typeof(...) = 'object'`, so the database has
 * already refused an array and a scalar — but only for rows written while it was
 * installed. A row predating the constraint reaches here, and a cast would put
 * it in a `Readonly<Record<string, JsonValue>>` that every reader would index.
 */
function readObjectRoot(
  column: string,
  value: unknown,
): Readonly<Record<string, JsonValue>> | null {
  if (value === null || value === undefined) return null;
  if (typeof value !== "object" || Array.isArray(value)) {
    unreadable(UNREADABLE_JSON_ROOT, column, Array.isArray(value) ? "a JSON array" : typeof value);
  }
  return Object.freeze({ ...(value as Record<string, JsonValue>) });
}

/** What a `Decimal(18, 6)` or `Decimal(24, 12)` column looks like on the way out. */
export interface DecimalLike {
  toString(): string;
}

/**
 * The scale of the two decimal columns this store reads.
 *
 * THE SCALE IS PART OF THE TYPE, not a formatting preference.
 * `Decimal(24, 12)` stores twelve fractional digits and `Decimal(18, 6)` six, so
 * a rate written as `0.000000300000` is stored as exactly that and must read
 * back as exactly that. See `readDecimalString` for why it does not, unaided.
 */
const RATE_SCALE = 12;
const CENT_SCALE = 6;

/**
 * A decimal in exponential form, expanded to plain notation without a float.
 *
 * FOUND BY THE FIRST INTEGRATION RUN, and it is the driver rather than the
 * database: the ORM hands a `Decimal` back as a decimal.js value whose
 * `toString()` switches to EXPONENTIAL below 1e-7. A `cacheReadRate` of
 * `0.000000300000` — an entirely ordinary rate, and one this package's own
 * fixture uses — reads back as the string `"3e-7"`.
 *
 * `domain/step-rates.ts` requires the canonical decimal STRING and says why in
 * as many words: twelve fractional digits do not survive a binary float, and the
 * value is written back into a decimal column. So the expansion is done on the
 * DIGITS, by moving the point, and never through `Number`.
 */
function expandExponential(text: string): string | null {
  const match = /^(-?)(\d+)(?:\.(\d*))?[eE]([+-]?\d+)$/u.exec(text);
  if (match === null) return null;
  const [, sign = "", whole = "0", fraction = "", exponent = "0"] = match;
  const digits = `${whole}${fraction}`;
  const point = whole.length + Number.parseInt(exponent, 10);
  if (point <= 0) return `${sign}0.${"0".repeat(-point)}${digits}`;
  if (point >= digits.length) return `${sign}${digits}${"0".repeat(point - digits.length)}`;
  return `${sign}${digits.slice(0, point)}.${digits.slice(point)}`;
}

/**
 * A `Decimal` column read as the exact string the schema stores, at its own
 * scale.
 *
 * NEVER THROUGH `Number`. `Decimal(24, 12)` has twelve fractional digits and
 * `Decimal(18, 6)` eighteen significant ones; both exceed what a binary float
 * holds exactly, and `domain/step-rates.ts` says in as many words that parsing a
 * rate into a float and re-rendering it is how a rate drifts in its last digits.
 *
 * PADDED TO THE COLUMN'S SCALE, which is what makes the round trip EXACT rather
 * than merely numerically equal. Without it a rate written as `0.000000300000`
 * comes back as `0.0000003` and a caller comparing two rate books — or a
 * conformance differential comparing this store against the in-memory double —
 * sees a difference that is not one. A value FINER than the scale is refused
 * rather than rounded: the column could not have held it, so reporting it would
 * be reporting a number the database never stored.
 */
function readDecimalString(
  column: string,
  value: DecimalLike | null,
  scale: number,
): string | null {
  if (value === null || value === undefined) return null;
  const rendered = value.toString();
  const plain = /[eE]/u.test(rendered) ? expandExponential(rendered) : rendered;
  if (plain === null || !/^-?\d+(?:\.\d+)?$/u.test(plain)) {
    unreadable(UNREADABLE_DECIMAL, column, rendered);
  }
  const [whole = "0", fraction = ""] = plain.split(".");
  if (fraction.length > scale) unreadable(UNREADABLE_DECIMAL, column, rendered);
  return `${whole}.${fraction.padEnd(scale, "0")}`;
}

function readMoney(column: string, value: DecimalLike | null): Money | null {
  const rendered = readDecimalString(column, value, CENT_SCALE);
  if (rendered === null) return null;
  return moneyFromCentsString(rendered);
}

// ------------------------------------------------------------------- Thread

export interface ThreadRow {
  readonly id: string;
  readonly agentId: string;
  readonly endUserId: string;
  readonly clusterId: string | null;
  readonly parentThreadId: string | null;
  readonly forkedUpToTurnId: string | null;
  readonly forkedTurnIds: readonly string[];
  readonly compactedUpToTurnId: string | null;
  readonly title: string | null;
  readonly status: string;
  readonly summary: string | null;
  readonly compactionState: string;
  readonly compactedAt: Date | null;
  readonly sessionContext: unknown;
  readonly tags: readonly string[];
  readonly pinnedAt: Date | null;
  readonly archivedAt: Date | null;
  readonly createdAt: Date;
  readonly updatedAt: Date;
}

export function readThread(row: ThreadRow): Thread {
  return Object.freeze({
    threadId: asConversationsIdentifier<ThreadId>(row.id),
    agentId: asConversationsIdentifier<AgentId>(row.agentId),
    endUserId: asConversationsIdentifier<EndUserId>(row.endUserId),
    clusterId: row.clusterId === null ? null : asConversationsIdentifier<ClusterId>(row.clusterId),
    parentThreadId:
      row.parentThreadId === null ? null : asConversationsIdentifier<ThreadId>(row.parentThreadId),
    forkedUpToTurnId:
      row.forkedUpToTurnId === null
        ? null
        : asConversationsIdentifier<TurnId>(row.forkedUpToTurnId),
    forkedTurnIds: Object.freeze(
      row.forkedTurnIds.map((turnId) => asConversationsIdentifier<TurnId>(turnId)),
    ),
    compactedUpToTurnId:
      row.compactedUpToTurnId === null
        ? null
        : asConversationsIdentifier<TurnId>(row.compactedUpToTurnId),
    title: row.title,
    status: readWorkStatus("Thread.status", row.status),
    summary: row.summary,
    compactionState: readCompactionState(row.compactionState),
    compactedAt: row.compactedAt,
    sessionContext: readObjectRoot(
      "Thread.sessionContext",
      row.sessionContext,
    ) as SessionContext | null,
    tags: Object.freeze([...row.tags]),
    pinnedAt: row.pinnedAt,
    archivedAt: row.archivedAt,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  });
}

// --------------------------------------------------------------------- Step

export interface StepRow {
  readonly id: string;
  readonly turnId: string;
  readonly sequence: number;
  readonly model: string;
  readonly status: string;
  readonly retryCount: number;
  readonly inputTokens: number | null;
  readonly outputTokens: number | null;
  readonly cacheCreationInputTokens: number | null;
  readonly cacheReadInputTokens: number | null;
  readonly reasoningTokens: number | null;
  readonly costCents: DecimalLike | null;
  readonly modelPriceId: string | null;
  readonly inputRate: DecimalLike | null;
  readonly outputRate: DecimalLike | null;
  readonly cacheReadRate: DecimalLike | null;
  readonly cacheWriteRate: DecimalLike | null;
  readonly inputRateSource: string | null;
  readonly outputRateSource: string | null;
  readonly cacheReadRateSource: string | null;
  readonly cacheWriteRateSource: string | null;
  readonly inputRateObservedAt: Date | null;
  readonly outputRateObservedAt: Date | null;
  readonly cacheReadRateObservedAt: Date | null;
  readonly cacheWriteRateObservedAt: Date | null;
  readonly inputRateSourceRef: string | null;
  readonly outputRateSourceRef: string | null;
  readonly cacheReadRateSourceRef: string | null;
  readonly cacheWriteRateSourceRef: string | null;
  readonly latencyMs: number | null;
  readonly error: string | null;
  readonly startedAt: Date | null;
  readonly completedAt: Date | null;
  readonly createdAt: Date;
}

/**
 * One of the four rates, or `null`, or a refusal.
 *
 * ALL THREE OUTCOMES ARE REAL. Present in all three required columns is a rate;
 * absent from all three is `null`, which `domain/step-rates.ts` admits at a zero
 * token count; present in SOME is a row no `StepRate` can hold, and it gets its
 * own code rather than being quietly completed with a default instant.
 */
function readRate(
  name: string,
  rate: DecimalLike | null,
  source: string | null,
  observedAt: Date | null,
  sourceRef: string | null,
): StepRate | null {
  const present = [rate, source, observedAt].filter((part) => part !== null && part !== undefined);
  if (present.length === 0) return null;
  if (present.length !== 3) {
    unreadable(UNREADABLE_STEP_RATE, `Step.${name}Rate`, `${String(present.length)} of 3 columns`);
  }
  return Object.freeze({
    usdPerToken: readDecimalString(`Step.${name}Rate`, rate, RATE_SCALE) as string,
    source: readRateSource(`Step.${name}RateSource`, source as string),
    observedAt: observedAt as Date,
    sourceRef,
  });
}

export function readStep(row: StepRow): Step {
  const rates: StepRateBook = Object.freeze({
    input: readRate(
      "input",
      row.inputRate,
      row.inputRateSource,
      row.inputRateObservedAt,
      row.inputRateSourceRef,
    ),
    output: readRate(
      "output",
      row.outputRate,
      row.outputRateSource,
      row.outputRateObservedAt,
      row.outputRateSourceRef,
    ),
    cacheRead: readRate(
      "cacheRead",
      row.cacheReadRate,
      row.cacheReadRateSource,
      row.cacheReadRateObservedAt,
      row.cacheReadRateSourceRef,
    ),
    cacheWrite: readRate(
      "cacheWrite",
      row.cacheWriteRate,
      row.cacheWriteRateSource,
      row.cacheWriteRateObservedAt,
      row.cacheWriteRateSourceRef,
    ),
  });
  return Object.freeze({
    stepId: asConversationsIdentifier<StepId>(row.id),
    turnId: asConversationsIdentifier<TurnId>(row.turnId),
    sequence: row.sequence,
    model: row.model,
    status: readWorkStatus("Step.status", row.status),
    retryCount: row.retryCount,
    // A NULL token column is ZERO and not "unknown". `domain/step-usage.ts`
    // makes the five counts non-nullable numbers and the schema makes them
    // nullable integers; the reconciliation is that an absent count is a count
    // of none, which is what `Step_usage_check` already assumes when it compares
    // `COALESCE(cacheCreation, 0) + COALESCE(cacheRead, 0) <= inputTokens`.
    usage: Object.freeze({
      inputTokens: row.inputTokens ?? 0,
      outputTokens: row.outputTokens ?? 0,
      cacheCreationInputTokens: row.cacheCreationInputTokens ?? 0,
      cacheReadInputTokens: row.cacheReadInputTokens ?? 0,
      reasoningTokens: row.reasoningTokens ?? 0,
    }),
    cost: readMoney("Step.costCents", row.costCents),
    modelPriceId:
      row.modelPriceId === null ? null : asConversationsIdentifier<ModelPriceId>(row.modelPriceId),
    rates,
    latencyMs: row.latencyMs,
    error: row.error,
    startedAt: row.startedAt,
    completedAt: row.completedAt,
    createdAt: row.createdAt,
  });
}

// --------------------------------------------------------------------- Turn

export interface TurnRow {
  readonly id: string;
  readonly threadId: string;
  readonly parentTurnId: string | null;
  readonly agentVersionId: string;
  readonly versionBucket: string;
  readonly sequence: number;
  readonly inputText: string | null;
  readonly outputText: string | null;
  readonly input: unknown;
  readonly output: unknown;
  readonly thinkingContent: string | null;
  readonly status: string;
  readonly externalRuntimeId: string | null;
  readonly idempotencyKey: string | null;
  readonly latencyMs: number | null;
  readonly startedAt: Date | null;
  readonly completedAt: Date | null;
  readonly createdAt: Date;
  /** Every step of this turn. The ONLY source of `cost` and `usage`; see header. */
  readonly steps: readonly StepRow[];
}

export function readTurn(row: TurnRow): Turn {
  const steps = row.steps.map(readStep);
  return Object.freeze({
    turnId: asConversationsIdentifier<TurnId>(row.id),
    threadId: asConversationsIdentifier<ThreadId>(row.threadId),
    parentTurnId:
      row.parentTurnId === null ? null : asConversationsIdentifier<TurnId>(row.parentTurnId),
    agentVersionId: asConversationsIdentifier<AgentVersionId>(row.agentVersionId),
    versionBucket: readVersionBucket(row.versionBucket),
    sequence: row.sequence,
    inputText: row.inputText,
    outputText: row.outputText,
    input: readObjectRoot("Turn.input", row.input),
    output: readObjectRoot("Turn.output", row.output),
    thinkingContent: row.thinkingContent,
    status: readWorkStatus("Turn.status", row.status),
    externalRuntimeId: row.externalRuntimeId,
    idempotencyKey:
      row.idempotencyKey === null
        ? null
        : asConversationsIdentifier<IdempotencyKey>(row.idempotencyKey),
    cost: rollUpTurnCost(steps),
    usage: sumStepUsage(steps.map((step) => step.usage)),
    latencyMs: row.latencyMs,
    startedAt: row.startedAt,
    completedAt: row.completedAt,
    createdAt: row.createdAt,
  });
}

// --------------------------------------------------------- PostmanExecution

export interface PostmanExecutionRow {
  readonly id: string;
  readonly agentId: string;
  readonly templateId: string | null;
  readonly requestId: string;
  readonly requestFingerprint: string;
  readonly actorUserId: string;
  readonly simulatedEndUserId: string | null;
  readonly contextHandle: string;
  readonly contextExpiresAt: Date;
  readonly status: string;
  readonly threadId: string | null;
  readonly turnId: string | null;
  readonly completedAt: Date | null;
  readonly createdAt: Date;
  readonly updatedAt: Date;
}

export function readPostmanExecution(row: PostmanExecutionRow): PostmanExecution {
  return Object.freeze({
    executionId: asConversationsIdentifier<PostmanExecutionId>(row.id),
    agentId: asConversationsIdentifier<AgentId>(row.agentId),
    templateId:
      row.templateId === null
        ? null
        : asConversationsIdentifier<PostmanTemplateId>(row.templateId),
    requestId: row.requestId,
    requestFingerprint: row.requestFingerprint,
    actorUserId: asConversationsIdentifier<ActorId>(row.actorUserId),
    simulatedEndUserId:
      row.simulatedEndUserId === null
        ? null
        : asConversationsIdentifier<EndUserId>(row.simulatedEndUserId),
    contextHandle: asConversationsIdentifier<PostmanContextHandle>(row.contextHandle),
    contextExpiresAt: row.contextExpiresAt,
    status: readWorkStatus("PostmanExecution.status", row.status),
    threadId: row.threadId === null ? null : asConversationsIdentifier<ThreadId>(row.threadId),
    turnId: row.turnId === null ? null : asConversationsIdentifier<TurnId>(row.turnId),
    completedAt: row.completedAt,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  });
}
