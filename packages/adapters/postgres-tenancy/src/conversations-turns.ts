// The `TurnRepository` — `Turn` and `Step`, the two rows a running turn writes.
//
// ONE STORE FOR BOTH BECAUSE THEY SHARE A LIFETIME, which is the port's own
// argument and the schema's: `Step.turn` is `onDelete: Cascade`, a step outside
// a turn is not a row this schema can hold, and `saveSettlement` writes both
// inside one transaction so `Turn.costCents` never disagrees with the steps it
// is the sum of.
//
// ---------------------------------------------------------------------------
// EVERY READ THAT ANSWERS A `Turn` ALSO READS ITS STEPS, AND THAT IS FORCED
// ---------------------------------------------------------------------------
//
// `Turn.cost` carries a step count, an unpriced count and a completeness flag,
// and `Turn.usage` five token figures; the `Turn` ROW carries `costCents` and
// none of the other six numbers. `conversations-rows.ts` explains the
// consequence — the rollup is the only faithful mapping — and this file pays for
// it: `steps` is in every select that answers a turn, ordered by sequence.
//
// IT IS NOT AN N+1, and `conversations-statements.integration.test.ts` measures
// that rather than asserting it. The relation is loaded for the WHOLE page in
// one further statement, not one per turn, so a page of one turn and a page of
// fifty cost the same, and the pin is taken over both fixtures.
//
// ---------------------------------------------------------------------------
// THE SEQUENCE CLASH IS AN OUTCOME, AND A SAVEPOINT IS WHAT MAKES IT ONE
// ---------------------------------------------------------------------------
//
// `@@unique([threadId, sequence])` is the constraint `allocateTurnSequence`
// exists to keep two callers from hitting, and losing that race is still
// possible: the allocation and the insert are two statements, and a caller that
// allocated in one transaction and inserted in another has no lock between them.
// The in-memory double answers `CONVERSATIONS_TURN_SEQUENCE_TAKEN` and carries
// on. On PostgreSQL the violation aborts the WHOLE transaction, and `run-turn.ts`
// composes the allocation, the create, the settlement and an outbox append into
// one — so an identical code over a dead transaction would be identical for one
// statement and catastrophically different for the next. The insert runs inside
// a savepoint; see `refusable` in `conversations-refusal.ts`.
//
// `@@unique([threadId, idempotencyKey])` IS DELIBERATELY NOT PRE-CHECKED HERE.
// `application/testing/in-memory-stores.ts` says why in its own header: the
// GUARD under test is `admitTurn`'s pre-check, and a store that refused first
// would produce an identical refusal with an identical code and leave that
// branch untestable. `findTurnByIdempotencyKey` answers truthfully and the
// insert accepts; what distinguishes the pre-check is WHERE the refusal happens.
// A redelivery that reaches the insert anyway is a genuine unique violation and
// is reported as one.

import {
  err,
  moneyToCentsString,
  ok,
  rollUpTurnCost,
  turnNotFound,
  turnSequenceTaken,
  type DomainError,
  type EnvironmentScope,
  type IdempotencyKey,
  type RateSource,
  type Result,
  type Step,
  type ThreadId,
  type Turn,
  type TurnId,
  type TurnPage,
  type TurnPageQuery,
  type TurnRepository,
  type TurnWithSteps,
  type WorkStatus,
} from "@platos/context-conversations/application/ports/index.js";

import { isUniqueViolation, nullableJson } from "./client.js";
import { guardStepWrite, guardTurnWrite } from "./conversations-guards.js";
import { refusable, refuse } from "./conversations-refusal.js";
import {
  readStep,
  readTurn,
  turnScopedWhere,
  type TurnRow,
} from "./conversations-rows.js";
import type { TenancyTransactions } from "./transaction.js";

