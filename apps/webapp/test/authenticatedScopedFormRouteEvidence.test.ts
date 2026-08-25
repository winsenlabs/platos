import type { ActionFunctionArgs } from "@remix-run/node";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { canonicalOperatorScope } from "../../../tests/persisted-state-gate/fixture-contract";

const { agentRequest, requireEnvironmentScope } = vi.hoisted(() => ({
  agentRequest: vi.fn(),
  requireEnvironmentScope: vi.fn(),
}));

vi.mock("~/env.server", () => ({
  env: {
    PLATOS_AGENT_API_URL: "http://agent.invalid",
    PLATOS_INTERNAL_AUTH_TOKEN: "SENTINEL_SERVER_ONLY_OPERATOR_CREDENTIAL",
  },
}));
vi.mock("~/services/auth.server", () => ({ requireEnvironmentScope }));
vi.mock("~/services/platosAgent.server", async (importOriginal) => ({
  ...await importOriginal<typeof import("../app/services/platosAgent.server")>(),
  agentRequest,
}));

import { action as toolTestAction } from "../app/routes/_app.orgs.$organizationSlug.projects.$projectParam.env.$envParam.agent-tools._index/route";
import { action as canaryAction } from "../app/routes/_app.orgs.$organizationSlug.projects.$projectParam.env.$envParam.agents.$agentId.canary/route";
import { action as toolMappingAction } from "../app/routes/_app.orgs.$organizationSlug.projects.$projectParam.env.$envParam.agents.$agentId.tools/route";
import { PlatosAgentApiError } from "../app/services/platosAgent.server";

const primary = canonicalOperatorScope("alpha");
const secondary = canonicalOperatorScope("beta");
const upstreamSecret = "SENTINEL_UPSTREAM_PROVIDER_OR_DATABASE_DETAILS";

function params() {
  return {
    organizationSlug: primary.organizationSlug,
    projectParam: primary.projectSlug,
    envParam: primary.environmentSlug,
    agentId: primary.agentId,
  };
}

function actionArgs(path: string, body: URLSearchParams): ActionFunctionArgs {
  return {
    request: new Request(`https://dashboard.example${path}`, { method: "POST", body }),
    params: params(),
    context: {},
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  requireEnvironmentScope.mockImplementation(async ({ organizationSlug, projectSlug, environmentSlug }) => {
    if (
      organizationSlug !== primary.organizationSlug ||
      projectSlug !== primary.projectSlug ||
      environmentSlug !== primary.environmentSlug
    ) {
      throw new Response("Environment not found", { status: 404 });
    }
    return {
      scope: {
        organizationId: primary.organizationId,
        projectId: primary.projectId,
        environmentId: primary.environmentId,
        userId: primary.userId,
      },
    };
  });
  agentRequest.mockResolvedValue({ ok: true });
});

