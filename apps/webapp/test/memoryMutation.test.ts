import type { ActionFunctionArgs } from "@remix-run/node";
import { beforeEach, describe, expect, it, vi } from "vitest";

const { requireEnvironmentScope, agentRequest } = vi.hoisted(() => ({
  requireEnvironmentScope: vi.fn(),
  agentRequest: vi.fn(),
}));

vi.mock("../app/services/auth.server", () => ({ requireEnvironmentScope }));
vi.mock("../app/services/platosAgent.server", () => ({
  agentRequest,
  PlatosAgentApiError: class PlatosAgentApiError extends Error {},
}));

import { action } from "../app/routes/_app.orgs.$organizationSlug.projects.$projectParam.env.$envParam.memories._index/route";

function args(fields: Record<string, string>): ActionFunctionArgs {
  return {
    request: new Request("https://dashboard.example/memories", {
      method: "POST",
      body: new URLSearchParams({
        userId: "end-user-1",
        agentId: "agent-1",
        ...fields,
      }),
    }),
    params: {
      organizationSlug: "org",
      projectParam: "project",
      envParam: "env",
    },
    context: {},
  };
}

describe("Memory dashboard mutations", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    requireEnvironmentScope.mockResolvedValue({ scope: { environmentId: "env-1" } });
    agentRequest.mockResolvedValue({ ok: true });
  });

  it("submits exact private visibility and required profile metadata", async () => {
    const response = await action(args({
      intent: "memory-create",
      content: "Ada",
      kind: "profile",
      profileKey: "name",
      visibility: "private",
    }));

    expect(response.status).toBe(200);
    expect(agentRequest).toHaveBeenCalledWith(
      "/api/v1/memory",
      { environmentId: "env-1", agentId: "agent-1" },
      {
        method: "POST",
        body: {
          userId: "end-user-1",
          content: "Ada",
          kind: "profile",
          metadata: { profileKey: "name" },
          visibility: "private",
          source: "manual",
        },
      },
    );
  });

  it("submits relationship metadata through the complete editor", async () => {
    await action(args({
      intent: "memory-update",
      id: "memory-1",
      content: "Ada works at Platos",
      kind: "relationship",
      from: "person:ada",
      to: "company:platos",
      type: "works_at",
      visibility: "agent_visible",
    }));

    expect(agentRequest).toHaveBeenCalledWith(
      "/api/v1/memory/memory-1",
      { environmentId: "env-1", agentId: "agent-1" },
      expect.objectContaining({
        method: "POST",
        body: expect.objectContaining({
          kind: "relationship",
          metadata: { from: "person:ada", to: "company:platos", type: "works_at" },
          visibility: "agent_visible",
        }),
      }),
    );
  });

  it("uses explicit archive and restore lifecycle endpoints", async () => {
    await action(args({ intent: "memory-archive", id: "memory-1" }));
    await action(args({ intent: "memory-restore", id: "memory-1" }));

    expect(agentRequest).toHaveBeenNthCalledWith(
      1,
      "/api/v1/memory/memory-1/archive",
      expect.anything(),
      { method: "POST", body: { userId: "end-user-1" } },
    );
    expect(agentRequest).toHaveBeenNthCalledWith(
      2,
      "/api/v1/memory/memory-1/restore",
      expect.anything(),
      { method: "POST", body: { userId: "end-user-1" } },
    );
  });

  it("requires explicit confirmation before replace import reaches the API", async () => {
    const response = await action(args({
      intent: "memory-import",
      mode: "replace",
      bundle: '{"memories":[]}',
    }));

    expect(response.status).toBe(400);
    expect(agentRequest).not.toHaveBeenCalled();
  });
});
