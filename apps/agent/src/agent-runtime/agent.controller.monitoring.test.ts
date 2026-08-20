import { NotFoundException } from "@nestjs/common";
import { describe, expect, it, vi } from "vitest";
import { AgentController } from "./agent.controller";

const scope = {
  organizationId: "org-a",
  projectId: "project-a",
  environmentId: "env-a",
  userId: "operator-a",
  principal: "operator" as const,
};

function harness() {
  const threadCount = vi.fn();
  const toolHealthFindMany = vi.fn();
  const controller: any = Object.create(AgentController.prototype);
  controller.agentService = {
    prisma: {
      thread: { count: threadCount },
      toolHealth: { findMany: toolHealthFindMany },
    },
  };
  controller.agentCrud = {
    findById: vi.fn(),
  };
  controller.conversationService = {
    createThread: vi.fn(),
  };
  controller.toolRegistry = {
    getScopedTools: vi.fn(),
  };
  controller.costService = {
    getScopeCostRange: vi.fn(),
  };
  return {
    controller,
    threadCount,
    toolHealthFindMany,
    req: { scope } as any,
  };
}

describe("AgentController clean monitoring and scoped 404 regressions", () => {
  it("builds the monitoring summary from canonically scoped Thread and ToolHealth queries", async () => {
    const h = harness();
    h.threadCount.mockResolvedValueOnce(12).mockResolvedValueOnce(3);
    h.toolHealthFindMany.mockResolvedValue([
      { totalCalls: 4, lastCalledAt: new Date("2026-08-15T10:00:00.000Z") },
      { totalCalls: 1, lastCalledAt: new Date("2026-08-15T11:00:00.000Z") },
    ]);
    h.controller.costService.getScopeCostRange.mockResolvedValue({
      inputTokens: 100,
      outputTokens: 25,
      costCents: 2.5,
      // WIN-134 — three completed turns across nine model calls. The summary
      // must report the turns.
      tasks: 3,
      byLane: { inference: 2.1, embedding: 0.3, extraction: 0.1, judge: 0, skill: 0 },
      perDay: [{ date: "2026-08-15", costCents: 2.5 }],
    });

    const result = await h.controller.monitoringSummary(h.req);

    const ancestry = {
      project: { id: "project-a", organizationId: "org-a" },
    };
    expect(h.threadCount).toHaveBeenNthCalledWith(1, {
      where: { environmentId: "env-a", environment: ancestry },
    });
    expect(h.threadCount).toHaveBeenNthCalledWith(2, {
      where: {
        environmentId: "env-a",
        environment: ancestry,
        createdAt: { gte: expect.any(Date) },
      },
    });
    expect(h.toolHealthFindMany).toHaveBeenCalledWith({
      where: {
        environmentId: "env-a",
        environment: ancestry,
        lastCalledAt: { gte: expect.any(Date) },
      },
      select: { totalCalls: true, lastCalledAt: true },
    });
    expect(h.controller.costService.getScopeCostRange).toHaveBeenCalledWith(
      {
        organizationId: "org-a",
        projectId: "project-a",
        environmentId: "env-a",
      },
      7,
    );
    expect(result.cards).toEqual([
      expect.objectContaining({ id: "threads_all", value: 12 }),
      expect.objectContaining({ id: "threads_24h", value: 3 }),
      expect.objectContaining({
        id: "cost_7d",
        value: 2.5,
        details: { inputTokens: 100, outputTokens: 25 },
      }),
      expect.objectContaining({ id: "tasks_7d", value: 3, unit: "tasks" }),
      expect.objectContaining({ id: "tools_active_7d", value: 2 }),
    ]);
    // The lane split is passed through untouched — it already sums to the
    // spend card by construction and must not be re-derived here.
    expect(result.costByLane).toEqual({
      inference: 2.1,
      embedding: 0.3,
      extraction: 0.1,
      judge: 0,
      skill: 0,
    });
    expect(result.costSeries).toEqual([
      { date: "2026-08-15", costCents: 2.5 },
    ]);
  });

  it("returns a real 404 before creating a Thread for a foreign agent", async () => {
    const h = harness();
    h.controller.agentCrud.findById.mockResolvedValue(null);

    const error = await h.controller
      .createThread(h.req, { agentId: "foreign-agent", title: "Probe" })
      .catch((value: unknown) => value);

    expect(error).toBeInstanceOf(NotFoundException);
    expect((error as NotFoundException).getStatus()).toBe(404);
    expect(h.controller.agentCrud.findById).toHaveBeenCalledWith(
      "foreign-agent",
      scope,
    );
    expect(h.controller.conversationService.createThread).not.toHaveBeenCalled();
  });

  it("returns a real 404 before exposing tool metadata for a foreign agent", async () => {
    const h = harness();
    h.controller.agentCrud.findById.mockResolvedValue(null);

    const error = await h.controller
      .getAgentToolMappings(h.req, "foreign-agent")
      .catch((value: unknown) => value);

    expect(error).toBeInstanceOf(NotFoundException);
    expect((error as NotFoundException).getStatus()).toBe(404);
    expect(h.controller.agentCrud.findById).toHaveBeenCalledWith(
      "foreign-agent",
      scope,
    );
    expect(h.controller.toolRegistry.getScopedTools).not.toHaveBeenCalled();
    expect(h.toolHealthFindMany).not.toHaveBeenCalled();
  });
});
