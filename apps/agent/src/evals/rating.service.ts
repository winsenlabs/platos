import { Injectable, Inject, Optional } from "@nestjs/common";
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
  private prisma: any;

  constructor(
    @Inject(PRISMA_TOKEN) prisma: any,
    // Theme M.5 — optional so test harnesses that don't wire MemoryModule
    // (rating unit tests) continue to work. MemoryModule is a real import
    // in EvalsModule + app wiring so prod always has this injected.
    @Optional() private readonly memoryFeedback?: MemoryFeedbackService
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
    input: { messageId: string; rating: 1 | -1; comment?: string | null }
  ): Promise<RatingRecord> {
    if (input.rating !== 1 && input.rating !== -1) {
      throw new Error("rating must be 1 or -1");
    }

    // Scope-gate via turn.thread.environment — a guessed turn id in another
    // scope returns null and we throw, surfacing as 404 in the controller.
    const turn = await this.prisma.turn.findFirst({
      where: {
        id: input.messageId,
        thread: {
          environmentId: scope.environmentId,
          environment: {
            project: {
              id: scope.projectId,
              organizationId: scope.organizationId,
            },
          },
        },
      },
      select: {
        id: true,
        threadId: true,
        thread: {
          select: {
            agentId: true,
            endUserId: true,
            agent: {
              select: {
                bindings: {
                  where: { environmentId: scope.environmentId },
                  take: 1,
                  select: { activeAgentVersionId: true },
                },
              },
            },
          },
        },
      },
    });
    if (!turn) throw new Error("Turn not found");

    const agentVersionId = turn.thread.agent.bindings[0]?.activeAgentVersionId ?? null;

    const row = await this.prisma.$transaction(
      async (tx: any) => {
        const persisted = await tx.messageRating.upsert({
          where: {
            turnId_endUserId: {
              turnId: turn.id,
              endUserId: turn.thread.endUserId,
            },
          },
          update: {
            rating: input.rating,
            comment: input.comment ?? null,
            revision: { increment: 1 },
          },
          create: {
            environmentId: scope.environmentId,
            turnId: turn.id,
            agentId: turn.thread.agentId,
            agentVersionId,
            endUserId: turn.thread.endUserId,
            rating: input.rating,
            comment: input.comment ?? null,
          },
        });

        // Reconciliation is keyed by the persisted row revision, never the
        // input sign. Sharing this transaction removes the crash window between
        // rating persistence and authoritative aggregate application.
        if (this.memoryFeedback) {
          await this.memoryFeedback.reconcilePersistedRating(
            {
              ratingId: persisted.id,
              expectedRevision: persisted.revision,
            },
            tx
          );
        }
        return persisted;
      },
      { timeout: 30_000 }
    );

    return this.toRecord(row, {
      threadId: turn.threadId,
      userId: turn.thread.endUserId,
    });
  }

  /** Remove this user's rating for a message. Idempotent. */
  async remove(scope: RequestScope, messageId: string): Promise<boolean> {
    // A delete without reconciliation would leave confidence/quarantine stale.
    // Production always wires MemoryModule; fail closed if a partial test or
    // misconfigured module invokes this mutation without the reconciler.
    const memoryFeedback = this.memoryFeedback;
    if (!memoryFeedback) throw new Error("Memory feedback reconciliation unavailable");

    return this.prisma.$transaction(
      async (tx: any) => {
        // Resolve canonical provenance inside the same transaction as the
        // delete. A forged cross-scope turn id remains indistinguishable from
        // a missing turn and can never drive reconciliation in another scope.
        const turn = await tx.turn.findFirst({
          where: {
            id: messageId,
            thread: {
              environmentId: scope.environmentId,
              environment: {
                project: {
                  id: scope.projectId,
                  organizationId: scope.organizationId,
                },
              },
            },
          },
          select: { id: true, thread: { select: { endUserId: true } } },
        });
        if (!turn) return false;

        const result = await tx.messageRating.deleteMany({
          where: {
            turnId: turn.id,
            endUserId: turn.thread.endUserId,
            environmentId: scope.environmentId,
          },
        });
        if (result.count === 0) return false;

        await memoryFeedback.reconcilePersistedTurnRatings(
          {
            environmentId: scope.environmentId,
            endUserId: turn.thread.endUserId,
            turnId: turn.id,
          },
          tx
        );
        return true;
      },
      { timeout: 30_000 }
    );
  }

  /**
   * List ratings for a message — used by the chat UI to show the current
   * user's own vote (filters to scope.userId by default).
   */
  async getForMessage(
    scope: RequestScope,
    messageId: string,
    options: { onlyCurrentUser?: boolean } = { onlyCurrentUser: true }
  ): Promise<{ userRating: RatingRecord | null; aggregate: { ups: number; downs: number } }> {
    const turn = await this.prisma.turn.findFirst({
      where: {
        id: messageId,
        thread: {
          environmentId: scope.environmentId,
          environment: {
            project: {
              id: scope.projectId,
              organizationId: scope.organizationId,
            },
          },
        },
      },
      select: {
        id: true,
        threadId: true,
        thread: { select: { endUserId: true } },
      },
    });
    if (!turn) return { userRating: null, aggregate: { ups: 0, downs: 0 } };

    const where: Record<string, unknown> = {
      turnId: messageId,
      environmentId: scope.environmentId,
    };
    if (options.onlyCurrentUser) {
      where.endUserId = turn.thread.endUserId;
    }
    const rows = await this.prisma.messageRating.findMany({ where });
    const userRow = (rows as any[]).find((r) => r.endUserId === turn.thread.endUserId) ?? null;
    // Compute aggregate across ALL users (scope-filtered) for display-only.
    const [ups, downs] = await Promise.all([
      this.prisma.messageRating.count({
        where: {
          turnId: messageId,
          environmentId: scope.environmentId,
          rating: 1,
        },
      }),
      this.prisma.messageRating.count({
        where: {
          turnId: messageId,
          environmentId: scope.environmentId,
          rating: -1,
        },
      }),
    ]);
    return {
      userRating: userRow
        ? this.toRecord(userRow, {
            threadId: turn.threadId,
            userId: turn.thread.endUserId,
          })
        : null,
      aggregate: { ups, downs },
    };
  }

  /**
   * Theme J.2 — aggregated satisfaction per agent version. Joined with
   * AgentVersion so the UI can label v3 / v7 / etc. Ratings are
   * anonymized (no userId surfacing).
   */
  async satisfactionByVersion(
    scope: ScopeTuple,
    agentId: string,
    options: { days?: number } = {}
  ): Promise<{
    days: number;
    total: number;
    rows: SatisfactionRow[];
  }> {
    const days = Math.max(1, Math.min(365, Math.floor(options.days ?? 30)));
    const since = new Date(Date.now() - days * 86400_000);

    const rows: Array<{ agentVersionId: string | null; rating: number }> =
      await this.prisma.messageRating.findMany({
        where: {
          environmentId: scope.environmentId,
          environment: {
            project: {
              id: scope.projectId,
              organizationId: scope.organizationId,
            },
          },
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
      await this.prisma.agentVersion.findMany({
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

  /**
   * Per-agent satisfaction rollup across EVERY agent in scope, in a single
   * query (no per-agent fan-out). Powers the Plato Central agent-scorecard
   * table — the caller joins the returned rows against its agent list by
   * `agentId`. Ratings are anonymized (no userId surfacing), same invariant
   * as `satisfactionByVersion`.
   *
   * Uses the (org, project, env, agentId) index; groups client-side by
   * agentId rather than issuing one aggregate per agent, so the cost is O(1)
   * queries regardless of agent count.
   */
  async satisfactionByAgent(
    scope: ScopeTuple,
    options: { days?: number } = {}
  ): Promise<Array<{ agentId: string; ups: number; downs: number; total: number; score: number }>> {
    const days = Math.max(1, Math.min(365, Math.floor(options.days ?? 30)));
    const since = new Date(Date.now() - days * 86400_000);

    const rows: Array<{ agentId: string; rating: number }> =
      await this.prisma.messageRating.findMany({
        where: {
          environmentId: scope.environmentId,
          environment: {
            project: {
              id: scope.projectId,
              organizationId: scope.organizationId,
            },
          },
          createdAt: { gte: since },
        },
        select: { agentId: true, rating: true },
      });

    const byAgent = new Map<string, { ups: number; downs: number }>();
    for (const r of rows) {
      if (!r.agentId) continue;
      const b = byAgent.get(r.agentId) ?? { ups: 0, downs: 0 };
      if (r.rating > 0) b.ups += 1;
      else if (r.rating < 0) b.downs += 1;
      byAgent.set(r.agentId, b);
    }

    return Array.from(byAgent.entries()).map(([agentId, b]) => {
      const total = b.ups + b.downs;
      return { agentId, ups: b.ups, downs: b.downs, total, score: total === 0 ? 0 : b.ups / total };
    });
  }

  private toRecord(r: any, context: { threadId: string; userId: string }): RatingRecord {
    return {
      id: r.id,
      messageId: r.turnId,
      threadId: context.threadId,
      agentId: r.agentId,
      agentVersionId: r.agentVersionId ?? null,
      userId: context.userId,
      rating: r.rating,
      comment: r.comment ?? null,
      createdAt: r.createdAt instanceof Date ? r.createdAt.toISOString() : String(r.createdAt),
      updatedAt: r.updatedAt instanceof Date ? r.updatedAt.toISOString() : String(r.updatedAt),
    };
  }
}
