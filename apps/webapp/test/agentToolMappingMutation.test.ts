import type { ActionFunctionArgs } from "@remix-run/node";
import { beforeEach, describe, expect, it, vi } from "vitest";

const { requireEnvironmentScope, agentRequest, PlatosAgentApiError } = vi.hoisted(() => {
  class MockPlatosAgentApiError extends Error {
    constructor(
      public readonly status: number,
      public readonly code: string,
      message: string,
    ) {
      super(message);
    }
  }
  return {
    requireEnvironmentScope: vi.fn(),
    agentRequest: vi.fn(),
    PlatosAgentApiError: MockPlatosAgentApiError,
  };
});

vi.mock("../app/services/auth.server", () => ({ requireEnvironmentScope }));
vi.mock("../app/services/platosAgent.server", () => ({ agentRequest, PlatosAgentApiError }));

import { action } from "../app/routes/_app.orgs.$organizationSlug.projects.$projectParam.env.$envParam.agents.$agentId.tools/route";

const AGENT_ID = "11111111-1111-4111-8111-111111111111";
const TOOL_ID = "22222222-2222-4222-8222-222222222222";

function args(fields: Record<string, string>): ActionFunctionArgs {
  return {
    request: new Request("https://dashboard.example/agents/agent-a/tools", {
      method: "POST",
      body: new URLSearchParams(fields),
    }),
    params: {
      organizationSlug: "org",
      projectParam: "project",
      envParam: "env",
      agentId: AGENT_ID,
    },
    context: {},
  };
}

describe("Agent Tool dashboard mutation ownership", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    requireEnvironmentScope.mockResolvedValue({
      scope: {
        organizationId: "org-a",
        projectId: "project-a",
        environmentId: "env-a",
        userId: "operator-a",
      },
    });
    agentRequest.mockResolvedValue({ agentVersionId: "version-b", toolId: TOOL_ID, enabled: false });
  });

  it("uses the route Agent ID and loader-provided canonical Tool ID", async () => {
    const response = await action(args({ toolId: TOOL_ID, enabled: "false" }));

    expect(response.status).toBe(200);
    expect(requireEnvironmentScope).toHaveBeenCalledWith(expect.objectContaining({ access: "secret:mutate" }));
    expect(agentRequest).toHaveBeenCalledWith(
      `/api/v1/agent/agents/${AGENT_ID}/tool-mappings/${TOOL_ID}`,
      {
        organizationId: "org-a",
        projectId: "project-a",
        environmentId: "env-a",
        userId: "operator-a",
        agentId: AGENT_ID,
      },
      { method: "PATCH", body: { enabled: false } },
    );
  });

  it("rejects legacy Entity/name identity and malformed enabled state before the API", async () => {
    const response = await action(args({
      sourceEntity: "entity-a",
      toolName: "tickets.list",
      enabled: "yes",
    }));

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toMatchObject({
      ok: false,
      code: "invalid_agent_tool_mapping_request",
    });
    expect(agentRequest).not.toHaveBeenCalled();
  });

  it("preserves the Agent API scoped 404 code without reflecting upstream detail", async () => {
    agentRequest.mockRejectedValue(new PlatosAgentApiError(
      404,
      "agent_tool_mapping_not_found",
      "Agent tool mapping not found in this scope",
    ));

    const response = await action(args({ toolId: "foreign-tool", enabled: "false" }));

    expect(response.status).toBe(404);
    await expect(response.json()).resolves.toEqual({
      ok: false,
      code: "agent_tool_mapping_not_found",
      error: "Agent Tool mapping update failed",
    });
  });
});
