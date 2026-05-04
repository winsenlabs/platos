import { Injectable, Inject, Logger, Optional } from "@nestjs/common";
import { PRISMA_TOKEN } from "../shared/database.provider";
import { MessageCryptoService } from "../monitoring/message-crypto.service";

export interface FeedbackScope {
  organizationId: string;
  projectId: string;
  environmentId: string;
  userId: string;
}

export interface ApplyRatingInput {
  messageId: string;
  rating: 1 | -1;
  comment?: string | null;
}

export interface ApplyRatingResult {
  updated: number;
}

/**
 * Theme M.5 — ratings → memory feedback loop.
 *
 * Bridges the thumbs-up / thumbs-down vote cast on a message to every
 * memory row that was extracted with that message in its
 * `sourceMessageIds` provenance array.
 *
 *   rating = +1  →  bump memory.confidence by +0.1 (capped at 1.0)
 *   rating = -1  →  set metadata.flaggedByRating = { messageId, comment,
 *                  flaggedAt } — the turn-start ranker filters these out
 *                  until a human review clears the flag. Content is never
 *                  mutated, revokedAt is never set (flag-only per M.5
 *                  spec so the full rollback remains a manual step).
 *
 * Scope: every query is gated by the (org, project, env) tuple — a
 * cross-scope messageId guess hits zero rows and returns { updated: 0 }.
 *
 * Fail-open: any error is swallowed + logged as warn. Ratings persist
 * regardless; a failed feedback apply re-runs on the next user vote.
 */
@Injectable()
export class MemoryFeedbackService {
  private readonly logger = new Logger(MemoryFeedbackService.name);
  private prisma: any;

  constructor(
    @Inject(PRISMA_TOKEN) prisma: any,
    @Optional() private readonly crypto?: MessageCryptoService,
  ) {
    this.prisma = prisma;
  }

  async applyRating(
    scope: FeedbackScope,
    params: ApplyRatingInput,
  ): Promise<ApplyRatingResult> {
    if (!scope?.organizationId || !scope?.projectId || !scope?.environmentId) {
      return { updated: 0 };
    }
    if (!params?.messageId) return { updated: 0 };
    if (params.rating !== 1 && params.rating !== -1) return { updated: 0 };

    try {
      // Find every memory row whose provenance includes this messageId.
      // `has` maps to PostgreSQL's array containment predicate. Memories
      // without sourceMessageIds (pre-M.1 rows) are naturally excluded.
      const rows: Array<{ id: string; confidence: number | null; metadata: any }> =
        await this.prisma.platosMemory.findMany({
          where: {
            organizationId: scope.organizationId,
            projectId: scope.projectId,
            environmentId: scope.environmentId,
            userId: scope.userId,
            sourceMessageIds: { has: params.messageId },
          },
          select: { id: true, confidence: true, metadata: true },
        });

      if (rows.length === 0) return { updated: 0 };

      const flaggedAt = new Date().toISOString();
      let updated = 0;

      if (params.rating === 1) {
        // Thumbs-up — bump confidence by +0.1, cap at 1.0. Null →
        // treat as a baseline 0.5 before the bump so the first positive
        // signal lifts the row above unboosted peers without overshooting.
        for (const r of rows) {
          const current =
            typeof r.confidence === "number"
              ? r.confidence
              : r.confidence == null
                ? 0.5
                : Number.isFinite(Number(r.confidence))
                  ? Number(r.confidence)
                  : 0.5;
          const next = Math.min(1, current + 0.1);
          try {
            await this.prisma.platosMemory.update({
              where: { id: r.id },
              data: { confidence: next },
            });
            updated += 1;
          } catch (err: any) {
            this.logger.warn(
              `applyRating: confidence bump failed for ${r.id}: ${err?.message || err}`,
            );
          }
        }
      } else {
        // Thumbs-down — flag-only. We do NOT touch confidence here because
        // a single downvote from one user shouldn't crater a memory that
        // other users + the extractor agreed on. The ranker drops flagged
        // rows entirely; a human review via the editor UI can clear the
        // flag if the vote was spurious.
        for (const r of rows) {
          // Read-decrypt-merge-encrypt-write so we never corrupt a row
          // whose metadata is stored under EOBD.22's envelope. Plaintext
          // rows round-trip unchanged (crypto passthrough).
          const decrypted = this.crypto
            ? this.crypto.decryptJsonField(r.metadata ?? null)
            : r.metadata ?? null;
          const existing =
            decrypted && typeof decrypted === "object" && !Array.isArray(decrypted)
              ? (decrypted as Record<string, unknown>)
              : {};
          const merged = {
            ...existing,
            flaggedByRating: {
              messageId: params.messageId,
              comment: params.comment ?? null,
              flaggedAt,
            },
          };
          const stored = this.crypto
            ? this.crypto.encryptJsonField(merged)
            : merged;
          try {
            await this.prisma.platosMemory.update({
              where: { id: r.id },
              data: { metadata: stored as any },
            });
            updated += 1;
          } catch (err: any) {
            this.logger.warn(
              `applyRating: flag write failed for ${r.id}: ${err?.message || err}`,
            );
          }
        }
      }

      return { updated };
    } catch (err: any) {
      this.logger.warn(`applyRating: query failed: ${err?.message || err}`);
      return { updated: 0 };
    }
  }
}
