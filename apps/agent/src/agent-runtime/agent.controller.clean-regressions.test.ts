import { BadRequestException, NotFoundException } from "@nestjs/common";
import { describe, expect, it, vi } from "vitest";
import { AgentController } from "./agent.controller";

const scope = {
  organizationId: "org-a",
  projectId: "project-a",
  environmentId: "environment-a",
  userId: "user-a",
  principal: "operator" as const,
};

function controllerHarness() {
  const controller: any = Object.create(AgentController.prototype);
  controller.agentCrud = { findById: vi.fn() };
  controller.agentService = {
    prisma: {
      toolHealth: { findMany: vi.fn().mockResolvedValue([]) },
    },
  };
  controller.toolRegistry = { getScopedTools: vi.fn().mockReturnValue([]) };
  controller.conversationService = {
    getThread: vi.fn(),
    setThreadTags: vi.fn(),
  };
  return { controller, req: { scope } as any };
}

describe("AgentController clean scope regressions", () => {
  it("throws a real scoped 404 for a foreign agent instead of returning HTTP 200", async () => {
    const { controller, req } = controllerHarness();
    controller.agentCrud.findById.mockResolvedValue(null);

    const error = await controller.getAgent(req, "foreign-agent").catch((value: unknown) => value);

    expect(error).toBeInstanceOf(NotFoundException);
    expect((error as NotFoundException).getStatus()).toBe(404);
    expect(controller.agentCrud.findById).toHaveBeenCalledWith("foreign-agent", scope);
  });

  it("throws real HTTP errors for absent Threads and invalid metadata", async () => {
    const { controller, req } = controllerHarness();
    controller.conversationService.getThread.mockResolvedValue(null);

    const missing = await controller.getThread(req, "missing-thread", "true").catch((value: unknown) => value);
    const invalid = await controller.setTags(req, "thread-a", { tags: "not-an-array" }).catch((value: unknown) => value);

    expect(missing).toBeInstanceOf(NotFoundException);
    expect((missing as NotFoundException).getStatus()).toBe(404);
    expect(invalid).toBeInstanceOf(BadRequestException);
    expect((invalid as BadRequestException).getStatus()).toBe(400);
    expect(controller.conversationService.setThreadTags).not.toHaveBeenCalled();
  });

  it("joins the tool matrix through clean ToolHealth.entityExternalId and emits defaults", async () => {
    const { controller, req } = controllerHarness();
    controller.toolRegistry.getScopedTools.mockReturnValue([
      {
        toolId: "tool-a",
        toolName: "tickets.list",
        description: "List tickets",
        category: null,
        paramSchema: { type: "object" },
        sourceEntityId: "support",
        entityPk: "entity-pk",
        callbackUrl: "https://entity.test/tools",
        enabled: true,
        dispatchable: true,
      },
      {
        toolId: "tool-b",
        toolName: "tickets.get",
        description: "Get ticket",
        category: "support",
        paramSchema: { type: "object" },
        sourceEntityId: "support",
        entityPk: "entity-pk",
        callbackUrl: "https://entity.test/tools",
        enabled: false,
        dispatchable: false,
      },
    ]);
    controller.agentService.prisma.toolHealth.findMany.mockResolvedValue([
      {
        toolId: "tool-a",
        entityExternalId: "support",
        lastStatus: "healthy",
        failCount: 1,
        totalCalls: 9,
        totalFailures: 1,
        avgLatencyMs: 12,
        p95LatencyMs: 20,
        lastCalledAt: new Date("2026-08-15T00:00:00.000Z"),
      },
    ]);

    const result = await controller.toolMatrix(req);

    expect(controller.agentService.prisma.toolHealth.findMany).toHaveBeenCalledWith({
      where: {
        environmentId: scope.environmentId,
        OR: [
          { toolId: "tool-b", entityExternalId: "support" },
          { toolId: "tool-a", entityExternalId: "support" },
        ],
      },
    });
    expect(result.rows).toContainEqual(expect.objectContaining({
      toolId: "tool-a",
      category: "uncategorized",
      dispatchable: true,
      health: expect.objectContaining({ lastStatus: "healthy", totalCalls: 9, avgLatencyMs: 12 }),
    }));
    expect(result.rows).toContainEqual(expect.objectContaining({
      toolId: "tool-b",
      category: "support",
      dispatchable: false,
      health: expect.objectContaining({
        lastStatus: null,
        failCount: 0,
        totalCalls: 0,
        totalFailures: 0,
        avgLatencyMs: null,
        p95LatencyMs: null,
        lastCalledAt: null,
      }),
    }));
    expect(result.aggregates).toEqual({ dispatchable: 1, unavailable: 1, disabled: 1 });
  });

  it("returns exact Tool availability aggregates beyond the current page", async () => {
    const { controller, req } = controllerHarness();
    controller.toolRegistry.getScopedTools.mockReturnValue(Array.from({ length: 30 }, (_, index) => ({
      toolId: `tool-${String(index + 1).padStart(2, "0")}`,
      toolName: `tool.${String(index + 1).padStart(2, "0")}`,
      sourceEntityId: "dense",
      enabled: true,
      dispatchable: index < 25,
    })));

    const result = await controller.toolMatrix(req, undefined, "25");

    expect(result.rows).toHaveLength(25);
    expect(result.total).toBe(30);
    expect(result.aggregates).toEqual({ dispatchable: 25, unavailable: 5, disabled: 0 });
  });
});
