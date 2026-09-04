// Use cases: an end user's thumb on one turn.
//
// THREE GATES, IN THIS ORDER, AND THE ORDER IS THE DESIGN.
//
//   1. THE ACTOR. An operator principal is refused before anything is read, with
//      `GOVERNANCE_RATING_ACTOR_FORBIDDEN`. A satisfaction score an operator can
//      write is not a satisfaction score, and refusing first means an operator
//      probing turn ids learns nothing about which ones exist.
//   2. THE ENVIRONMENT. From the grant, never from the command.
//   3. THE TURN'S OWNER. The `RatingTargetReader` answers who owns the turn, and
//      an end user who is not that owner is refused with the SAME code as a turn
//      that does not exist. That is deliberate: distinguishing them is exactly
//      the probe that lets an authenticated end user enumerate other people's
//      turns. Both branches are exercised separately in the suite by asserting
//      that no row was written, so the shared code hides no untested path.
//
// THE VERSION ATTRIBUTION COMES FROM THE TURN, NOT FROM THE LIVE BINDING, AND
// THAT IS THE ONE PLACE THIS FILE DELIBERATELY DIFFERS FROM THE SOURCE. The
// source reads the agent's CURRENT active binding and stamps the rating with it,
// so a thumb pressed on a week-old turn after a promotion credits the new
// version with the old one's output. `readVersionSatisfaction` is then a canary
// dashboard reading a mixture, and nothing on the row says so. `Turn.
// agentVersionId` is a required column recording which version actually ran, so
// the `RatingTargetReader` carries it and the rating is attributed to it. When
// the reader cannot resolve one the rating is still written with a null version:
// refusing the vote because a dashboard column would be empty would lose the
// signal to save the label.
//
// THE WHOLE WRITE IS ONE TRANSACTION. The source wraps its upsert and its memory
// reconciliation together for a stated reason — "removes the crash window
// between rating persistence and authoritative aggregate application" — and the
// shape is kept: the revision read that DECIDES the write runs inside the same
// unit of work as the write, so two concurrent votes on one turn cannot both
// read revision 1.
//
// THE RETURNED VIEW IS THE WRITE'S OWN ANSWER, not a read-back. There is no
// second read to be inside or outside the transaction, and `RatingsRepository`
// deliberately gives `findForTurn` no `TransactionScope` while `upsert` and
// `remove` have one: this context reads outside a transaction and writes inside
// exactly one.

import { err, ok, type EnvironmentScope, type Result } from "@platos/kernel";

import {
  admitRatingComment,
  admitRatingValue,
  nextRevision,
  ratingTargetNotFound,
  tally,
  type MessageRating,
  type RatingTally,
  type TurnId,
} from "../domain/index.js";
import { verifyRatingActor, type RatingActor } from "./authorization.js";
import type { GovernanceDependencies } from "./dependencies.js";
import type { RatingTarget } from "./ports/index.js";

export interface RateTurnCommand {
  readonly authorization: unknown;
  readonly actor: RatingActor;
  readonly turnId: TurnId;
  readonly rating: number;
  readonly comment?: string | null;
}

export interface WithdrawRatingCommand {
  readonly authorization: unknown;
  readonly actor: RatingActor;
  readonly turnId: TurnId;
}

export interface ReadTurnRatingQuery {
  readonly authorization: unknown;
  readonly actor: RatingActor;
  readonly turnId: TurnId;
}

export interface TurnRatingResult {
  /** This actor's own current vote, or null when they have not voted. */
  readonly own: MessageRating | null;
  /** Every current vote on the turn. Carries no subject. */
  readonly aggregate: RatingTally;
}

export async function rateTurn(
  dependencies: GovernanceDependencies,
  command: RateTurnCommand,
): Promise<Result<MessageRating>> {
  const actor = verifyRatingActor(dependencies, command.authorization, command.actor);
  if (!actor.ok) return err(actor.error);
  const value = admitRatingValue(command.rating);
  if (!value.ok) return err(value.error);
  const comment = admitRatingComment(command.comment ?? null, dependencies.policy.ratings.maxCommentLength);
  if (!comment.ok) return err(comment.error);

  const scope = actor.value.grant.scope;
  const target = await resolveTarget(dependencies, scope, command.turnId, actor.value.endUserId);
  if (!target.ok) return err(target.error);

  return dependencies.unitOfWork.run(async (transaction) => {
    const existing = await dependencies.ratings.findForTurn(scope, command.turnId, actor.value.endUserId);
    if (!existing.ok) return err(existing.error);
    return dependencies.ratings.upsert(
      scope,
      {
        turnId: target.value.turnId,
        agentId: target.value.agentId,
        agentVersionId: target.value.agentVersionId,
        endUserId: actor.value.endUserId,
        rating: value.value,
        comment: comment.value,
        revision: nextRevision(existing.value),
      },
      transaction,
    );
  });
}

/** Withdraw a vote. Idempotent: withdrawing nothing answers false, not an error. */
export async function withdrawRating(
  dependencies: GovernanceDependencies,
  command: WithdrawRatingCommand,
): Promise<Result<boolean>> {
  const actor = verifyRatingActor(dependencies, command.authorization, command.actor);
  if (!actor.ok) return err(actor.error);
  const scope = actor.value.grant.scope;
  const target = await resolveTarget(dependencies, scope, command.turnId, actor.value.endUserId);
  if (!target.ok) return err(target.error);
  return dependencies.unitOfWork.run((transaction) =>
    dependencies.ratings.remove(scope, target.value.turnId, actor.value.endUserId, transaction),
  );
}

/** Read this actor's own vote plus the turn's anonymous aggregate. */
export async function readTurnRating(
  dependencies: GovernanceDependencies,
  query: ReadTurnRatingQuery,
): Promise<Result<TurnRatingResult>> {
  const actor = verifyRatingActor(dependencies, query.authorization, query.actor);
  if (!actor.ok) return err(actor.error);
  const scope = actor.value.grant.scope;
  const target = await resolveTarget(dependencies, scope, query.turnId, actor.value.endUserId);
  if (!target.ok) return err(target.error);

  const own = await dependencies.ratings.findForTurn(scope, query.turnId, actor.value.endUserId);
  if (!own.ok) return err(own.error);
  const all = await dependencies.ratings.tallyTurn(scope, query.turnId);
  if (!all.ok) return err(all.error);
  return ok({ own: own.value, aggregate: tally(all.value) });
}

/**
 * Resolve the turn and confirm this actor owns it.
 *
 * A missing turn and somebody else's turn answer identically; see the header.
 */
async function resolveTarget(
  dependencies: GovernanceDependencies,
  scope: EnvironmentScope,
  turnId: TurnId,
  endUserId: string,
): Promise<Result<RatingTarget>> {
  const found = await dependencies.ratingTargets.find(scope, turnId);
  if (!found.ok) return err(found.error);
  if (found.value === null) return err(ratingTargetNotFound(turnId));
  if (found.value.endUserId !== endUserId) return err(ratingTargetNotFound(turnId));
  return ok(found.value);
}
