// The `RatingsRepository` — `governance`'s `MessageRating` half.
//
// THE UNIQUE CONSTRAINT IS THE MODEL, AND THE STATEMENTS SAY SO. There is no
// `insert`: `upsert` is keyed on `[turnId, endUserId]` exactly as
// `@@unique([turnId, endUserId])` is, so one person's vote on one turn is a row
// that FLIPS rather than a log that accumulates.
//
// AND THE FLIP IS SCOPED, WHICH THE CONSTRAINT ALONE IS NOT. The unique key is
// installation-wide — it names no environment — so a client `upsert` keyed on it
// would have UPDATED a row in another tenant's environment whenever the two ids
// collided. Every statement below therefore carries `environmentId` in its
// WHERE, and the create path is reached only when the scoped update matched
// nothing. That is the same reasoning `cost-budgets.ts` gives for keying its
// update on `(id, environmentId)` rather than on `id`.
//
// *** THE MIGRATION CHANGES ITS OWN MIND ABOUT THIS COLUMN, AND THAT IS THE
// FINDING. *** `00000000000000_initial/migration.sql` installs
// `MessageRating_rating_check CHECK ("rating" BETWEEN 1 AND 5)` at line 2799,
// and at line 3802 — in the SAME FILE, 1,000 lines later — DROPS it and installs
// `CHECK ("rating" IN (-1, 1))`, behind a preflight block that refuses to build
// the database at all if any row holds 2, 3, 4 or 5. It adds `revision` and
// `CHECK ("revision" > 0)` in the same breath.
//
// A reader who stopped at the first constraint would have written an adapter
// that refused every thumbs-DOWN the product emits and accepted four values no
// database this migration builds can hold. `governance-guards.ts` restates the
// constraint the file ENDS with, and the pair of named cases in
// `governance-constraints.integration.test.ts` stands both halves side by side:
// `-1` is stored, `3` is refused.
//
// READS THAT FOLD ARE SUBJECT-FREE BY SELECTION, not only by return type.
// `sample` and `tallyTurn` select three columns and `endUserId` is not one of
// them, so a rollup cannot leak a subject even if its return type changed.

import type {
  EndUserId,
  EnvironmentScope,
  MessageRating,
  RatingSampleQuery,
  RatingSubjectSelector,
  RatingWrite,
  RatingsRepository,
  Result,
  SatisfactionInput,
  TransactionScope,
  TurnId,
} from "@platos/context-governance/application/ports/index.js";
import {
  asGovernanceIdentifier,
  err,
  ledgerUnavailable,
  ok,
  type AgentId,
  type AgentVersionId,
} from "@platos/context-governance/application/ports/index.js";

import {
  requireStorableRating,
  requireStorableRevision,
  requireUuid,
} from "./governance-guards.js";
import { refuse } from "./governance-refusal.js";
import { readMessageRating, scopedWhere, tenantWhere, type MessageRatingRow } from "./governance-rows.js";
import type { TenancyTransactions } from "./transaction.js";

const RATING_COLUMNS = {
  id: true,
  environmentId: true,
  turnId: true,
  agentId: true,
  agentVersionId: true,
  endUserId: true,
  rating: true,
  revision: true,
  comment: true,
  createdAt: true,
  updatedAt: true,
} as const;

/** The three columns a rollup may see. `endUserId` is deliberately not one. */
const SAMPLE_COLUMNS = { agentId: true, agentVersionId: true, rating: true } as const;

function toSample(row: {
  readonly agentId: string;
  readonly agentVersionId: string | null;
  readonly rating: number;
}): SatisfactionInput {
  return {
    agentId: asGovernanceIdentifier<AgentId>(row.agentId),
    agentVersionId:
      row.agentVersionId === null ? null : asGovernanceIdentifier<AgentVersionId>(row.agentVersionId),
    rating: row.rating,
  };
}

