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
const AGENT_ID = "11111111-1111-4111-8111-111111111111";
const TOOL_ID = "22222222-2222-4222-8222-222222222222";

function controllerHarness() {
  const controller: any = Object.create(AgentController.prototype);
  controller.agentCrud = { findById: vi.fn(), setToolEnabled: vi.fn() };
  controller.agentService = {
    prisma: {
      toolHealth: { findMany: vi.fn().mockResolvedValue([]) },
    },
  };
  controller.toolRegistry = {
    getScopedTools: vi.fn().mockReturnValue([]),
    refreshEnvironmentPolicies: vi.fn().mockResolvedValue(0),
  };
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

  it("loads canonical Tool IDs and projects Agent policy state separately from Environment exposure", async () => {
    const { controller, req } = controllerHarness();
    controller.agentCrud.findById.mockResolvedValue({
      id: AGENT_ID,
      currentVersionId: "version-a",
      contextMapping: null,
      toolsBlockConfig: {},
    });
    controller.toolRegistry.getScopedTools.mockReturnValue([
      {
        toolId: TOOL_ID,
        toolName: "tickets.list",
        description: "List tickets",
        category: "support",
        paramSchema: { type: "object", properties: {} },
        sourceEntityId: "support",
        enabled: true,
        dispatchable: true,
        allowedAgentIds: ["agent-b"],
      },
    ]);

    const result = await controller.getAgentToolMappings(req, AGENT_ID);

    expect(controller.toolRegistry.getScopedTools).toHaveBeenCalledWith(
      {
        organizationId: "org-a",
        projectId: "project-a",
        environmentId: "environment-a",
      },
      { enabledOnly: false },
    );
    expect(result.tools).toEqual([
      expect.objectContaining({
        agentId: AGENT_ID,
        agentVersionId: "version-a",
        toolId: TOOL_ID,
        enabled: false,
        environmentEnabled: true,
        dispatchable: false,
      }),
    ]);
  });

  it("mutates the scoped Agent policy by canonical Tool ID and refreshes only after persistence", async () => {
    const { controller, req } = controllerHarness();
    controller.agentCrud.setToolEnabled.mockResolvedValue({
      agentId: AGENT_ID,
      agentVersionId: "version-b",
      previousAgentVersionId: "version-a",
      toolId: TOOL_ID,
      enabled: false,
    });

    const result = await controller.setAgentToolEnabled(req, AGENT_ID, TOOL_ID, { enabled: false });

    expect(controller.agentCrud.setToolEnabled).toHaveBeenCalledWith(
      AGENT_ID,
      TOOL_ID,
      scope,
      false,
    );
    expect(controller.toolRegistry.refreshEnvironmentPolicies).toHaveBeenCalledWith({
      organizationId: "org-a",
      projectId: "project-a",
      environmentId: "environment-a",
    });
    expect(controller.agentCrud.setToolEnabled.mock.invocationCallOrder[0]).toBeLessThan(
      controller.toolRegistry.refreshEnvironmentPolicies.mock.invocationCallOrder[0],
    );
    expect(result).toMatchObject({ ok: true, agentVersionId: "version-b", toolId: TOOL_ID, enabled: false });
  });

  it("returns stable 400 and scoped 404 Agent Tool mapping errors", async () => {
    const { controller, req } = controllerHarness();

    const malformed = await controller
      .setAgentToolEnabled(req, AGENT_ID, TOOL_ID, { enabled: "false" })
      .catch((value: unknown) => value);
    expect(malformed).toBeInstanceOf(BadRequestException);
    expect((malformed as BadRequestException).getResponse()).toMatchObject({
      code: "invalid_agent_tool_mapping_request",
    });
    expect(controller.agentCrud.setToolEnabled).not.toHaveBeenCalled();

    const malformedId = await controller
      .setAgentToolEnabled(req, AGENT_ID, "not-a-tool-uuid", { enabled: false })
      .catch((value: unknown) => value);
    expect(malformedId).toBeInstanceOf(BadRequestException);
    expect((malformedId as BadRequestException).getResponse()).toMatchObject({
      code: "invalid_agent_tool_mapping_request",
    });
    expect(controller.agentCrud.setToolEnabled).not.toHaveBeenCalled();

    controller.agentCrud.setToolEnabled.mockResolvedValue(null);
    const missing = await controller
      .setAgentToolEnabled(req, AGENT_ID, "33333333-3333-4333-8333-333333333333", { enabled: false })
      .catch((value: unknown) => value);
    expect(missing).toBeInstanceOf(NotFoundException);
    expect((missing as NotFoundException).getResponse()).toMatchObject({
      code: "agent_tool_mapping_not_found",
    });
    expect(controller.toolRegistry.refreshEnvironmentPolicies).not.toHaveBeenCalled();
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
