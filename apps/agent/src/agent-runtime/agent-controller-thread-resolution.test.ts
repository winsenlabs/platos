import { describe, expect, it, vi } from "vitest";
import { AgentController } from "./agent.controller";

describe("AgentController thread-scoped Agent resolution", () => {
  it("resolves an operator's seeded EndUser Thread without an explicit Agent ID", async () => {
    const getThread = vi.fn().mockResolvedValue({
      id: "reserved-thread",
      agentId: "agent-a",
    });
    const controller: any = Object.create(AgentController.prototype);
    controller.conversationService = { getThread };
    const scope = {
      organizationId: "organization",
      projectId: "project",
      environmentId: "environment",
      userId: "operator-user",
      principal: "operator",
    };

    await expect(controller.resolveThreadAgentId(
      "reserved-thread",
      undefined,
      scope,
    )).resolves.toBe("agent-a");
    expect(getThread).toHaveBeenCalledWith(
      "reserved-thread",
      scope,
      { allUsers: true },
    );
  });
});
