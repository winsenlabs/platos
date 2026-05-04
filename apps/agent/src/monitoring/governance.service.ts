import { Injectable, Inject } from "@nestjs/common";
import { PRISMA_TOKEN } from "../shared/database.provider";
import type { RequestScope } from "../auth/scope.guard";
import { BudgetService, type BudgetStatus } from "./budget.service";
import { CostService } from "./cost.service";
import { SafetyEventService } from "./safety-event.service";

type ScopeTuple = Pick<RequestScope, "organizationId" | "projectId" | "environmentId">;

/**
 * Theme H.10 — Governance dashboard aggregator.
 *
 * One call backs the dashboard route:
 *   - detector-hit timeline (last N days)
 *   - budget usage rollup
 *   - rate-limit violations (approximate — read from the dedicated
 *     violation counters that rate-limit.service populates when it denies)
 *   - agent risk score = composite of detector hits + approval rate + tool
 *     error rate, normalised 0–100 per agent.
 *
 * Agent risk formula:
 *   risk = clamp(
 *     0.4 * piiRate + 0.3 * injectionRate
 *     + 0.2 * toolErrorRate + 0.1 * approvalRate,
 *     0, 100
 *   )
 * where *Rate* is "events per 100 turns" capped at 100. This is a
 * reasonable operator-facing heuristic; a trained scoring model is a
 * future improvement.
 */
@Injectable()
export class GovernanceService {
  private prisma: any;

  constructor(
    @Inject(PRISMA_TOKEN) prisma: any,
    private readonly safety: SafetyEventService,
    private readonly budgets: BudgetService,
    // PRELAUNCH-A3-12 (follow-up 2026-05-04) — CostService DI so the
    // wildcard-user cap fan-out can resolve active userIds via
    // `getCostByUser`. Optional for back-compat with unit tests that
    // construct GovernanceService directly without CostService.
    private readonly costService?: CostService,
  ) {
    this.prisma = prisma;
  }

  async dashboard(
    scope: ScopeTuple,
    options: { sinceDays?: number } = {},
  ): Promise<{
    sinceDays: number;
    detectors: Awaited<ReturnType<SafetyEventService["summary"]>>;
    recentEvents: Awaited<ReturnType<SafetyEventService["list"]>>["rows"];
    budgets: BudgetStatus[];
    agentRisk: Array<{
      agentId: string;
      agentName: string | null;
      turns: number;
      piiEvents: number;
      injectionEvents: number;
      toolErrors: number;
      approvalEvents: number;
      risk: number;
      band: "low" | "medium" | "high";
    }>;
    fetchedAt: string;
  }> {
    const sinceDays = Math.max(1, Math.min(options.sinceDays ?? 7, 90));

    const [detectorsSummary, recentPage, budgetCaps] = await Promise.all([
      this.safety.summary(scope, { sinceDays }),
      this.safety.list(scope, { sinceDays, limit: 50 }),
      this.budgets.list(scope),
    ]);

    // Resolve budget statuses for every cap without an agentId/userId ctx —
    // scope caps read clean; agent/user caps fall back to their stored
    // targetId so the dashboard shows "Agent X's budget" even when no
    // request is in flight.
    //
    // PRELAUNCH-A3-12 — wildcard user caps (targetId='*') previously
    // rendered 0% always because `evaluate()` skipped them with no userId
    // in context. Fan out per active userId in the period (sourced from
    // CostService.getCostByUser) and aggregate as the max-utilisation
    // representative so the dashboard shows the worst-case wildcard
    // breach instead of zero.
    const budgetStatuses: BudgetStatus[] = [];
    let activeUserIds: string[] | null = null;
    const loadActiveUserIds = async (): Promise<string[]> => {
      if (activeUserIds) return activeUserIds;
      // PRELAUNCH-A3-12 (follow-up 2026-05-04) — query CostService for
      // userIds that spent ≥1¢ in the period. Falls back to an empty
      // list when CostService isn't injected (unit-test path) or the
      // call throws — which surfaces wildcard caps as zero-emission
      // (the cap row is suppressed below) rather than blocking the
      // entire dashboard.
      try {
        if (this.costService) {
          const byUser = await this.costService.getCostByUser(scope, {
            days: sinceDays,
            limit: 500,
          });
          activeUserIds = byUser.map((u) => u.userId).filter(Boolean);
          return activeUserIds;
        }
      } catch {
        // ignore — fall through to the empty-array safe default
      }
      activeUserIds = [];
      return activeUserIds;
    };
    for (const cap of budgetCaps) {
      const isWildcardUser = cap.scopeType === "user" && cap.targetId === "*";
      if (isWildcardUser) {
        const users = await loadActiveUserIds();
        if (users.length === 0) {
          // No active users to attribute against — surface a zero status
          // (cap exists, no traffic). Skip emit so the dashboard doesn't
          // show a misleading "0% / breached" row.
          continue;
        }
        let worst: BudgetStatus | null = null;
        for (const u of users) {
          const { caps } = await this.budgets.evaluate(scope, { userId: u });
          const match = caps.find((s) => s.cap.id === cap.id);
          if (match && (!worst || match.percent > worst.percent)) worst = match;
        }
        if (worst) budgetStatuses.push(worst);
        continue;
      }
      const { caps } = await this.budgets.evaluate(scope, {
        agentId: cap.scopeType === "agent" ? cap.targetId : undefined,
        userId: cap.scopeType === "user" ? cap.targetId : undefined,
      });
      const match = caps.find((s) => s.cap.id === cap.id);
      if (match) budgetStatuses.push(match);
    }

    // Agent risk scoring.
    const agentRisk = await this.computeAgentRisk(scope, sinceDays);

    return {
      sinceDays,
      detectors: detectorsSummary,
      recentEvents: recentPage.rows,
      budgets: budgetStatuses,
      agentRisk,
      fetchedAt: new Date().toISOString(),
    };
  }