/** Every column `readStep` reads. One place, so no read is wider or narrower. */
export const STEP_COLUMNS = {
  id: true,
  turnId: true,
  sequence: true,
  model: true,
  status: true,
  retryCount: true,
  inputTokens: true,
  outputTokens: true,
  cacheCreationInputTokens: true,
  cacheReadInputTokens: true,
  reasoningTokens: true,
  costCents: true,
  modelPriceId: true,
  inputRate: true,
  outputRate: true,
  cacheReadRate: true,
  cacheWriteRate: true,
  inputRateSource: true,
  outputRateSource: true,
  cacheReadRateSource: true,
  cacheWriteRateSource: true,
  inputRateObservedAt: true,
  outputRateObservedAt: true,
  cacheReadRateObservedAt: true,
  cacheWriteRateObservedAt: true,
  inputRateSourceRef: true,
  outputRateSourceRef: true,
  cacheReadRateSourceRef: true,
  cacheWriteRateSourceRef: true,
  latencyMs: true,
  error: true,
  startedAt: true,
  completedAt: true,
  createdAt: true,
} as const;

/**
 * Every column `readTurn` reads, INCLUDING the steps it rolls up.
 *
 * `costCents` is absent on purpose. It is written and never read here, because
 * the steps are the record; see `conversations-rows.ts`. Selecting it would
 * invite the next reader to answer `Turn.cost` from it and reintroduce the
 * disagreement the extraction source shipped.
 */
export const TURN_COLUMNS = {
  id: true,
  threadId: true,
  parentTurnId: true,
  agentVersionId: true,
  versionBucket: true,
  sequence: true,
  inputText: true,
  outputText: true,
  input: true,
  output: true,
  thinkingContent: true,
  status: true,
  externalRuntimeId: true,
  idempotencyKey: true,
  latencyMs: true,
  startedAt: true,
  completedAt: true,
  createdAt: true,
  steps: { select: STEP_COLUMNS, orderBy: { sequence: "asc" } },
} as const;

/** The row shape both selects above produce, as this package reads it. */
type SelectedTurn = TurnRow;

/**
 * The columns of a settled `Step`, laid out for an insert.
 *
 * SPELLED OUT RATHER THAN SPREAD, because thirteen of them are tied together by
 * `Step_usage_check` and four more by `Step_price_snapshot`, and a spread of a
 * domain value would silently stop writing a column the day the domain renamed
 * a field. `guardStepWrite` has already refused every shape this cannot hold.
 */
