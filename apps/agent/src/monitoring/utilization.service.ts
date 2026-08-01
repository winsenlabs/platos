import { Injectable, Inject } from "@nestjs/common";
// ONE SOURCE OF TRUTH for cost — see billable-usage.ts.
import { billableCostCents } from "./billable-usage";
import { PRISMA_TOKEN } from "../shared/database.provider";
import type { RequestScope } from "../auth/scope.guard";

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
  private prisma: any;

  constructor(@Inject(PRISMA_TOKEN) prisma: any) {
    this.prisma = prisma;
  }

  async build(
    scope: ScopeTuple,
    options: { days?: number; topUserLimit?: number } = {},
  ): Promise<UtilizationPayload> {
    const days = options.days ?? 7;
    const topUserLimit = options.topUserLimit ?? 10;
    const since = new Date(Date.now() - days * 86400_000);

    const [activeThreads, totalThreads, totalMessages, messagesInRange] = await Promise.all([
      // Active = thread updated within the window.
      this.prisma.platosAgentThread.count({
        where: {
          organizationId: scope.organizationId,
          projectId: scope.projectId,
          environmentId: scope.environmentId,
          status: "active",
          updatedAt: { gte: since },
        },
      }),
      this.prisma.platosAgentThread.count({
        where: {
          organizationId: scope.organizationId,
          projectId: scope.projectId,
          environmentId: scope.environmentId,
        },
      }),
      this.prisma.platosAgentMessage.count({
        where: {
          thread: {
            organizationId: scope.organizationId,
            projectId: scope.projectId,
            environmentId: scope.environmentId,
          },
        },
      }),
      this.prisma.platosAgentMessage.findMany({
        where: {
          createdAt: { gte: since },
          thread: {
            organizationId: scope.organizationId,
            projectId: scope.projectId,
            environmentId: scope.environmentId,
          },
        },
        select: {
          createdAt: true,
          role: true,
          responseJson: true,
          thread: { select: { userId: true, id: true, updatedAt: true } },
        },
      }),
    ]);

    // Build day buckets (oldest → newest)
    const dayBuckets = new Map<string, number>();
    for (let i = days - 1; i >= 0; i--) {
      const d = new Date(Date.now() - i * 86400_000).toISOString().slice(0, 10);
      dayBuckets.set(d, 0);
    }
    for (const m of messagesInRange as Array<{ createdAt: Date }>) {
      const d = m.createdAt.toISOString().slice(0, 10);
      if (dayBuckets.has(d)) {
        dayBuckets.set(d, (dayBuckets.get(d) ?? 0) + 1);
      }
    }
    const messagesByDay = Array.from(dayBuckets.entries()).map(([date, messages]) => ({
      date,
      messages,
    }));

    // Top users — aggregate from messagesInRange
    const byUser = new Map<string, { messages: number; threads: Set<string>; costCents: number; lastActiveAt: Date | null }>();
    for (const m of messagesInRange as Array<{
      createdAt: Date;
      role: string;
      responseJson: any;
      thread: { userId: string; id: string; updatedAt: Date } | null;
    }>) {
      if (!m.thread) continue;
      const bucket = byUser.get(m.thread.userId) ?? {
        messages: 0,
        threads: new Set<string>(),
        costCents: 0,
        lastActiveAt: null as Date | null,
      };
      bucket.messages += 1;
      bucket.threads.add(m.thread.id);
      if (m.role === "assistant" && m.responseJson) {
        const rj = m.responseJson as { cost_cents?: number } | null;
        bucket.costCents += billableCostCents(rj as any);
      }
      if (!bucket.lastActiveAt || m.createdAt > bucket.lastActiveAt) {
        bucket.lastActiveAt = m.createdAt;
      }
      byUser.set(m.thread.userId, bucket);
    }

    const topUsers = Array.from(byUser.entries())
      .map(([userId, b]) => ({
        userId,
        messages: b.messages,
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
      const earliestPerUser: Array<{ userId: string; createdAt: Date }> = await this.prisma.platosAgentThread.findMany({
        where: {
          organizationId: scope.organizationId,
          projectId: scope.projectId,
          environmentId: scope.environmentId,
          userId: { in: usersInWindow },
        },
        select: { userId: true, createdAt: true },
        orderBy: { createdAt: "asc" },
      });
      const firstSeen = new Map<string, Date>();
      for (const t of earliestPerUser) {
        if (!firstSeen.has(t.userId)) firstSeen.set(t.userId, t.createdAt);
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
