import type { LoaderFunctionArgs } from "@remix-run/node";
import { beforeEach, describe, expect, it, vi } from "vitest";

const { requireEnvironmentScope, agentPanel } = vi.hoisted(() => ({
  requireEnvironmentScope: vi.fn(),
  agentPanel: vi.fn(),
}));

vi.mock("../app/services/auth.server", () => ({ requireEnvironmentScope }));
vi.mock("../app/services/platosAgent.server", () => ({ agentPanel }));

import { loadSurface } from "../app/services/m4Route.server";

function args(): LoaderFunctionArgs {
  return {
    request: new Request("https://dashboard.example/entity"),
    params: {
      organizationSlug: "org",
      projectParam: "project",
      envParam: "env",
      entityId: "11111111-1111-4111-8111-111111111111",
    },
    context: {},
  };
}

describe("M4 route HTTP contracts", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    requireEnvironmentScope.mockResolvedValue({ scope: {} });
  });

  it("propagates an absent detail resource as a true HTTP 404", async () => {
    agentPanel.mockResolvedValue({
      ok: false,
      error: { status: 404, code: "AGENT_API_ERROR", message: "Entity not found" },
    });

    await expect(
      loadSurface(args(), {
        surface: "entities",
        title: "Entity",
        description: "Detail",
        endpoint: "/api/v1/agent/entities/:entityId",
        notFoundAsResponse: true,
      }),
    ).rejects.toMatchObject({ status: 404 });
    expect(agentPanel).toHaveBeenCalledTimes(1);
  });

  it("keeps a non-404 service failure isolated to a non-zero panel result", async () => {
    agentPanel.mockResolvedValue({
      ok: false,
      error: { status: 503, code: "AGENT_UNAVAILABLE", message: "Unavailable" },
    });

    const response = await loadSurface(args(), {
      surface: "entities",
      title: "Entity",
      description: "Detail",
      endpoint: "/api/v1/agent/entities/:entityId",
      notFoundAsResponse: true,
    });
    const payload = await response.json();

    expect(agentPanel).toHaveBeenCalledTimes(1);
    expect(payload.panel).toMatchObject({
      ok: false,
      error: { status: 503, code: "AGENT_UNAVAILABLE" },
    });
  });

  it("interpolates a route parameter alias into the canonical generated path", async () => {
    agentPanel.mockResolvedValue({ ok: true, data: { task: { id: "job-1" } } });
    const requestArgs = args();
    requestArgs.params = { ...requestArgs.params, taskId: "job-1" };

    await loadSurface(requestArgs, {
      surface: "jobs",
      title: "Job",
      description: "Detail",
      endpoint: "/api/v1/agent/platos-tasks/:id",
      parameterAliases: { id: "taskId" },
    });

    expect(agentPanel).toHaveBeenCalledTimes(1);
    expect(agentPanel).toHaveBeenCalledWith("/api/v1/agent/platos-tasks/job-1", expect.anything());
  });
});
