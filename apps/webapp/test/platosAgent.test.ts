import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("~/env.server", () => ({
  env: { PLATOS_AGENT_API_URL: "http://agent.internal:3100" },
}));

import { agentRequest, mcpManagementRequest, PlatosAgentApiError } from "../app/services/platosAgent.server";

const scope = {
  organizationId: "org-1",
  projectId: "project-1",
  environmentId: "env-1",
  userId: "user-1",
};

beforeEach(() => {
  vi.stubGlobal("fetch", vi.fn());
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("platos Agent transport errors", () => {
  it("uses a non-2xx string error when message is absent", async () => {
    vi.mocked(fetch).mockResolvedValue(new Response(JSON.stringify({ error: "Thread not found" }), {
      status: 404,
      headers: { "Content-Type": "application/json" },
    }));

    const error = await agentRequest("/api/v1/agent/threads/missing", scope).catch((value: unknown) => value);

    expect(error).toBeInstanceOf(PlatosAgentApiError);
    expect(error).toMatchObject({ status: 404, message: "Thread not found" });
  });

  it("treats legacy HTTP-200 error envelopes as failures", async () => {
    vi.mocked(fetch).mockResolvedValue(new Response(JSON.stringify({
      error: "Version not found",
      status: 404,
    }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    }));

    const error = await agentRequest("/api/v1/agent/agents/agent-1/versions/missing", scope).catch((value: unknown) => value);

    expect(error).toBeInstanceOf(PlatosAgentApiError);
    expect(error).toMatchObject({ status: 404, code: "AGENT_API_ERROR", message: "Version not found" });
  });

  it("keeps successful data with an unrelated status field", async () => {
    vi.mocked(fetch).mockResolvedValue(new Response(JSON.stringify({ status: 200, value: "ready" }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    }));

    await expect(agentRequest("/api/v1/agent/health", scope)).resolves.toEqual({ status: 200, value: "ready" });
  });

  it("carries an operator Agent pin only through the server-side control-plane transport", async () => {
    vi.mocked(fetch).mockResolvedValue(new Response(JSON.stringify({ memories: [] }), { status: 200 }));

    await agentRequest("/api/v1/memory", { ...scope, agentId: "agent-1" });

    expect(fetch).toHaveBeenCalledWith(
      "http://agent.internal:3100/api/v1/memory",
      expect.objectContaining({
        headers: expect.objectContaining({
          "X-Platos-Agent-Id": "agent-1",
        }),
      }),
    );
  });

  it("allows only exact method-aware MCP management operations", async () => {
    vi.mocked(fetch).mockResolvedValue(new Response(JSON.stringify({ tokens: [], total: 0, limit: 25, offset: 0 }), { status: 200 }));

    await expect(mcpManagementRequest("/mcp/platform/tokens?limit=25&offset=0", scope, { method: "GET" }))
      .resolves.toMatchObject({ total: 0 });
    expect(fetch).toHaveBeenCalledWith(
      "http://agent.internal:3100/mcp/platform/tokens?limit=25&offset=0",
      expect.objectContaining({ method: "GET" }),
    );

    await expect(mcpManagementRequest("/mcp/platform", scope, { method: "POST", body: {} }))
      .rejects.toThrow("Unsupported MCP management operation");
    await expect(mcpManagementRequest("/mcp/entity/acme/inject-context", scope, { method: "GET" }))
      .rejects.toThrow("Unsupported MCP management operation");
    expect(fetch).toHaveBeenCalledTimes(1);
  });
});
