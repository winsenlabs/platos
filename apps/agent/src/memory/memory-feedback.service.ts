import { Inject, Injectable, Optional } from "@nestjs/common";
import { PRISMA_TOKEN, type ControlDatabaseClient } from "../shared/database.provider";
import { MessageCryptoService } from "../monitoring/message-crypto.service";
import {
  assertEnvironmentScope,
  environmentScopeWhere,
  resolveEndUser,
} from "./memory-scope";

export interface FeedbackScope {
  organizationId: string;
  projectId: string;
  environmentId: string;
  userId: string;
}

export interface ApplyRatingInput {
  /** Clean Turn.id. */
  messageId: string;
  rating: 1 | -1;
  comment?: string | null;
}

export interface ApplyRatingResult {
  updated: number;
}

@Injectable()
export class MemoryFeedbackService {
  constructor(
    @Inject(PRISMA_TOKEN) private readonly prisma: ControlDatabaseClient,
    @Optional() private readonly crypto?: MessageCryptoService,
  ) {}

  async applyRating(
    scope: FeedbackScope,
    params: ApplyRatingInput,
  ): Promise<ApplyRatingResult> {
    if (!scope?.organizationId || !scope?.projectId || !scope?.environmentId) {
      throw new Error("Memory feedback requires a canonical Environment scope");
    }
    if (!params?.messageId) throw new Error("Memory feedback requires a Turn id");
    if (params.rating !== 1 && params.rating !== -1) {
      throw new Error("Memory feedback rating must be 1 or -1");
    }
    await assertEnvironmentScope(this.prisma, scope);
    const endUser = await resolveEndUser(this.prisma, scope, scope.userId);
    const memories = await this.prisma.memory.findMany({
      where: {
        ...environmentScopeWhere(scope),
        endUserId: endUser.id,
        sourceTurnIds: { has: params.messageId },
      },
      select: { id: true, confidence: true, metadata: true },
    });
    if (!memories.length) return { updated: 0 };

    if (params.rating === 1) {
      await this.prisma.$transaction(
        memories.map((memory) => {
          const current = memory.confidence == null ? 0.5 : Number(memory.confidence);
          return this.prisma.memory.update({
            where: { id: memory.id },
            data: { confidence: Math.min(1, current + 0.1) },
          });
        }),
      );
      return { updated: memories.length };
    }

    const flaggedAt = new Date().toISOString();
    await this.prisma.$transaction(
      memories.map((memory) => {
        const decrypted = this.crypto
          ? this.crypto.decryptJsonField(memory.metadata ?? null)
          : memory.metadata ?? null;
        const metadata = decrypted && typeof decrypted === "object" && !Array.isArray(decrypted)
          ? decrypted as Record<string, unknown>
          : {};
        const merged = {
          ...metadata,
          flaggedByRating: {
            turnId: params.messageId,
            comment: params.comment ?? null,
            flaggedAt,
          },
        };
        return this.prisma.memory.update({
          where: { id: memory.id },
          data: {
            metadata: (this.crypto?.encryptJsonField(merged) ?? merged) as any,
          },
        });
      }),
    );
    return { updated: memories.length };
  }
}
