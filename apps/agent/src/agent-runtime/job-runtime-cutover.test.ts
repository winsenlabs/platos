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

describe("background-operation catalog clean Job lookup", () => {
  const scope: RequestScope = {
    organizationId: "org-a",
    projectId: "project-a",
    environmentId: "env-a",
    userId: "user-a",
    agentId: "agent-a",
  };

  it("lists scoped canonical Jobs through both BGO names", async () => {
    const findMany = vi.fn().mockResolvedValue([
      {
        externalId: "send-report",
        triggerType: "agent-spawn",
        description: "Send a report",
      },
    ]);
    const service = new AgentService(
      {} as any,
      { job: { findMany } } as any,
      { get: vi.fn() } as any,
      { get: vi.fn(() => null) } as any,
    );
    const tools = (service as any).buildMetaTools(scope, {
      metaTools: { list_bgos: true },
    });

    const result = await tools.list_bgos.execute({ filter: "report", limit: 10 });

    expect(findMany).toHaveBeenCalledWith({
      where: {
        environmentId: "env-a",
        environment: {
          projectId: "project-a",
          project: { organizationId: "org-a" },
        },
        externalId: { contains: "report" },
      },
      select: {
        externalId: true,
        triggerType: true,
        description: true,
      },
      orderBy: { externalId: "asc" },
      take: 10,
    });
    expect(result).toEqual({
      bgos: [
        {
          slug: "send-report",
          filePath: null,
          triggerSource: "agent-spawn",
          description: "Send a report",
        },
      ],
      tasks: [
        {
          slug: "send-report",
          filePath: null,
          triggerSource: "agent-spawn",
          description: "Send a report",
        },
      ],
    });

    const deprecated = await tools.list_tasks.execute({});
    expect(deprecated).toMatchObject({ bgos: result.bgos, tasks: result.tasks });
    expect(deprecated.deprecation_notice).toContain("list_tasks");
  });

  it("redacts catalog persistence failures", async () => {
    const service = new AgentService(
      {} as any,
      {
        job: {
          findMany: vi.fn().mockRejectedValue(new Error("postgres://sentinel-secret")),
        },
      } as any,
      { get: vi.fn() } as any,
      { get: vi.fn(() => null) } as any,
    );
    const tools = (service as any).buildMetaTools(scope, {
      metaTools: { list_bgos: true },
    });

    const result = await tools.list_bgos.execute({});

    expect(result).toEqual({
      status: "failed",
      error: "Background operation catalog is unavailable.",
    });
    expect(JSON.stringify(result)).not.toContain("sentinel-secret");
  });

  it("fails explicitly when canonical run history is unavailable", async () => {
    const service = new AgentService(
      {} as any,
      {} as any,
      { get: vi.fn() } as any,
      { get: vi.fn(() => null) } as any,
    );
    const tools = (service as any).buildMetaTools(scope, {
      metaTools: { list_runs: true },
    });

    await expect(tools.list_runs.execute({ limit: 25 })).resolves.toEqual({
      error: "unavailable",
      message: "Task run history is not available through the canonical control database.",
    });
  });
});
