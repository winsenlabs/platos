import { describe, expect, it, vi } from "vitest";
import { AgentTaskService } from "./agent-task.service";

describe("AgentTaskService operator Thread resolution", () => {
  it("uses operator all-user semantics for an explicitly reserved Thread", async () => {
    const getOrCreateThread = vi.fn().mockResolvedValue({
      id: "reserved-thread",
      endUserId: "seeded-end-user",
    });
    const conversationService = {
      prisma: {
        agentBinding: {
          findFirst: vi.fn().mockResolvedValue({ clusterId: null }),
        },
      },
      getOrCreateThread,
    };
    const service = new AgentTaskService(
      {} as any,
      conversationService as any,
      {} as any,
      {} as any,
      {} as any,
      {} as any,
      {} as any,
      {} as any,
      {} as any,
      {} as any,
      {} as any,
      {} as any,
    );

    const stream = service.executeStreamingTurn(
      "persist this attachment",
      {
        organizationId: "organization",
        projectId: "project",
        environmentId: "environment",
        userId: "operator-user",
        principal: "operator",
      } as any,
      { agentId: "agent-a", threadId: "reserved-thread" },
    );

    await stream.next();

    expect(getOrCreateThread).toHaveBeenCalledWith(
      expect.objectContaining({ principal: "operator" }),
      "agent-a",
      "reserved-thread",
    );
  });
});
