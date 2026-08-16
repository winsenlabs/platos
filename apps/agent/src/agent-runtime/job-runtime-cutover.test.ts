import { describe, expect, it, vi } from "vitest";
import type { RequestScope } from "../auth/scope.guard";
import { AgentService } from "./agent.service";

describe("run_platos_task clean Job lookup", () => {
  it("looks up the external task id only when Job is active in canonical scope", async () => {
    const findFirst = vi.fn().mockResolvedValue(null);
    const service = new AgentService(
      {} as any,
      { job: { findFirst } } as any,
      { get: vi.fn() } as any,
      { get: vi.fn(() => null) } as any,
    );
    const scope: RequestScope = {
      organizationId: "org-a",
      projectId: "project-a",
      environmentId: "env-a",
      userId: "user-a",
      agentId: "agent-a",
    };

    const tools = (service as any).buildMetaTools(scope, {
      metaTools: { run_platos_task: true },
    });
    const result = await tools.run_platos_task.execute({
      taskId: "send-report",
      payload: { reportId: "report-a" },
    });

    expect(findFirst).toHaveBeenCalledWith({
      where: {
        externalId: "send-report",
        environmentId: "env-a",
        status: "ACTIVE",
        environment: {
          projectId: "project-a",
          project: { organizationId: "org-a" },
        },
      },
      select: {
        id: true,
        externalId: true,
        displayName: true,
        triggerType: true,
        allowedAgentIds: true,
      },
    });
    expect(result).toEqual({
      error: 'Task "send-report" not found or inactive in this scope.',
    });
  });
});