interface StepInsertRow {
  readonly id: string;
  readonly turnId: string;
  readonly sequence: number;
  readonly model: string;
  /** The domain's own `WorkStatus`, which IS the enum's five members. */
  readonly status: WorkStatus;
  readonly retryCount: number;
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly cacheCreationInputTokens: number;
  readonly cacheReadInputTokens: number;
  readonly reasoningTokens: number;
  readonly costCents: string | null;
  readonly modelPriceId: string | null;
  readonly inputRate: string | null;
  readonly outputRate: string | null;
  readonly cacheReadRate: string | null;
  readonly cacheWriteRate: string | null;
  readonly inputRateSource: RateSource | null;
  readonly outputRateSource: RateSource | null;
  readonly cacheReadRateSource: RateSource | null;
  readonly cacheWriteRateSource: RateSource | null;
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

function stepInsert(step: Step): StepInsertRow {
  return {
    id: step.stepId,
    turnId: step.turnId,
    sequence: step.sequence,
    model: step.model,
    status: step.status,
    retryCount: step.retryCount,
    inputTokens: step.usage.inputTokens,
    outputTokens: step.usage.outputTokens,
    cacheCreationInputTokens: step.usage.cacheCreationInputTokens,
    cacheReadInputTokens: step.usage.cacheReadInputTokens,
    reasoningTokens: step.usage.reasoningTokens,
    // The canonical decimal STRING, never a float. `Decimal(18, 6)` and
    // `Decimal(24, 12)` both exceed what a binary float holds exactly, and
    // `Step_price_snapshot` compares the four rates to `ModelPrice`'s own
    // columns — a rate that drifted in its last digits on the way through a
    // `Number` is refused by that trigger, correctly, for a value that was right
    // when the caller had it.
    costCents: step.cost === null ? null : moneyToCentsString(step.cost),
    modelPriceId: step.modelPriceId,
    inputRate: step.rates.input?.usdPerToken ?? null,
    outputRate: step.rates.output?.usdPerToken ?? null,
    cacheReadRate: step.rates.cacheRead?.usdPerToken ?? null,
    cacheWriteRate: step.rates.cacheWrite?.usdPerToken ?? null,
    inputRateSource: step.rates.input?.source ?? null,
    outputRateSource: step.rates.output?.source ?? null,
    cacheReadRateSource: step.rates.cacheRead?.source ?? null,
    cacheWriteRateSource: step.rates.cacheWrite?.source ?? null,
    inputRateObservedAt: step.rates.input?.observedAt ?? null,
    outputRateObservedAt: step.rates.output?.observedAt ?? null,
    cacheReadRateObservedAt: step.rates.cacheRead?.observedAt ?? null,
    cacheWriteRateObservedAt: step.rates.cacheWrite?.observedAt ?? null,
    inputRateSourceRef: step.rates.input?.sourceRef ?? null,
    outputRateSourceRef: step.rates.output?.sourceRef ?? null,
    cacheReadRateSourceRef: step.rates.cacheRead?.sourceRef ?? null,
    cacheWriteRateSourceRef: step.rates.cacheWrite?.sourceRef ?? null,
    latencyMs: step.latencyMs,
    error: step.error,
    startedAt: step.startedAt,
    completedAt: step.completedAt,
    createdAt: step.createdAt,
  };
}

/** The refusal a lost `[threadId, sequence]` race is, and nothing else. */
function sequenceClash(turn: Turn): (error: unknown) => DomainError | null {
  return (error: unknown) =>
    isUniqueViolation(error) ? turnSequenceTaken(turn.threadId, turn.sequence) : null;
}

export function createTurnRepository(transactions: TenancyTransactions): TurnRepository {
  async function readOne(
    scope: EnvironmentScope,
    turnId: TurnId,
  ): Promise<SelectedTurn | null> {
    const row = await transactions.reader().turn.findFirst({
      where: { id: turnId, ...turnScopedWhere(scope) },
      select: TURN_COLUMNS,
    });
    return row === null ? null : (row as unknown as SelectedTurn);
  }

  return {
    async findTurn(scope: EnvironmentScope, turnId: TurnId): Promise<Result<Turn | null>> {
      return refuse(async () => {
        const row = await readOne(scope, turnId);
        return ok(row === null ? null : readTurn(row));
      }, "turns findTurn");
    },

    async findTurnWithSteps(
      scope: EnvironmentScope,
      turnId: TurnId,
    ): Promise<Result<TurnWithSteps | null>> {
      return refuse(async () => {
        const row = await readOne(scope, turnId);
        if (row === null) return ok(null);
        // ONE read, TWO shapes. The steps are already in hand for the rollup, so
        // answering them costs nothing further; a second query for the same rows
        // would be an N+1 whose two halves happen to be in the same method.
        return ok({ turn: readTurn(row), steps: row.steps.map(readStep) });
      }, "turns findTurnWithSteps");
    },

    async pageTurns(query: TurnPageQuery): Promise<Result<TurnPage>> {
      return refuse(async () => {
        const where = {
          threadId: query.threadId,
          ...turnScopedWhere(query.scope),
          // A sub-thread turn hangs off a parent turn. `includeSubThreads` false
          // is what a transcript shows, and the port says so; the filter is on
          // the COLUMN rather than on a join, because `parentTurnId` is the only
          // thing that makes a turn a reply.
          ...(query.includeSubThreads ? {} : { parentTurnId: null }),
        };
        const reader = transactions.reader();
        const rows = await reader.turn.findMany({
          where,
          select: TURN_COLUMNS,
          // `sequence` is unique within a thread, so this order is already
          // TOTAL and needs no tie-break — which is the one listing in this
          // package that can say so.
          orderBy: { sequence: "asc" },
          skip: query.offset,
          take: query.limit,
        });
        const total = await reader.turn.count({ where });
        return ok({ items: rows.map((row) => readTurn(row as unknown as SelectedTurn)), total });
      }, "turns pageTurns");
    },

    async readTranscriptTurns(
      scope: EnvironmentScope,
      threadId: ThreadId,
      afterSequence: number,
      limit: number,
    ): Promise<Result<readonly Turn[]>> {
      return refuse(async () => {
        // SUCCEEDED ONLY, exactly as the port says. A failed or cancelled turn
        // has no answer to put in front of a model, and a transcript that
        // carried one would replay a question the agent never answered.
        //
        // THE IN-MEMORY DOUBLE DOES NOT FILTER. It selects on the thread and the
        // sequence alone, so it answers a FAILED turn where this answers none;
        // the port's own sentence is the contract and this follows it. The
        // divergence is real and is named as a case in
        // `conversations-rules.integration.test.ts` rather than hidden, because
        // the conformance differential cannot see it: a scenario that seeded an
        // unsettled turn would fail on the double's behaviour, not on this.
        const rows = await transactions.reader().turn.findMany({
          where: {
            threadId,
            ...turnScopedWhere(scope),
            status: "SUCCEEDED",
            sequence: { gt: afterSequence },
          },
          select: TURN_COLUMNS,
          orderBy: { sequence: "asc" },
          take: limit,
        });
        return ok(rows.map((row) => readTurn(row as unknown as SelectedTurn)));
      }, "turns readTranscriptTurns");
    },

    async findTurnByIdempotencyKey(
      scope: EnvironmentScope,
      threadId: ThreadId,
      key: IdempotencyKey,
    ): Promise<Result<Turn | null>> {
      return refuse(async () => {
        const row = await transactions.reader().turn.findFirst({
          where: { threadId, idempotencyKey: key, ...turnScopedWhere(scope) },
          select: TURN_COLUMNS,
        });
        return ok(row === null ? null : readTurn(row as unknown as SelectedTurn));
      }, "turns findTurnByIdempotencyKey");
    },

    async createTurn(scope: EnvironmentScope, turn: Turn): Promise<Result<Turn>> {
      return refuse(async () => {
        guardTurnWrite(turn);
        return transactions.atomic(async (client) => {
          const written = await refusable(
            client,
            () =>
              client.turn.create({
                data: {
                  id: turn.turnId,
                  threadId: turn.threadId,
                  parentTurnId: turn.parentTurnId,
                  agentVersionId: turn.agentVersionId,
                  versionBucket: turn.versionBucket,
                  sequence: turn.sequence,
                  inputText: turn.inputText,
                  outputText: turn.outputText,
                  input: nullableJson(turn.input),
                  output: nullableJson(turn.output),
                  thinkingContent: turn.thinkingContent,
                  status: turn.status,
                  externalRuntimeId: turn.externalRuntimeId,
                  idempotencyKey: turn.idempotencyKey,
                  // A turn with no steps yet costs NOTHING, and null is the
                  // wrong spelling of nothing: `Turn_usage_check` admits both,
                  // and a null here would read back through `rollUpTurnCost` as
                  // zero anyway. Zero is written so the column says what the
                  // domain says rather than leaving a reader to infer it.
                  costCents: moneyToCentsString(turn.cost.amount),
                  latencyMs: turn.latencyMs,
                  startedAt: turn.startedAt,
                  completedAt: turn.completedAt,
                  createdAt: turn.createdAt,
                },
                select: TURN_COLUMNS,
              }),
            sequenceClash(turn),
          );
          if (!written.ok) return err(written.error);
          return ok(readTurn(written.value as unknown as SelectedTurn));
        });
      }, "turns createTurn");
    },

    async saveSettlement(
      scope: EnvironmentScope,
      settlement: TurnWithSteps,
    ): Promise<Result<TurnWithSteps>> {
      return refuse(async () => {
        guardTurnWrite(settlement.turn);
        for (const step of settlement.steps) guardStepWrite(step);
        // THE COLUMN IS THE ROLLUP OVER THE STEPS IN THIS CALL, which is the
        // port's own sentence rather than a re-derivation: "`Turn.costCents` is
        // derived from exactly the steps in this call". A caller that handed a
        // turn whose `cost` came from a different set of steps would otherwise
        // store a total its own rows do not add up to, and no read would ever
        // notice — this store answers `Turn.cost` from the steps.
        const rolled = rollUpTurnCost(settlement.steps);
        return transactions.atomic(async (client) => {
          // SCOPED, and `updateMany` rather than `update` because the scope is a
          // relation filter through `Thread` and a unique-`where` update cannot
          // carry one. A turn in another environment matches nothing and writes
          // nothing, which is the refusal a cross-tenant settlement should get.
          const updated = await client.turn.updateMany({
            where: { id: settlement.turn.turnId, ...turnScopedWhere(scope) },
            data: {
              outputText: settlement.turn.outputText,
              output: nullableJson(settlement.turn.output),
              thinkingContent: settlement.turn.thinkingContent,
              status: settlement.turn.status,
              externalRuntimeId: settlement.turn.externalRuntimeId,
              costCents: moneyToCentsString(rolled.amount),
              latencyMs: settlement.turn.latencyMs,
              startedAt: settlement.turn.startedAt,
              completedAt: settlement.turn.completedAt,
            },
          });
          // NO ROW MATCHED means the turn is not in this environment — a
          // settlement addressed across a tenant boundary, or one for a turn
          // that has been erased. `CONVERSATIONS_TURN_NOT_FOUND` is the code for
          // both, and it is deliberately NOT the sequence-clash code: those are
          // two different mistakes and a caller retries only one of them.
          if (updated.count === 0) return err(turnNotFound(settlement.turn.turnId));
          // REPLACE, NEVER MERGE. The port says a settlement is the whole record
          // of the turn, and merging would let a step from a previous try
          // survive into a rollup it was never part of.
          //
          // DELETE-THEN-INSERT RATHER THAN UPSERT, and `Step_price_snapshot` is
          // the reason. That trigger makes a PRICED step's billing evidence
          // immutable on UPDATE — `RAISE EXCEPTION 'priced Step billing evidence
          // is immutable'` — so an upsert that touched a re-priced row would be
          // refused by the database. A delete is not an update, so a settlement
          // that supersedes an earlier one is admitted while an in-place edit of
          // a bill stays impossible. That is the schema's intent, not a way
          // around it: the row that replaces it is a new row with its own id.
          await client.step.deleteMany({ where: { turnId: settlement.turn.turnId } });
          if (settlement.steps.length > 0) {
            await client.step.createMany({ data: settlement.steps.map(stepInsert) });
          }
          return ok(settlement);
        });
      }, "turns saveSettlement");
    },

    async countToolCalls(
      scope: EnvironmentScope,
      turnIds: readonly TurnId[],
    ): Promise<Result<ReadonlyMap<TurnId, number>>> {
      return refuse(async () => {
        const counts = new Map<TurnId, number>();
        // EVERY REQUESTED TURN IS IN THE ANSWER, at zero if it made no call —
        // which is what the double does and what `transcript.ts` needs: a turn
        // missing from the map and a turn that called nothing are the same fact,
        // and a caller that had to tell them apart would be reading absence as
        // meaning.
        for (const turnId of turnIds) counts.set(turnId, 0);
        if (turnIds.length === 0) return ok(counts as ReadonlyMap<TurnId, number>);
        // ONE statement for the whole list. A `ToolCall` hangs off a `Step` and
        // a step off a turn, so the count is per STEP and folded here; asking
        // per turn would be the N+1 this shape is easy to write by accident.
        const rows = await transactions.reader().step.findMany({
          where: { turnId: { in: [...turnIds] }, turn: turnScopedWhere(scope) },
          select: { turnId: true, _count: { select: { toolCalls: true } } },
        });
        for (const row of rows) {
          const turnId = row.turnId as TurnId;
          counts.set(turnId, (counts.get(turnId) ?? 0) + row._count.toolCalls);
        }
        return ok(counts as ReadonlyMap<TurnId, number>);
      }, "turns countToolCalls");
    },
  };
}
