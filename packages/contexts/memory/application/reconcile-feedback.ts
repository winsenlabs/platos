// Use case: reconcile a memory's confidence from the ratings that are current.
//
// A `MessageRating` is a thumb on a TURN, and a turn can source several
// memories while a memory can be sourced from several turns. So confidence is
// not a running total that ratings increment — it is RECOMPUTED, every time,
// from the ratings that exist right now. A rating that was changed or deleted
// therefore leaves no residue, which a counter could never manage.
//
// THE STALENESS CHECK IS WHAT MAKES CONCURRENT RECONCILIATIONS SAFE. Each one is
// scheduled against the `revision` that provoked it. A later upsert either wins
// before this work runs — making this one stale, and it stops — or is scheduled
// after it. Without that check, two jobs would finish in arrival order rather
// than in revision order, and the older thumb could be the one that lands.
//
// EVERYTHING RUNS IN ONE TRANSACTION. The revision read and the writes have to
// see one another: reading the revision outside the transaction that writes
// would reintroduce exactly the race the check exists to close.
//
// THE TWO ENTRY POINTS ARE THE TWO EVENTS. A rating was written (`fromRating`,
// which checks the revision) or a rating was removed (`fromTurn`, which has no
// revision to check because the row it would have read is gone). Both end in the
// same recomputation over the same turns.

import { err, ok, type Result, type TransactionScope } from "@platos/kernel";

import {
  isUsableRevision,
  queryInvalid,
  reconcileConfidence,
  standingFor,
  tallyRatings,
  type EndUserId,
  type Memory,
  type ReconciliationStanding,
  type TurnId,
} from "../domain/index.js";
import { verifyGrant } from "./authorization.js";
import type { MemoryDependencies } from "./dependencies.js";
import type { EnvironmentScope } from "@platos/kernel";

export interface ReconcileRatingCommand {
  readonly authorization: unknown;
  /** The `MessageRating` row that provoked this work. */
  readonly ratingId: string;
  /** The revision this work was scheduled against. */
  readonly expectedRevision: number;
}

export interface ReconcileTurnCommand {
  readonly authorization: unknown;
  readonly environment: EnvironmentScope;
  readonly endUserId: EndUserId;
  readonly turnId: TurnId;
}

export interface ReconciliationReport {
  readonly standing: ReconciliationStanding;
  /** How many memories had their confidence rewritten. */
  readonly updated: number;
  /** How many of those are now withdrawn from recall. */
  readonly quarantined: number;
}

export async function reconcileFromRating(
  dependencies: MemoryDependencies,
  command: ReconcileRatingCommand,
): Promise<Result<ReconciliationReport>> {
  const granted = verifyGrant(dependencies, command.authorization);
  if (!granted.ok) return err(granted.error);
  if (command.ratingId.trim().length === 0) {
    return err(queryInvalid("a rating id is required", "ratingId"));
  }
  if (!isUsableRevision(command.expectedRevision)) {
    return err(queryInvalid("a rating revision must be a positive whole number", "expectedRevision"));
  }

  return dependencies.unitOfWork.run(async (transaction) => {
    const rating = await dependencies.repository.findRatingRevision(command.ratingId);
    if (!rating.ok) return err(rating.error);

    const standing = standingFor(rating.value?.revision ?? null, command.expectedRevision);
    if (standing !== "applied" || rating.value === null) {
      return ok({ standing, updated: 0, quarantined: 0 });
    }
    return recompute(
      dependencies,
      { environment: rating.value.environment, endUserId: rating.value.endUserId, turnId: rating.value.turnId },
      transaction,
    );
  });
}

/**
 * Recompute after a rating was REMOVED.
 *
 * There is no revision to check: the row that carried it no longer exists, and
 * treating its absence as "stale" would leave every memory it had withdrawn
 * withdrawn forever. The caller may pass its own transaction, so the deletion
 * and this recomputation commit or roll back together.
 */
export async function reconcileFromTurn(
  dependencies: MemoryDependencies,
  command: ReconcileTurnCommand,
): Promise<Result<ReconciliationReport>> {
  const granted = verifyGrant(dependencies, command.authorization);
  if (!granted.ok) return err(granted.error);
  return dependencies.unitOfWork.run(async (transaction) =>
    recompute(
      dependencies,
      { environment: command.environment, endUserId: command.endUserId, turnId: command.turnId },
      transaction,
    ),
  );
}

async function recompute(
  dependencies: MemoryDependencies,
  provenance: {
    readonly environment: EnvironmentScope;
    readonly endUserId: EndUserId;
    readonly turnId: TurnId;
  },
  transaction: TransactionScope,
): Promise<Result<ReconciliationReport>> {
  const affected = await dependencies.repository.listMemoriesForSourceTurn(
    provenance.environment,
    provenance.endUserId,
    provenance.turnId,
  );
  if (!affected.ok) return err(affected.error);
  if (affected.value.length === 0) return ok({ standing: "applied", updated: 0, quarantined: 0 });

  const now = dependencies.clock.now();
  let quarantined = 0;
  for (const memory of affected.value) {
    // EVERY source turn of THIS memory, not only the one that changed. A memory
    // sourced from four turns with three thumbs-up and one thumbs-down is at
    // +0.2 and withdrawn; recomputing from the single changed turn would give a
    // different answer for the same state.
    const ratings = await currentRatings(dependencies, provenance, memory);
    if (!ratings.ok) return err(ratings.error);

    const reconciled = reconcileConfidence(
      {
        confidence: memory.confidence.confidence,
        feedbackBaselineConfidence: memory.confidence.feedbackBaselineConfidence,
        quarantinedAt: memory.lifecycle.quarantinedAt,
      },
      tallyRatings(ratings.value),
      now,
    );
    if (reconciled.quarantinedAt !== null) quarantined += 1;

    const applied = await dependencies.repository.applyReconciledConfidence(
      memory.memoryId,
      reconciled,
      transaction,
    );
    if (!applied.ok) return err(applied.error);
  }
  return ok({ standing: "applied", updated: affected.value.length, quarantined });
}

async function currentRatings(
  dependencies: MemoryDependencies,
  provenance: { readonly environment: EnvironmentScope; readonly endUserId: EndUserId },
  memory: Memory,
): Promise<Result<readonly number[]>> {
  const ratings = await dependencies.repository.listRatingsForTurns(
    provenance.environment,
    provenance.endUserId,
    memory.provenance.sourceTurnIds,
  );
  if (!ratings.ok) return err(ratings.error);
  return ok(ratings.value.map((rating) => rating.rating));
}