  private async computeAgentRisk(scope: ScopeTuple, sinceDays: number) {
    const since = new Date(Date.now() - sinceDays * 86400_000);

    // Per-agent turn counts (rows in PlatosAgentMessage whose role=user).
    const turnRows: Array<{ thread: { agentId: string } | null }> =
      await this.prisma.platosAgentMessage.findMany({
        where: {
          role: "user",
          createdAt: { gte: since },
          thread: {
            organizationId: scope.organizationId,
            projectId: scope.projectId,
            environmentId: scope.environmentId,
          },
        },
        select: { thread: { select: { agentId: true } } },
      });
    const turnsByAgent = new Map<string, number>();
    for (const r of turnRows) {
      const id = r.thread?.agentId;
      if (!id) continue;
      turnsByAgent.set(id, (turnsByAgent.get(id) ?? 0) + 1);
    }

    // Per-agent safety events by detector.
    const safetyRows: Array<{ agentId: string | null; detector: string }> =
      await this.prisma.platosSafetyEvent.findMany({
        where: {
          organizationId: scope.organizationId,
          projectId: scope.projectId,
          environmentId: scope.environmentId,
          createdAt: { gte: since },
        },
        select: { agentId: true, detector: true },
      });
    const eventsByAgent = new Map<string, { pii: number; injection: number }>();
    for (const r of safetyRows) {
      const id = r.agentId;
      if (!id) continue;
      const bucket = eventsByAgent.get(id) ?? { pii: 0, injection: 0 };
      if (r.detector === "pii") bucket.pii += 1;
      if (r.detector === "injection" || r.detector === "tool_param") bucket.injection += 1;
      eventsByAgent.set(id, bucket);
    }

    // Per-agent tool errors.
    const toolRows: Array<{ agentId: string | null; status: string }> =
      await this.prisma.platosToolCallAudit.findMany({
        where: {
          organizationId: scope.organizationId,
          projectId: scope.projectId,
          environmentId: scope.environmentId,
          createdAt: { gte: since },
        },
        select: { agentId: true, status: true },
      });
    const toolErrorsByAgent = new Map<string, number>();
    for (const r of toolRows) {
      const id = r.agentId;
      if (!id) continue;
      if (r.status === "failed" || r.status === "timeout") {
        toolErrorsByAgent.set(id, (toolErrorsByAgent.get(id) ?? 0) + 1);
      }
    }

    // Per-agent approval counts.
    const approvalRows: Array<{ agentId: string | null }> =
      await this.prisma.platosAgentApproval.findMany({
        where: {
          organizationId: scope.organizationId,
          projectId: scope.projectId,
          environmentId: scope.environmentId,
          createdAt: { gte: since },
        },
        select: { agentId: true },
      });
    const approvalsByAgent = new Map<string, number>();
    for (const r of approvalRows) {
      const id = r.agentId;
      if (!id) continue;
      approvalsByAgent.set(id, (approvalsByAgent.get(id) ?? 0) + 1);
    }

    // Merge agentIds we've seen + resolve names.
    const agentIds = new Set<string>([
      ...turnsByAgent.keys(),
      ...eventsByAgent.keys(),
      ...toolErrorsByAgent.keys(),
      ...approvalsByAgent.keys(),
    ]);
    const agentRows: Array<{ id: string; name: string }> = agentIds.size
      ? await this.prisma.platosAgent.findMany({
          where: {
            id: { in: Array.from(agentIds) },
            organizationId: scope.organizationId,
            projectId: scope.projectId,
            environmentId: scope.environmentId,
          },
          select: { id: true, name: true },
        })
      : [];
    const nameById = new Map(agentRows.map((a) => [a.id, a.name]));

    const out = Array.from(agentIds).map((agentId) => {
      const turns = turnsByAgent.get(agentId) ?? 0;
      const events = eventsByAgent.get(agentId) ?? { pii: 0, injection: 0 };
      const toolErrors = toolErrorsByAgent.get(agentId) ?? 0;
      const approvalEvents = approvalsByAgent.get(agentId) ?? 0;
      const turnsDenom = Math.max(1, turns);
      const piiRate = Math.min(100, (events.pii / turnsDenom) * 100);
      const injectionRate = Math.min(100, (events.injection / turnsDenom) * 100);
      const toolErrorRate = Math.min(100, (toolErrors / turnsDenom) * 100);
      const approvalRate = Math.min(100, (approvalEvents / turnsDenom) * 100);
      const risk = Math.max(
        0,
        Math.min(
          100,
          0.4 * piiRate + 0.3 * injectionRate + 0.2 * toolErrorRate + 0.1 * approvalRate,
        ),
      );
      const band = risk >= 50 ? "high" : risk >= 20 ? "medium" : "low";
      return {
        agentId,
        agentName: nameById.get(agentId) ?? null,
        turns,
        piiEvents: events.pii,
        injectionEvents: events.injection,
        toolErrors,
        approvalEvents,
        risk: Number(risk.toFixed(1)),
        band,
      } as const;
    });
    return out.sort((a, b) => b.risk - a.risk);
  }
}
