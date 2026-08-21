import { NotFoundException } from "@nestjs/common";
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
      where: { environmentId: scope.environmentId },
    });
    expect(result.rows[0]).toMatchObject({
      toolId: "tool-a",
      category: "uncategorized",
      dispatchable: true,
      health: { lastStatus: "healthy", totalCalls: 9, avgLatencyMs: 12 },
    });
    expect(result.rows[1]).toMatchObject({
      toolId: "tool-b",
      category: "support",
      dispatchable: false,
      health: {
        lastStatus: null,
        failCount: 0,
        totalCalls: 0,
        totalFailures: 0,
        avgLatencyMs: null,
        p95LatencyMs: null,
        lastCalledAt: null,
      },
    });
  });
});
