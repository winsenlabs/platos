// An in-memory `RatingsRepository` that enforces `@@unique([turnId, endUserId])`.
//
// The constraint is the whole model — one person, one turn, one current opinion
// — so the double UPSERTS on that pair rather than pushing rows. A double that
// merely stored what it was given would let a use case that inserted twice pass,
// and the satisfaction denominator would be wrong in production only.
//
// `sample` RETURNS A SUBJECT-FREE SHAPE, exactly as the port declares, so a
// rollup that leaked one would not compile against this double either.

import { err, ok, asIdentifier, type EnvironmentScope, type Result, type TransactionScope } from "@platos/kernel";

import {
  ledgerUnavailable,
  type EndUserId,
  type MessageRating,
  type MessageRatingId,
  type SatisfactionInput,
  type TurnId,
} from "../../domain/index.js";
import type {
  RatingSampleQuery,
  RatingSubjectSelector,
  RatingWrite,
  RatingsRepository,
} from "../ports/index.js";
import { scopeReaches, type StoredScope } from "./scope-match.js";

interface StoredRating extends MessageRating {
  readonly stored: StoredScope;
}

export class InMemoryRatingsRepository implements RatingsRepository {
  private readonly rows: StoredRating[] = [];
  private counter = 0;
  private failure: string | null = null;

  constructor(private readonly now: () => Date) {}

  failNext(reason: string): void {
    this.failure = reason;
  }

  size(): number {
    return this.rows.length;
  }

  all(): readonly MessageRating[] {
    return this.rows;
  }

  async findForTurn(
    scope: EnvironmentScope,
    turnId: TurnId,
    endUserId: EndUserId,
  ): Promise<Result<MessageRating | null>> {
    const failed = this.takeFailure();
    if (failed !== null) return err(failed);
    return ok(this.locate(scope, turnId, endUserId) ?? null);
  }

  async upsert(
    scope: EnvironmentScope,
    write: RatingWrite,
    _transaction: TransactionScope,
  ): Promise<Result<MessageRating>> {
    const failed = this.takeFailure();
    if (failed !== null) return err(failed);
    const at = this.now();
    const existing = this.locate(scope, write.turnId, write.endUserId);
    const stored: StoredScope = {
      organizationId: scope.organizationId,
      projectId: scope.projectId,
      environmentId: scope.environmentId,
    };
    if (existing !== undefined) {
      const updated: StoredRating = {
        ...existing,
        rating: write.rating,
        comment: write.comment,
        revision: write.revision,
        agentVersionId: write.agentVersionId,
        updatedAt: at,
      };
      this.rows[this.rows.indexOf(existing)] = updated;
      return ok(updated);
    }
    this.counter += 1;
    const row: StoredRating = {
      messageRatingId: asIdentifier<MessageRatingId>(`rating-${String(this.counter).padStart(4, "0")}`),
      environmentId: scope.environmentId,
      turnId: write.turnId,
      agentId: write.agentId,
      agentVersionId: write.agentVersionId,
      endUserId: write.endUserId,
      rating: write.rating,
      revision: write.revision,
      comment: write.comment,
      createdAt: at,
      updatedAt: at,
      stored,
    };
    this.rows.push(row);
    return ok(row);
  }

  async remove(
    scope: EnvironmentScope,
    turnId: TurnId,
    endUserId: EndUserId,
    _transaction: TransactionScope,
  ): Promise<Result<boolean>> {
    const failed = this.takeFailure();
    if (failed !== null) return err(failed);
    const existing = this.locate(scope, turnId, endUserId);
    if (existing === undefined) return ok(false);
    this.rows.splice(this.rows.indexOf(existing), 1);
    return ok(true);
  }

  async tallyTurn(scope: EnvironmentScope, turnId: TurnId): Promise<Result<readonly SatisfactionInput[]>> {
    const failed = this.takeFailure();
    if (failed !== null) return err(failed);
    return ok(
      this.rows
        .filter((row) => row.environmentId === scope.environmentId && row.turnId === turnId)
        .map(toSample),
    );
  }

  async sample(
    scope: EnvironmentScope,
    query: RatingSampleQuery,
  ): Promise<Result<readonly SatisfactionInput[]>> {
    const failed = this.takeFailure();
    if (failed !== null) return err(failed);
    return ok(
      this.rows
        .filter((row) => row.environmentId === scope.environmentId)
        .filter((row) => row.createdAt.getTime() >= query.since.getTime())
        .filter((row) => query.agentId === null || row.agentId === query.agentId)
        .map(toSample),
    );
  }

  async countSubject(selector: RatingSubjectSelector): Promise<Result<number>> {
    const failed = this.takeFailure();
    if (failed !== null) return err(failed);
    return ok(this.matchSubject(selector).length);
  }

  async eraseSubject(
    selector: RatingSubjectSelector,
    _transaction: TransactionScope,
  ): Promise<Result<number>> {
    const failed = this.takeFailure();
    if (failed !== null) return err(failed);
    const matched = this.matchSubject(selector);
    for (const row of matched) this.rows.splice(this.rows.indexOf(row), 1);
    return ok(matched.length);
  }

  /**
   * Store a row directly, bypassing admission.
   *
   * For the ONE case a use case cannot produce: a legacy row whose `rating` is
   * neither 1 nor -1, which `satisfaction.ts` must account for rather than
   * silently drop.
   */
  seedRaw(scope: EnvironmentScope, row: Omit<MessageRating, "messageRatingId" | "environmentId">): MessageRating {
    this.counter += 1;
    const stored: StoredRating = {
      ...row,
      messageRatingId: asIdentifier<MessageRatingId>(`rating-${String(this.counter).padStart(4, "0")}`),
      environmentId: scope.environmentId,
      stored: {
        organizationId: scope.organizationId,
        projectId: scope.projectId,
        environmentId: scope.environmentId,
      },
    };
    this.rows.push(stored);
    return stored;
  }

  private locate(scope: EnvironmentScope, turnId: TurnId, endUserId: EndUserId): StoredRating | undefined {
    return this.rows.find(
      (row) =>
        row.environmentId === scope.environmentId && row.turnId === turnId && row.endUserId === endUserId,
    );
  }

  private matchSubject(selector: RatingSubjectSelector): readonly StoredRating[] {
    if (selector.endUserId === null) return [];
    return this.rows.filter(
      (row) => row.endUserId === selector.endUserId && scopeReaches(selector.scope, row.stored),
    );
  }

  private takeFailure() {
    if (this.failure === null) return null;
    const reason = this.failure;
    this.failure = null;
    return ledgerUnavailable(reason);
  }
}

function toSample(row: MessageRating): SatisfactionInput {
  return { agentId: row.agentId, agentVersionId: row.agentVersionId, rating: row.rating };
}
