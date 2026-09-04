// The store behind `Turn` and `Step`, the two rows a running turn writes.
//
// TURNS AND STEPS SHARE A PORT BECAUSE THEY SHARE A LIFETIME. `Step` is
// `onDelete: Cascade` from `Turn`, a step outside a turn is not a row this
// schema can hold, and every write of one happens inside the same transaction as
// a write of the other. Splitting them would create a seam with no meaning on
// either side of it and a chance to write half a settlement.
//
// `findTurnByIdempotencyKey` IS THE REPLAY SEAM. `@@unique([threadId,
// idempotencyKey])` means a redelivered request cannot make a second turn; what
// the constraint cannot do is tell the caller which turn the FIRST delivery
// made. This method does, so a redelivery answers the original turn instead of
// a conflict — and `run-turn.ts` compares the input before it does, because one
// key with two different inputs is a different mistake with its own code.
//
// `saveSettlement` TAKES THE TURN AND ITS STEPS TOGETHER, and that is the whole
// reason it exists rather than a `saveTurn` and a `saveStep`. `Turn.costCents`
// is the sum of `Step.costCents`; writing them in two calls admits a window in
// which the rollup does not match its parts, and a reader in that window sees a
// turn whose cost disagrees with its own trace. One call, one transaction, one
// consistent pair.

import type { EnvironmentScope, Result } from "@platos/kernel";

import type {
  IdempotencyKey,
  Step,
  ThreadId,
  Turn,
  TurnId,
} from "../../domain/index.js";

export interface TurnPageQuery {
  readonly scope: EnvironmentScope;
  readonly threadId: ThreadId;
  readonly limit: number;
  readonly offset: number;
  /** Reply turns. False by default, matching what a transcript shows. */
  readonly includeSubThreads: boolean;
}

export interface TurnPage {
  readonly items: readonly Turn[];
  readonly total: number;
}

/** A turn and every step it produced, sub-agent steps included. */
export interface TurnWithSteps {
  readonly turn: Turn;
  readonly steps: readonly Step[];
}

export interface TurnRepository {
  findTurn(scope: EnvironmentScope, turnId: TurnId): Promise<Result<Turn | null>>;
  findTurnWithSteps(scope: EnvironmentScope, turnId: TurnId): Promise<Result<TurnWithSteps | null>>;
  pageTurns(query: TurnPageQuery): Promise<Result<TurnPage>>;

  /** Every SUCCEEDED turn of a thread after `afterSequence`, ascending. */
  readTranscriptTurns(
    scope: EnvironmentScope,
    threadId: ThreadId,
    afterSequence: number,
    limit: number,
  ): Promise<Result<readonly Turn[]>>;

  findTurnByIdempotencyKey(
    scope: EnvironmentScope,
    threadId: ThreadId,
    key: IdempotencyKey,
  ): Promise<Result<Turn | null>>;

  createTurn(scope: EnvironmentScope, turn: Turn): Promise<Result<Turn>>;

  /**
   * Persist a settled turn and every one of its steps, atomically.
   *
   * The steps REPLACE whatever the turn had: a settlement is the whole record of
   * the turn, and merging would let a step from a previous try survive into the
   * rollup. `Turn.costCents` is derived from exactly the steps in this call.
   */
  saveSettlement(scope: EnvironmentScope, settlement: TurnWithSteps): Promise<Result<TurnWithSteps>>;

  /** How many tool calls each turn made. What `transcript.ts` records as dropped. */
  countToolCalls(
    scope: EnvironmentScope,
    turnIds: readonly TurnId[],
  ): Promise<Result<ReadonlyMap<TurnId, number>>>;
}