export function createRatingsRepository(
  transactions: TenancyTransactions,
  now: () => Date,
): RatingsRepository {
  return {
    async findForTurn(
      scope: EnvironmentScope,
      turnId: TurnId,
      endUserId: EndUserId,
    ): Promise<Result<MessageRating | null>> {
      return refuse(async () => {
        const row = await transactions.reader().messageRating.findFirst({
          where: { turnId, endUserId, ...scopedWhere(scope) },
          select: RATING_COLUMNS,
        });
        return ok(row === null ? null : readMessageRating(row as MessageRatingRow));
      }, "ratings findForTurn");
    },

    async upsert(
      scope: EnvironmentScope,
      write: RatingWrite,
      transaction: TransactionScope,
    ): Promise<Result<MessageRating>> {
      return refuse(async () => {
        requireUuid("MessageRating.turnId", write.turnId);
        requireUuid("MessageRating.agentId", write.agentId);
        requireUuid("MessageRating.agentVersionId", write.agentVersionId);
        requireUuid("MessageRating.endUserId", write.endUserId);
        requireStorableRating(write.rating);
        requireStorableRevision(write.revision);

        const client = transactions.writer(transaction);
        const at = now();
        // TWO statements on BOTH paths, which is what makes the count a pin
        // rather than a coincidence of which path a fixture happened to take.
        // The scoped update runs first because the flip is the common case and
        // because an unscoped upsert would reach another environment's row.
        const flipped = await client.messageRating.updateMany({
          where: { turnId: write.turnId, endUserId: write.endUserId, ...scopedWhere(scope) },
          data: {
            rating: write.rating,
            comment: write.comment,
            revision: write.revision,
            agentVersionId: write.agentVersionId,
            updatedAt: at,
          },
        });
        if (flipped.count > 0) {
          const row = await client.messageRating.findFirst({
            where: { turnId: write.turnId, endUserId: write.endUserId, ...scopedWhere(scope) },
            select: RATING_COLUMNS,
          });
          if (row === null) return err(ledgerUnavailable("rating vanished between update and read"));
          return ok(readMessageRating(row as MessageRatingRow));
        }
        // `skipDuplicates` rather than a plain insert, because the unique key is
        // installation-wide: a row for this `[turn, endUser]` in ANOTHER
        // environment refuses this one, and a raised constraint would abort the
        // caller's transaction instead of answering. A count of zero is that
        // case, and it is reported as a refusal rather than as a flip that did
        // not happen.
        const created = await client.messageRating.createManyAndReturn({
          data: [
            {
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
            },
          ],
          skipDuplicates: true,
          select: RATING_COLUMNS,
        });
        const row = created[0];
        if (row === undefined) {
          return err(ledgerUnavailable("rating for this turn and end user exists in another environment"));
        }
        return ok(readMessageRating(row as MessageRatingRow));
      }, "ratings upsert");
    },

    async remove(
      scope: EnvironmentScope,
      turnId: TurnId,
      endUserId: EndUserId,
      transaction: TransactionScope,
    ): Promise<Result<boolean>> {
      return refuse(async () => {
        const client = transactions.writer(transaction);
        const outcome = await client.messageRating.deleteMany({
          where: { turnId, endUserId, ...scopedWhere(scope) },
        });
        return ok(outcome.count > 0);
      }, "ratings remove");
    },

    async tallyTurn(
      scope: EnvironmentScope,
      turnId: TurnId,
    ): Promise<Result<readonly SatisfactionInput[]>> {
      return refuse(async () => {
        const rows = await transactions.reader().messageRating.findMany({
          where: { turnId, ...scopedWhere(scope) },
          select: SAMPLE_COLUMNS,
          orderBy: [{ createdAt: "asc" }, { id: "asc" }],
        });
        return ok(rows.map(toSample));
      }, "ratings tallyTurn");
    },

    async sample(
      scope: EnvironmentScope,
      query: RatingSampleQuery,
    ): Promise<Result<readonly SatisfactionInput[]>> {
      return refuse(async () => {
        const rows = await transactions.reader().messageRating.findMany({
          where: {
            ...scopedWhere(scope),
            createdAt: { gte: query.since },
            ...(query.agentId === null ? {} : { agentId: query.agentId }),
          },
          select: SAMPLE_COLUMNS,
          orderBy: [{ createdAt: "asc" }, { id: "asc" }],
        });
        return ok(rows.map(toSample));
      }, "ratings sample");
    },

    async countSubject(selector: RatingSubjectSelector): Promise<Result<number>> {
      return refuse(async () => {
        // A null subject matches NOTHING, and it is answered without a statement
        // so the rule holds even if the filter below were wrong.
        if (selector.endUserId === null) return ok(0);
        const total = await transactions.reader().messageRating.count({
          where: { endUserId: selector.endUserId, ...tenantWhere(selector.scope) },
        });
        return ok(total);
      }, "ratings countSubject");
    },

    async eraseSubject(
      selector: RatingSubjectSelector,
      transaction: TransactionScope,
    ): Promise<Result<number>> {
      return refuse(async () => {
        const client = transactions.writer(transaction);
        if (selector.endUserId === null) return ok(0);
        // DESTROYED, not anonymised, unlike a safety event. A rating IS the
        // subject's opinion — there is no compliance record left once the
        // subject is removed from it — which is why the port names the two
        // methods differently and why this one is a DELETE.
        const outcome = await client.messageRating.deleteMany({
          where: { endUserId: selector.endUserId, ...tenantWhere(selector.scope) },
        });
        return ok(outcome.count);
      }, "ratings eraseSubject");
    },
  };
}
