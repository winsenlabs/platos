import { Injectable, Inject, Logger, Optional } from "@nestjs/common";
import { PRISMA_TOKEN } from "../shared/database.provider";
import type { RequestScope } from "../auth/scope.guard";
import { CostService } from "./cost.service";

type ScopeTuple = Pick<RequestScope, "organizationId" | "projectId" | "environmentId">;

export interface UtilizationPayload {
  activeThreads: number;
  totalThreads: number;
  totalMessages: number;
  messagesByDay: Array<{ date: string; messages: number }>;
  newVsReturningUsers: {
    days: number;
    newUsers: number;
    returningUsers: number;
  };
  topUsers: Array<{
    userId: string;
    messages: number;
    /** Completed turns, from the usage ledger. `messages` counts both sides. */
    tasks: number;
    threads: number;
    costCents: number;
    lastActiveAt: string | null;
  }>;
  fetchedAt: string;
}

/**
 * UtilizationService — aggregates activity metrics for the monitoring
 * dashboard. Theme E.4.
 *
 * Scope filter lives on every query; cross-env totals are not possible.
 */
@Injectable()
export class UtilizationService {
  private readonly logger = new Logger(UtilizationService.name);
  private prisma: any;

  constructor(
    @Inject(PRISMA_TOKEN) prisma: any,
    @Optional() private readonly costService?: CostService,
  ) {
    this.prisma = prisma;
  }

  async build(
    scope: ScopeTuple,
    options: { days?: number; topUserLimit?: number } = {},
  ): Promise<UtilizationPayload> {
    const days = options.days ?? 7;
    const topUserLimit = options.topUserLimit ?? 10;
    const since = new Date(Date.now() - days * 86400_000);

    const threadScope = {
      environmentId: scope.environmentId,
      environment: {
        project: {
          id: scope.projectId,
          organizationId: scope.organizationId,
        },
      },
    };

    const [activeThreads, totalThreads, allTurns, turnsInRange] = await Promise.all([
      // Active = thread updated within the window.
      this.prisma.thread.count({
        where: {
          ...threadScope,
          status: "ACTIVE",
          updatedAt: { gte: since },
        },
      }),
      this.prisma.thread.count({
        where: threadScope,
      }),
      this.prisma.turn.findMany({
        where: { thread: threadScope },
        select: { inputText: true, outputText: true, steps: { select: { id: true } } },
      }),
      this.prisma.turn.findMany({
        where: {
          createdAt: { gte: since },
          thread: threadScope,
        },
        select: {
          createdAt: true,
          inputText: true,
          outputText: true,
          steps: { select: { id: true } },
          thread: { select: { endUserId: true, id: true, updatedAt: true } },
        },
      }),
    ]);

    const messageCountForTurn = (turn: {
      inputText: string | null;
      outputText: string | null;
      steps: Array<unknown>;
    }): number =>
      (turn.inputText !== null ? 1 : 0) +
      (turn.outputText !== null || turn.steps.length > 0 ? 1 : 0);
    const totalMessages = (allTurns as Array<any>).reduce(
      (count, turn) => count + messageCountForTurn(turn),
      0,
    );

    // Build day buckets (oldest → newest)
    const dayBuckets = new Map<string, number>();
    for (let i = days - 1; i >= 0; i--) {
      const d = new Date(Date.now() - i * 86400_000).toISOString().slice(0, 10);
      dayBuckets.set(d, 0);
    }
    for (const turn of turnsInRange as Array<any>) {
      const d = turn.createdAt.toISOString().slice(0, 10);
      if (dayBuckets.has(d)) {
        dayBuckets.set(
          d,
          (dayBuckets.get(d) ?? 0) + messageCountForTurn(turn),
        );
      }
    }
    const messagesByDay = Array.from(dayBuckets.entries()).map(([date, messages]) => ({
      date,
      messages,
    }));

    // Top users — aggregate from messagesInRange
    const byUser = new Map<string, { messages: number; tasks: number; threads: Set<string>; costCents: number; lastActiveAt: Date | null }>();
    for (const turn of turnsInRange as Array<{
      createdAt: Date;
      inputText: string | null;
      outputText: string | null;
      steps: Array<unknown>;
      thread: { endUserId: string; id: string; updatedAt: Date } | null;
    }>) {
      if (!turn.thread) continue;
      const bucket = byUser.get(turn.thread.endUserId) ?? {
        messages: 0,
        tasks: 0,
        threads: new Set<string>(),
        costCents: 0,
        lastActiveAt: null as Date | null,
      };
      bucket.messages += messageCountForTurn(turn);
      bucket.threads.add(turn.thread.id);
      if (!bucket.lastActiveAt || turn.createdAt > bucket.lastActiveAt) {
        bucket.lastActiveAt = turn.createdAt;
      }
      byUser.set(turn.thread.endUserId, bucket);
    }

    if (this.costService && byUser.size > 0) {
      try {
        const costRows = await this.costService.getCostByUser(scope, {
          days,
          limit: Math.max(topUserLimit, byUser.size),
        });
        for (const cost of costRows) {
          const bucket = byUser.get(cost.userId);
          if (!bucket) continue;
          // WIN-134 — both numbers come from the ledger's per-user rollup, so
          // this table cannot disagree with the usage page about either.
          bucket.costCents = cost.costCents;
          bucket.tasks = cost.tasks;
        }
      } catch (err: any) {
        this.logger.warn(
          `[utilization] user cost attribution unavailable: ${err?.message ?? err}`,
        );
      }
    } else if (!this.costService && byUser.size > 0) {
      this.logger.warn(
        "[utilization] CostService is not wired; top-user cost attribution is unavailable",
      );
    }

    const topUsers = Array.from(byUser.entries())
      .map(([userId, b]) => ({
        userId,
        messages: b.messages,
        tasks: b.tasks,
        threads: b.threads.size,
        costCents: Math.round(b.costCents * 100) / 100,
        lastActiveAt: b.lastActiveAt ? b.lastActiveAt.toISOString() : null,
      }))
      .sort((a, b) => b.messages - a.messages)
      .slice(0, topUserLimit);

    // New vs returning users in the window — a "new" user is someone whose
    // first-ever thread is inside the window; otherwise "returning".
    const usersInWindow = Array.from(byUser.keys());
    let newUsers = 0;
    let returningUsers = 0;
    if (usersInWindow.length > 0) {
      const earliestPerUser: Array<{ endUserId: string; createdAt: Date }> = await this.prisma.thread.findMany({
        where: {
          ...threadScope,
          endUserId: { in: usersInWindow },
        },
        select: { endUserId: true, createdAt: true },
        orderBy: { createdAt: "asc" },
      });
      const firstSeen = new Map<string, Date>();
      for (const t of earliestPerUser) {
        if (!firstSeen.has(t.endUserId)) firstSeen.set(t.endUserId, t.createdAt);
      }
      for (const uid of usersInWindow) {
        const first = firstSeen.get(uid);
        if (first && first >= since) newUsers++;
        else returningUsers++;
      }
    }

    return {
      activeThreads,
      totalThreads,
      totalMessages,
      messagesByDay,
      newVsReturningUsers: { days, newUsers, returningUsers },
      topUsers,
      fetchedAt: new Date().toISOString(),
    };
  }
}
