import { NotFoundException } from "@nestjs/common";
import { describe, expect, it, vi } from "vitest";
import { AgentController } from "./agent.controller";

const scope = {
  organizationId: "org-a",
  projectId: "project-a",
  environmentId: "env-a",
  userId: "operator-external",
  principal: "operator" as const,
};
const req = { scope } as any;

function controller(prisma: any) {
  const value: any = Object.create(AgentController.prototype);
  value.agentService = { prisma };
  value.costService = { getCostByUser: vi.fn(), getCostByAgent: vi.fn() };
  value.safetyEventService = { list: vi.fn() };
  value.budgetService = { getUserConsumptionSummary: vi.fn() };
  value.agentCrud = { list: vi.fn() };
  value.ratingService = { satisfactionByAgent: vi.fn() };
  return value;
}

const externalIdentity = {
  issuer: "platos:external",
  channel: "external",
  subject: "customer-external",
  profile: null,
};

describe("AgentController monitoring identity domains", () => {
  it("returns 404 when the canonical EndUser has no current-Environment presence", async () => {
    const threadFindMany = vi.fn();
    const value = controller({
      endUser: { findFirst: vi.fn().mockResolvedValue(null) },
      thread: { findMany: threadFindMany },
    });

    const error = await value.monitoringUserDetail(req, "end-user-a").catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(NotFoundException);
    expect(threadFindMany).not.toHaveBeenCalled();
  });

  it("uses canonical ids for relational joins and the external subject for runtime metadata/cost", async () => {
    const threadFindMany = vi.fn().mockResolvedValue([]);
    const value = controller({
      endUser: {
        findFirst: vi.fn().mockResolvedValue({
          id: "end-user-a",
          displayName: "Ada",
          identities: [externalIdentity],
        }),
      },
      thread: { findMany: threadFindMany },
      agent: { findMany: vi.fn().mockResolvedValue([]) },
      memory: { findMany: vi.fn().mockResolvedValue([]), groupBy: vi.fn().mockResolvedValue([]) },
      messageRating: { findMany: vi.fn().mockResolvedValue([]) },
    });
    value.safetyEventService.list.mockResolvedValue({ rows: [] });
    value.costService.getCostByUser
      .mockResolvedValueOnce([{ userId: "customer-external", costCents: 7 }])
      .mockResolvedValueOnce([{ userId: "customer-external", costCents: 30 }]);

    const result = await value.monitoringUserDetail(req, "end-user-a");

    expect(threadFindMany).toHaveBeenCalledWith(expect.objectContaining({
      where: expect.objectContaining({ endUserId: "end-user-a", environmentId: "env-a" }),
    }));
    expect(value.safetyEventService.list).toHaveBeenCalledWith(
      { organizationId: "org-a", projectId: "project-a", environmentId: "env-a" },
      { userId: "customer-external", limit: 50 },
    );
    expect(result).toMatchObject({
      userId: "end-user-a",
      externalUserId: "customer-external",
      cost7dCents: 7,
      cost30dCents: 30,
    });
  });

  it("uses the external subject for Redis-backed consumption", async () => {
    const value = controller({
      endUser: {
        findFirst: vi.fn().mockResolvedValue({ identities: [{ subject: "customer-external" }] }),
      },
    });
    value.budgetService.getUserConsumptionSummary.mockResolvedValue({ userId: "customer-external" });

    await value.monitoringUserConsumption(req, "end-user-a");

    expect(value.budgetService.getUserConsumptionSummary).toHaveBeenCalledWith(
      scope,
      "customer-external",
    );
  });
});

describe("AgentController canonical monitoring projections", () => {
  it("counts Turn input and one assistant side even when the response has multiple Steps", async () => {
    const turnFindMany = vi.fn().mockResolvedValue([
      {
        threadId: "thread-a",
        inputText: "hello",
        input: null,
        outputText: "world",
        output: null,
        _count: { steps: 2 },
      },
    ]);
    const value = controller({
      thread: {
        findMany: vi.fn().mockResolvedValue([{ id: "thread-a", agentId: "agent-a" }]),
        groupBy: vi.fn().mockResolvedValue([{ agentId: "agent-a", _max: { updatedAt: new Date() } }]),
      },
      turn: { findMany: turnFindMany },
    });
    value.agentCrud.list.mockResolvedValue([{ id: "agent-a", name: "Agent", isActive: true }]);
    value.costService.getCostByAgent.mockResolvedValue([]);
    value.ratingService.satisfactionByAgent.mockResolvedValue([]);

    const result = await value.agentScorecard(req, "7");

    expect(result.agents[0].messages).toBe(2);
    expect(turnFindMany).toHaveBeenCalledWith(expect.objectContaining({
      select: {
        threadId: true,
        inputText: true,
        input: true,
        outputText: true,
        output: true,
        _count: { select: { steps: true } },
      },
    }));
  });

  it("projects immutable promotion audit events rather than AgentVersion.createdAt", async () => {
    const adminAuditFindMany = vi.fn().mockResolvedValue([
      {
        subjectId: "agent-a",
        createdAt: new Date("2026-08-19T12:00:00.000Z"),
        before: { previousCanaryVersionId: "version-a" },
        after: { currentVersionId: "version-a" },
      },
    ]);
    const value = controller({
      thread: { findMany: vi.fn().mockResolvedValue([]) },
      entity: { findMany: vi.fn().mockResolvedValue([]) },
      memory: { findMany: vi.fn().mockResolvedValue([]) },
      adminAudit: { findMany: adminAuditFindMany },
      safetyEvent: { findMany: vi.fn().mockResolvedValue([]) },
    });

    const result = await value.recentActivity(req, "10");

    expect(result.items).toEqual([
      expect.objectContaining({
        kind: "version.promoted",
        at: "2026-08-19T12:00:00.000Z",
        agentId: "agent-a",
        payload: { currentVersionId: "version-a" },
      }),
    ]);
    expect(adminAuditFindMany).toHaveBeenCalledWith(expect.objectContaining({
      where: expect.objectContaining({ action: "agent.canary.promote" }),
    }));
  });
});
