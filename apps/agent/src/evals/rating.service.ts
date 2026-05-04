import { Injectable, Inject, Logger, Optional } from "@nestjs/common";
import { PRISMA_TOKEN } from "../shared/database.provider";
import type { RequestScope } from "../auth/scope.guard";
import { MemoryFeedbackService } from "../memory/memory-feedback.service";

type ScopeTuple = Pick<RequestScope, "organizationId" | "projectId" | "environmentId">;

export interface RatingRecord {
  id: string;
  messageId: string;
  threadId: string;
  agentId: string;
  agentVersionId: string | null;
  userId: string;
  rating: number; // -1 | 1
  comment: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface SatisfactionRow {
  agentVersionId: string | null;
  versionNumber: number | null;
  ups: number;
  downs: number;
  total: number;
  score: number; // 0..1
}

/**
 * Theme J.1 + J.2 — message rating persistence + aggregated satisfaction.
 *
 * J.1 — `upsert` writes one row per (messageId, userId). A user changing their
 * mind flips the sign in place; a `remove` deletes the row.
 *
 * J.2 — `satisfactionByVersion` groups the current-state ratings by
 * `agentVersionId` so the canary dashboard can plot "satisfaction %" next to
 * the cost / latency columns. Ratings are anonymized in the aggregate — we
 * never surface userId to cross-user readers (Theme J invariant §5).
 *
 * Scope enforcement: every read & write filters on the full (org, project,
 * env) tuple; callers cannot attribute or query ratings in another scope.
 */
@Injectable()
export class RatingService {
  private readonly logger = new Logger(RatingService.name);
  private prisma: any;

  constructor(
    @Inject(PRISMA_TOKEN) prisma: any,
    // Theme M.5 — optional so test harnesses that don't wire MemoryModule
    // (rating unit tests) continue to work. MemoryModule is a real import
    // in EvalsModule + app wiring so prod always has this injected.
    @Optional() private readonly memoryFeedback?: MemoryFeedbackService,
  ) {
    this.prisma = prisma;
  }

  /**
   * Upsert a thumbs vote for (messageId, userId).
   *
   * The `threadId` / `agentId` / `agentVersionId` are resolved from the target
   * message so the aggregated query in J.2 doesn't need to join. We verify the
   * message belongs to the caller's scope before writing — a cross-scope
   * messageId guess fails closed.
   */
  async upsert(
    scope: RequestScope,
    input: { messageId: string; rating: 1 | -1; comment?: string | null },
  ): Promise<RatingRecord> {
    if (input.rating !== 1 && input.rating !== -1) {
      throw new Error("rating must be 1 or -1");
    }

    // Scope-gate via message.thread.agent — a guessed messageId in another
    // scope returns null and we throw, surfacing as 404 in the controller.
    const msg = await this.prisma.platosAgentMessage.findFirst({
      where: {
        id: input.messageId,
        thread: {
          organizationId: scope.organizationId,
          projectId: scope.projectId,
          environmentId: scope.environmentId,
        },
      },
      select: {
        id: true,
        threadId: true,
        thread: {
          select: {
            agentId: true,
            lockedVersionId: true,
          },
        },
      },
    });
    if (!msg) throw new Error("Message not found");

    const row = await this.prisma.platosMessageRating.upsert({
      where: {
        messageId_userId: {
          messageId: msg.id,
          userId: scope.userId,
        },
      },
      update: {
        rating: input.rating,
        comment: input.comment ?? null,
      },
      create: {
        organizationId: scope.organizationId,
        projectId: scope.projectId,
        environmentId: scope.environmentId,
        messageId: msg.id,
        threadId: msg.threadId,
        agentId: msg.thread.agentId,
        agentVersionId: msg.thread.lockedVersionId ?? null,
        userId: scope.userId,
        rating: input.rating,
        comment: input.comment ?? null,
      },
    });

    // Theme M.5 — ratings feedback loop. Fire-and-forget: the persisted
    // rating is the authoritative signal; memory confidence/flag bumps
    // are best-effort secondary. A crashed feedback call is retried the
    // next time the user flips the vote (upsert idempotent on rating
    // sign). Scoped to the caller's (org, project, env, userId) tuple
    // so cross-tenant leak is impossible.
    if (this.memoryFeedback) {
      void this.memoryFeedback
        .applyRating(
          {
            organizationId: scope.organizationId,
            projectId: scope.projectId,
            environmentId: scope.environmentId,
            userId: scope.userId,
          },
          {
            messageId: msg.id,
            rating: input.rating,
            comment: input.comment ?? null,
          },
        )
        .catch((err) =>
          this.logger.warn(
            `memory feedback apply failed: ${err?.message ?? err}`,
          ),
        );
    }

    return this.toRecord(row);
  }

