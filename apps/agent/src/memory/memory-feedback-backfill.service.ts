import { Inject, Injectable, Optional } from "@nestjs/common";
import { PRISMA_TOKEN, type ControlDatabaseClient } from "../shared/database.provider";
import { MessageCryptoService } from "../monitoring/message-crypto.service";
import { assertEnvironmentScope, environmentScopeWhere, type MemoryScope } from "./memory-scope";
import { isEncryptedMetadataEnvelope, legacyFeedbackMetadataState } from "./memory-feedback-legacy";

export interface MemoryFeedbackBackfillResult {
  scanned: number;
  quarantined: number;
  alreadyQuarantined: number;
  decryptUnavailable: number;
  completed: boolean;
}

/**
 * Explicit, bounded, idempotent transition for pre-quarantine memories.
 *
 * Operators call runBatch repeatedly per Environment. Counts never include
 * memory IDs, content, metadata, ciphertext, or comments. The completion
 * marker is written only after a full scan with no undecryptable envelope.
 */
@Injectable()
export class MemoryFeedbackBackfillService {
  constructor(
    @Inject(PRISMA_TOKEN) private readonly prisma: ControlDatabaseClient,
    @Optional() private readonly crypto?: MessageCryptoService
  ) {}

  async runBatch(
    scope: MemoryScope,
    options: { limit?: number } = {}
  ): Promise<MemoryFeedbackBackfillResult> {
    await assertEnvironmentScope(this.prisma, scope);
    const limit = clampInt(options.limit ?? 100, 1, 500);
    const environment = await this.prisma.environment.findFirst({
      where: {
        id: scope.environmentId,
        projectId: scope.projectId,
        project: { organizationId: scope.organizationId },
      },
      select: {
        memoryFeedbackBackfillCursor: true,
        memoryFeedbackBackfillCompletedAt: true,
      },
    });
    if (!environment) throw new Error("Memory scope not found or access denied");
    if (environment.memoryFeedbackBackfillCompletedAt) return emptyResult(true);

    const rows = await this.prisma.memory.findMany({
      where: {
        ...environmentScopeWhere(scope),
        ...(environment.memoryFeedbackBackfillCursor
          ? { id: { gt: environment.memoryFeedbackBackfillCursor } }
          : {}),
      },
      orderBy: { id: "asc" },
      take: limit,
      select: { id: true, metadata: true, quarantinedAt: true },
    });

    if (!rows.length) {
      await this.markCompleted(scope);
      return emptyResult(true);
    }

    const flaggedIds: string[] = [];
    let alreadyQuarantined = 0;
    let decryptUnavailable = 0;
    for (const row of rows) {
      if (row.quarantinedAt) {
        alreadyQuarantined += 1;
        continue;
      }
      const decrypted = this.crypto?.decryptJsonField(row.metadata ?? null) ?? row.metadata ?? null;
      const state = legacyFeedbackMetadataState(row.metadata, decrypted);
      if (state.decryptUnavailable || (isEncryptedMetadataEnvelope(row.metadata) && !this.crypto)) {
        decryptUnavailable += 1;
      } else if (state.flagged) {
        flaggedIds.push(row.id);
      }
    }

    let quarantined = 0;
    if (flaggedIds.length) {
      const result = await this.prisma.memory.updateMany({
        where: {
          ...environmentScopeWhere(scope),
          id: { in: flaggedIds },
          quarantinedAt: null,
        },
        data: { quarantinedAt: new Date() },
      });
      quarantined = result.count;
    }

    // Never move the cursor past an envelope that could contain a legacy flag.
    if (decryptUnavailable > 0) {
      return {
        scanned: rows.length,
        quarantined,
        alreadyQuarantined,
        decryptUnavailable,
        completed: false,
      };
    }

    const completed = rows.length < limit;
    await this.prisma.environment.updateMany({
      where: {
        id: scope.environmentId,
        projectId: scope.projectId,
        project: { organizationId: scope.organizationId },
        memoryFeedbackBackfillCompletedAt: null,
      },
      data: {
        memoryFeedbackBackfillCursor: completed ? null : rows[rows.length - 1]!.id,
        memoryFeedbackBackfillCompletedAt: completed ? new Date() : null,
      },
    });
    return {
      scanned: rows.length,
      quarantined,
      alreadyQuarantined,
      decryptUnavailable,
      completed,
    };
  }

  private async markCompleted(scope: MemoryScope): Promise<void> {
    await this.prisma.environment.updateMany({
      where: {
        id: scope.environmentId,
        projectId: scope.projectId,
        project: { organizationId: scope.organizationId },
        memoryFeedbackBackfillCompletedAt: null,
      },
      data: {
        memoryFeedbackBackfillCursor: null,
        memoryFeedbackBackfillCompletedAt: new Date(),
      },
    });
  }
}

function emptyResult(completed: boolean): MemoryFeedbackBackfillResult {
  return {
    scanned: 0,
    quarantined: 0,
    alreadyQuarantined: 0,
    decryptUnavailable: 0,
    completed,
  };
}

function clampInt(value: number, min: number, max: number): number {
  const normalized = Math.floor(Number(value));
  if (!Number.isFinite(normalized)) return min;
  return Math.min(Math.max(normalized, min), max);
}
