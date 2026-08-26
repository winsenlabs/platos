import { Inject, Injectable } from "@nestjs/common";
import { PRISMA_TOKEN, type ControlDatabaseClient } from "../shared/database.provider";

export interface ReconcilePersistedRatingInput {
  ratingId: string;
  expectedRevision: number;
}

export interface ReconcilePersistedRatingResult {
  status: "applied" | "stale" | "missing";
  updated: number;
}

export interface ReconcilePersistedTurnRatingsInput {
  environmentId: string;
  endUserId: string;
  turnId: string;
}

interface LockedRating {
  id: string;
  environmentId: string;
  turnId: string;
  endUserId: string;
  revision: number;
}

interface LockedMemory {
  id: string;
  sourceTurnIds: string[];
  confidence: number | null;
  feedbackBaselineConfidence: number | null;
  quarantinedAt: Date | null;
}

/**
 * Reconciles memory state from authoritative, current MessageRating rows.
 *
 * The initiating rating is share-locked before its revision is checked. A
 * later upsert therefore either wins before this transaction (making this
 * job stale) or waits and schedules a newer revision after this job commits.
 * Each affected memory is update-locked while all current source-turn ratings
 * are aggregated, so concurrent jobs cannot finish in input-arrival order.
 */
@Injectable()
export class MemoryFeedbackService {
  constructor(@Inject(PRISMA_TOKEN) private readonly prisma: ControlDatabaseClient) {}

  async reconcilePersistedRating(
    input: ReconcilePersistedRatingInput,
    transactionClient?: any
  ): Promise<ReconcilePersistedRatingResult> {
    if (!input?.ratingId) throw new Error("Memory feedback requires a MessageRating id");
    if (!Number.isSafeInteger(input.expectedRevision) || input.expectedRevision < 1) {
      throw new Error("Memory feedback requires a positive rating revision");
    }

    if (transactionClient) return this.reconcileInTransaction(transactionClient, input);
    return this.prisma.$transaction((tx: any) => this.reconcileInTransaction(tx, input), {
      timeout: 30_000,
    });
  }

  private async reconcileInTransaction(
    tx: any,
    input: ReconcilePersistedRatingInput
  ): Promise<ReconcilePersistedRatingResult> {
    const ratings = (await tx.$queryRawUnsafe(
      `SELECT "id", "environmentId", "turnId", "endUserId", "revision"
         FROM "MessageRating"
         WHERE "id" = $1::uuid
         FOR SHARE`,
      input.ratingId
    )) as LockedRating[];
    const rating = ratings[0];
    if (!rating) return { status: "missing", updated: 0 };
    if (rating.revision !== input.expectedRevision) {
      return { status: "stale", updated: 0 };
    }

    const updated = await this.reconcileTurnRatingsInTransaction(tx, {
      environmentId: rating.environmentId,
      endUserId: rating.endUserId,
      turnId: rating.turnId,
    });
    return { status: "applied", updated };
  }

  /**
   * Recompute memories affected by a source turn after its rating is removed.
   * The caller may supply the transaction that deleted the rating so deletion
   * and aggregate reconciliation either commit or roll back together.
   */
  async reconcilePersistedTurnRatings(
    input: ReconcilePersistedTurnRatingsInput,
    transactionClient?: any
  ): Promise<{ updated: number }> {
    if (!input?.environmentId || !input.endUserId || !input.turnId) {
      throw new Error("Memory feedback requires environment, end-user, and turn provenance");
    }
    const reconcile = async (tx: any) => ({
      updated: await this.reconcileTurnRatingsInTransaction(tx, input),
    });
    if (transactionClient) return reconcile(transactionClient);
    return this.prisma.$transaction(reconcile, { timeout: 30_000 });
  }

  private async reconcileTurnRatingsInTransaction(
    tx: any,
    provenance: ReconcilePersistedTurnRatingsInput
  ): Promise<number> {
    const candidates: Array<{ id: string }> = await tx.memory.findMany({
      where: {
        environmentId: provenance.environmentId,
        endUserId: provenance.endUserId,
        sourceTurnIds: { has: provenance.turnId },
      },
      select: { id: true },
      orderBy: { id: "asc" },
    });
    if (!candidates.length) return 0;

    const memories = (await tx.$queryRawUnsafe(
      `SELECT "id", "sourceTurnIds", "confidence",
                "feedbackBaselineConfidence", "quarantinedAt"
         FROM "Memory"
         WHERE "id" = ANY($1::uuid[])
         ORDER BY "id"
         FOR UPDATE`,
      candidates.map((memory) => memory.id)
    )) as LockedMemory[];

    const now = new Date();
    for (const memory of memories) {
      const currentRatings: Array<{ rating: number }> = await tx.messageRating.findMany({
        where: {
          environmentId: provenance.environmentId,
          endUserId: provenance.endUserId,
          turnId: { in: memory.sourceTurnIds },
        },
        select: { rating: true },
      });
      const positives = currentRatings.filter((row) => row.rating === 1).length;
      const negatives = currentRatings.filter((row) => row.rating === -1).length;
      const baseline = boundedConfidence(
        memory.feedbackBaselineConfidence ?? memory.confidence ?? 0.5
      );
      const confidence = boundedConfidence(baseline + (positives - negatives) * 0.1);

      await tx.memory.update({
        where: { id: memory.id },
        data: {
          feedbackBaselineConfidence: baseline,
          confidence,
          // Any current negative source rating is authoritative quarantine.
          // Preserve the original timestamp while the negative remains.
          quarantinedAt: negatives > 0 ? memory.quarantinedAt ?? now : null,
        },
      });
    }

    return memories.length;
  }
}

function boundedConfidence(value: number): number {
  return Math.min(1, Math.max(0, Number.isFinite(value) ? value : 0.5));
}