describe("authenticated scoped form route evidence", () => {
  it.each([
    ["route-025", toolTestAction, "/agent-tools", new URLSearchParams({ toolId: "tool_1", sourceEntityId: "entity.one" })],
    ["route-028", canaryAction, `/agents/${primary.agentId}/canary`, new URLSearchParams({ intent: "promote" })],
    ["route-037", toolMappingAction, `/agents/${primary.agentId}/tools`, new URLSearchParams({ toolId: "tool_1", enabled: "true" })],
  ] as const)("%s rejects unauthenticated and mixed Environment scopes before transport", async (_routeId, action, suffix, body) => {
    requireEnvironmentScope.mockRejectedValueOnce(new Response(null, { status: 302, headers: { Location: "/login" } }));
    await expect(action(actionArgs(
      `/orgs/${primary.organizationSlug}/projects/${primary.projectSlug}/env/${primary.environmentSlug}${suffix}`,
      body,
    ))).rejects.toMatchObject({ status: 302 });
    expect(agentRequest).not.toHaveBeenCalled();

    const args = actionArgs(
      `/orgs/${secondary.organizationSlug}/projects/${primary.projectSlug}/env/${primary.environmentSlug}${suffix}`,
      body,
    );
    args.params = { ...args.params, organizationSlug: secondary.organizationSlug };
    await expect(action(args)).rejects.toMatchObject({ status: 404 });
    expect(agentRequest).not.toHaveBeenCalled();
  });

  it("route-025 submits one validated direct Tool test", async () => {
    const response = await toolTestAction(actionArgs(
      `/orgs/${primary.organizationSlug}/projects/${primary.projectSlug}/env/${primary.environmentSlug}/agent-tools`,
      new URLSearchParams({ toolId: "tool_1", sourceEntityId: "entity.one" }),
    ));

    expect(response.status).toBe(200);
    expect(requireEnvironmentScope).toHaveBeenCalledWith(expect.objectContaining({ access: "secret:mutate" }));
    expect(agentRequest).toHaveBeenCalledWith(
      "/api/v1/agent/tools/tool_1/test",
      expect.objectContaining({ environmentId: primary.environmentId }),
      { method: "POST", body: { sourceEntityId: "entity.one", params: {} } },
    );
  });

  it.each([
    [{ toolId: "", sourceEntityId: "entity.one" }],
    [{ toolId: "tool_1", sourceEntityId: "invalid value" }],
  ])("route-025 rejects a malformed Tool test form before transport", async (values) => {
    const response = await toolTestAction(actionArgs(
      `/orgs/${primary.organizationSlug}/projects/${primary.projectSlug}/env/${primary.environmentSlug}/agent-tools`,
      new URLSearchParams(values),
    ));
    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ ok: false, error: "Invalid Tool selection" });
    expect(agentRequest).not.toHaveBeenCalled();
  });

  it("route-028 submits validated set and promote operations to exact Agent paths", async () => {
    const setResponse = await canaryAction(actionArgs(
      `/orgs/${primary.organizationSlug}/projects/${primary.projectSlug}/env/${primary.environmentSlug}/agents/${primary.agentId}/canary`,
      new URLSearchParams({ intent: "set", canaryPercent: "25", canaryVersionId: "version-2" }),
    ));
    expect(setResponse.status).toBe(200);
    expect(agentRequest).toHaveBeenNthCalledWith(
      1,
      `/api/v1/agent/agents/${primary.agentId}/canary`,
      expect.objectContaining({ environmentId: primary.environmentId }),
      { method: "PATCH", body: { canaryVersionId: "version-2", canaryPercent: 25 } },
    );

    const promoteResponse = await canaryAction(actionArgs(
      `/orgs/${primary.organizationSlug}/projects/${primary.projectSlug}/env/${primary.environmentSlug}/agents/${primary.agentId}/canary`,
      new URLSearchParams({ intent: "promote" }),
    ));
    expect(promoteResponse.status).toBe(200);
    expect(agentRequest).toHaveBeenNthCalledWith(
      2,
      `/api/v1/agent/agents/${primary.agentId}/canary/promote`,
      expect.objectContaining({ environmentId: primary.environmentId }),
      { method: "POST" },
    );
  });

  it.each([
    [{ intent: "set", canaryPercent: "101", canaryVersionId: "version-2" }, "Choose a canary version and a whole percent from 0 to 100"],
    [{ intent: "set", canaryPercent: "25", canaryVersionId: "" }, "Choose a canary version and a whole percent from 0 to 100"],
    [{ intent: "other" }, "Unsupported canary operation"],
  ])("route-028 rejects malformed or unsupported Canary forms before transport", async (values, error) => {
    const response = await canaryAction(actionArgs(
      `/orgs/${primary.organizationSlug}/projects/${primary.projectSlug}/env/${primary.environmentSlug}/agents/${primary.agentId}/canary`,
      new URLSearchParams(values),
    ));
    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ ok: false, error });
    expect(agentRequest).not.toHaveBeenCalled();
  });

  it("route-037 submits a canonical Agent Tool mapping identity and enabled state", async () => {
    const response = await toolMappingAction(actionArgs(
      `/orgs/${primary.organizationSlug}/projects/${primary.projectSlug}/env/${primary.environmentSlug}/agents/${primary.agentId}/tools`,
      new URLSearchParams({ toolId: "tool_1", enabled: "false" }),
    ));

    expect(response.status).toBe(200);
    expect(agentRequest).toHaveBeenCalledWith(
      `/api/v1/agent/agents/${primary.agentId}/tool-mappings/tool_1`,
      expect.objectContaining({ environmentId: primary.environmentId, agentId: primary.agentId }),
      { method: "PATCH", body: { enabled: false } },
    );
  });

  it.each([
    [{ toolId: "", enabled: "true" }],
    [{ toolId: "tool_1", enabled: "yes" }],
  ])("route-037 rejects a malformed Agent Tool mapping form before transport", async (values) => {
    const response = await toolMappingAction(actionArgs(
      `/orgs/${primary.organizationSlug}/projects/${primary.projectSlug}/env/${primary.environmentSlug}/agents/${primary.agentId}/tools`,
      new URLSearchParams(values),
    ));
    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({ ok: false, code: "invalid_agent_tool_mapping_request" });
    expect(agentRequest).not.toHaveBeenCalled();
  });

  it.each([
    ["route-025", toolTestAction, "/agent-tools", new URLSearchParams({ toolId: "tool_1", sourceEntityId: "entity.one" }), "Tool test failed"],
    ["route-028", canaryAction, `/agents/${primary.agentId}/canary`, new URLSearchParams({ intent: "promote" }), "Canary operation failed"],
    ["route-037", toolMappingAction, `/agents/${primary.agentId}/tools`, new URLSearchParams({ toolId: "tool_1", enabled: "true" }), "Agent Tool mapping update failed"],
  ] as const)("%s preserves a stable API code without reflecting upstream details", async (_routeId, action, suffix, body, message) => {
    agentRequest.mockRejectedValueOnce(new PlatosAgentApiError(503, "AGENT_UNAVAILABLE", upstreamSecret, {
      credential: upstreamSecret,
    }));
    const response = await action(actionArgs(
      `/orgs/${primary.organizationSlug}/projects/${primary.projectSlug}/env/${primary.environmentSlug}${suffix}`,
      body,
    ));
    const serialized = JSON.stringify(await response.json());

    expect(response.status).toBe(503);
    expect(serialized).toContain("AGENT_UNAVAILABLE");
    expect(serialized).toContain(message);
    expect(serialized).not.toContain(upstreamSecret);
  });
});