  /** Remove this user's rating for a message. Idempotent. */
  async remove(scope: RequestScope, messageId: string): Promise<boolean> {
    // Scope-gate via a scope-stamped delete — PostgreSQL's deleteMany is
    // a no-op on zero matches, so a cross-scope id can never reveal
    // existence.
    const result = await this.prisma.platosMessageRating.deleteMany({
      where: {
        messageId,
        userId: scope.userId,
        organizationId: scope.organizationId,
        projectId: scope.projectId,
        environmentId: scope.environmentId,
      },
    });
    return result.count > 0;
  }

  /**
   * List ratings for a message — used by the chat UI to show the current
   * user's own vote (filters to scope.userId by default).
   */
  async getForMessage(
    scope: RequestScope,
    messageId: string,
    options: { onlyCurrentUser?: boolean } = { onlyCurrentUser: true },
  ): Promise<{ userRating: RatingRecord | null; aggregate: { ups: number; downs: number } }> {
    const where: Record<string, unknown> = {
      messageId,
      organizationId: scope.organizationId,
      projectId: scope.projectId,
      environmentId: scope.environmentId,
    };
    if (options.onlyCurrentUser) {
      where.userId = scope.userId;
    }
    const rows = await this.prisma.platosMessageRating.findMany({ where });
    const userRow = (rows as any[]).find((r) => r.userId === scope.userId) ?? null;
    // Compute aggregate across ALL users (scope-filtered) for display-only.
    const [ups, downs] = await Promise.all([
      this.prisma.platosMessageRating.count({
        where: {
          messageId,
          organizationId: scope.organizationId,
          projectId: scope.projectId,
          environmentId: scope.environmentId,
          rating: 1,
        },
      }),
      this.prisma.platosMessageRating.count({
        where: {
          messageId,
          organizationId: scope.organizationId,
          projectId: scope.projectId,
          environmentId: scope.environmentId,
          rating: -1,
        },
      }),
    ]);
    return {
      userRating: userRow ? this.toRecord(userRow) : null,
      aggregate: { ups, downs },
    };
  }

  /**
   * Theme J.2 — aggregated satisfaction per agent version. Joined with
   * PlatosAgentVersion so the UI can label v3 / v7 / etc. Ratings are
   * anonymized (no userId surfacing).
   */
  async satisfactionByVersion(
    scope: ScopeTuple,
    agentId: string,
    options: { days?: number } = {},
  ): Promise<{
    days: number;
    total: number;
    rows: SatisfactionRow[];
  }> {
    const days = Math.max(1, Math.min(365, Math.floor(options.days ?? 30)));
    const since = new Date(Date.now() - days * 86400_000);

    const rows: Array<{ agentVersionId: string | null; rating: number }> =
      await this.prisma.platosMessageRating.findMany({
        where: {
          organizationId: scope.organizationId,
          projectId: scope.projectId,
          environmentId: scope.environmentId,
          agentId,
          createdAt: { gte: since },
        },
        select: { agentVersionId: true, rating: true },
      });

    const byVersion = new Map<string | null, { ups: number; downs: number }>();
    for (const r of rows) {
      const key = r.agentVersionId ?? null;
      const b = byVersion.get(key) ?? { ups: 0, downs: 0 };
      if (r.rating > 0) b.ups += 1;
      else if (r.rating < 0) b.downs += 1;
      byVersion.set(key, b);
    }

    const versionNumberById = new Map<string, number>();
    const versions: Array<{ id: string; versionNumber: number }> =
      await this.prisma.platosAgentVersion.findMany({
        where: { agentId },
        select: { id: true, versionNumber: true },
      });
    for (const v of versions) versionNumberById.set(v.id, v.versionNumber);

    const out: SatisfactionRow[] = Array.from(byVersion.entries()).map(([versionId, b]) => {
      const total = b.ups + b.downs;
      return {
        agentVersionId: versionId,
        versionNumber: versionId ? versionNumberById.get(versionId) ?? null : null,
        ups: b.ups,
        downs: b.downs,
        total,
        score: total === 0 ? 0 : b.ups / total,
      };
    });
    out.sort((a, b) => {
      if ((a.versionNumber ?? 0) !== (b.versionNumber ?? 0)) {
        return (b.versionNumber ?? 0) - (a.versionNumber ?? 0);
      }
      return b.total - a.total;
    });

    return { days, total: rows.length, rows: out };
  }

  private toRecord(r: any): RatingRecord {
    return {
      id: r.id,
      messageId: r.messageId,
      threadId: r.threadId,
      agentId: r.agentId,
      agentVersionId: r.agentVersionId ?? null,
      userId: r.userId,
      rating: r.rating,
      comment: r.comment ?? null,
      createdAt: r.createdAt instanceof Date ? r.createdAt.toISOString() : String(r.createdAt),
      updatedAt: r.updatedAt instanceof Date ? r.updatedAt.toISOString() : String(r.updatedAt),
    };
  }
}
