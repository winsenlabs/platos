// The `RatingsRepository` port — the MessageRating table, seen as an interface.
//
// ADR M0.3 §1 row 14 makes this context the SOLE WRITER of `MessageRating`.
//
// THE UNIQUE CONSTRAINT IS IN THE PORT, NOT ONLY IN THE SCHEMA.
// `@@unique([turnId, endUserId])` is what makes one person's vote on one turn a
// single row that flips rather than a log that accumulates, so `upsert` takes
// exactly that pair as its key and there is no `insert`. An implementation that
// wrote two rows for one pair would break the satisfaction denominator silently,
// which is why the in-memory double in `application/testing/` enforces the
// constraint rather than merely storing what it is given.
//
// READS ARE ANONYMISED BY THE RETURN TYPE. `sample` answers `SatisfactionInput`,
// which carries no subject at all, so a rollup that leaked one would not
// compile. The only method that returns a subject is `findForTurn`, and it is
// the one a caller uses to read back its OWN vote.

import type { EnvironmentScope, Result, TenantScope, TransactionScope } from "@platos/kernel";

import type {
  AgentId,
  AgentVersionId,
  EndUserId,
  MessageRating,
  RatingValue,
  SatisfactionInput,
  TurnId,
} from "../../domain/index.js";

/** The fields a write supplies. The row's id and timestamps are the store's. */
export interface RatingWrite {
  readonly turnId: TurnId;
  readonly agentId: AgentId;
  readonly agentVersionId: AgentVersionId | null;
  readonly endUserId: EndUserId;
  readonly rating: RatingValue;
  readonly comment: string | null;
  readonly revision: number;
}

export interface RatingSampleQuery {
  readonly since: Date;
  /** Null samples every agent in the environment — the scorecard axis. */
  readonly agentId: AgentId | null;
}

/** Whose ratings an erasure touches. A null id matches nothing. */
export interface RatingSubjectSelector {
  readonly scope: TenantScope;
  readonly endUserId: EndUserId | null;
}

export interface RatingsRepository {
  /** The current vote for one `[turn, endUser]` pair, or null. */
  findForTurn(
    scope: EnvironmentScope,
    turnId: TurnId,
    endUserId: EndUserId,
  ): Promise<Result<MessageRating | null>>;

  /** Write or flip one vote. Keyed by `[turnId, endUserId]`; never inserts twice. */
  upsert(
    scope: EnvironmentScope,
    write: RatingWrite,
    transaction: TransactionScope,
  ): Promise<Result<MessageRating>>;

  /** Withdraw one vote. Answers false when there was nothing to withdraw. */
  remove(
    scope: EnvironmentScope,
    turnId: TurnId,
    endUserId: EndUserId,
    transaction: TransactionScope,
  ): Promise<Result<boolean>>;

  /** Every current vote on one turn, for the display aggregate. Subject-free. */
  tallyTurn(scope: EnvironmentScope, turnId: TurnId): Promise<Result<readonly SatisfactionInput[]>>;

  /** Rows a satisfaction rollup folds. Subject-free by return type. */
  sample(scope: EnvironmentScope, query: RatingSampleQuery): Promise<Result<readonly SatisfactionInput[]>>;

  /** How many rows an erasure would destroy. MUST NOT mutate. */
  countSubject(selector: RatingSubjectSelector): Promise<Result<number>>;

  /** Destroy the subject's rows in the caller's transaction. Returns the count. */
  eraseSubject(selector: RatingSubjectSelector, transaction: TransactionScope): Promise<Result<number>>;
}
