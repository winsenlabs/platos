import { describe, expect, it, vi } from "vitest";
import { AgentController } from "./agent.controller";

describe("AgentController monitoring summary pricing preflight", () => {
  it("does not resolve or invoke Anthropic when canonical pricing is unavailable", async () => {
    const resolvePublicApiKey = vi.fn().mockResolvedValue("provider-key");
    const prisma = {
      endUser: {
        findFirst: vi.fn().mockResolvedValue({ identities: [] }),
      },
      thread: { findMany: vi.fn().mockResolvedValue([]) },
      memory: { findMany: vi.fn().mockResolvedValue([]) },
      safetyEvent: { findMany: vi.fn().mockResolvedValue([]) },
      agent: { findMany: vi.fn().mockResolvedValue([]) },
    };
    const controller = Object.create(AgentController.prototype) as any;
    controller.agentService = { prisma, resolvePublicApiKey };
    controller.costService = {
      getCostByUser: vi.fn().mockResolvedValue([]),
      resolvePrice: vi.fn().mockRejectedValue(new Error("missing price")),
    };
    const request = {
      scope: {
        principal: "operator",
        organizationId: "org-1",
        projectId: "project-1",
        environmentId: "env-1",
        userId: "operator-1",
      },
    };

    await expect(
      controller.monitoringUserSummary(request, "end-user-1"),
    ).resolves.toMatchObject({ code: "model_pricing_unavailable" });
    expect(resolvePublicApiKey).not.toHaveBeenCalled();
    expect(prisma.agent.findMany).not.toHaveBeenCalled();
  });
});
