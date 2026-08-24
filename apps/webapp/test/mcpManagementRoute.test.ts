import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const scope = {
  organizationId: "org-1",
  projectId: "project-1",
  environmentId: "env-1",
  userId: "operator-1",
};

const { requireEnvironmentScope } = vi.hoisted(() => ({
  requireEnvironmentScope: vi.fn(),
}));

vi.mock("../app/services/auth.server", () => ({ requireEnvironmentScope }));
vi.mock("~/env.server", () => ({
  env: { PLATOS_AGENT_API_URL: "http://agent.internal:3100", PLATOS_INTERNAL_AUTH_TOKEN: "internal" },
}));

import {
  action as entityAction,
  loader as entityLoader,
} from "../app/routes/_app.orgs.$organizationSlug.projects.$projectParam.env.$envParam.mcps.$entityId._index/route";
import {
  action as platformAction,
  loader as platformLoader,
} from "../app/routes/_app.orgs.$organizationSlug.projects.$projectParam.env.$envParam.mcps._index/route";

function routeArgs(request: Request, entityId?: string): any {
  return {
    request,
    params: {
      organizationSlug: "org",
      projectParam: "project",
      envParam: "env",
      ...(entityId ? { entityId } : {}),
    },
    context: {},
  };
}

beforeEach(() => {
  vi.stubGlobal("fetch", vi.fn());
  requireEnvironmentScope.mockResolvedValue({ scope });
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.clearAllMocks();
});

describe("MCP management route read-back", () => {
  it("persists the complete Entity config and reloads canonical config, token, and ACL state", async () => {
    const persisted = {
      entityId: "entity-pk",
      identityMode: "bearer+oidc",
      identityProviders: [{ type: "oidc" }],
      injectMcpContext: true,
      enabled: true,
    };
    vi.mocked(fetch)
      .mockResolvedValueOnce(new Response(JSON.stringify({ entityId: "acme", config: persisted }), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ entityId: "acme", config: persisted }), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ tokens: [{ id: "pat-1", label: "CI" }], total: 1, limit: 25, offset: 0 }), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ tools: [{ toolId: "mapping-1", toolName: "tickets.list" }], total: 1, limit: 200, offset: 0 }), { status: 200 }));

    const form = new FormData();
    form.set("intent", "config");
    form.set("enabled", "on");
    form.set("identityMode", "bearer+oidc");
    form.set("identityProviders", JSON.stringify([{ type: "oidc" }]));
    form.set("branding", "{}");
    form.set("rateLimitPerMinute", "60");
    form.set("injectMcpContext", "on");
    const actionResponse = await entityAction(routeArgs(new Request("https://dashboard.example/mcp", { method: "POST", body: form }), "acme"));
    expect(await actionResponse.json()).toMatchObject({ ok: true, result: { config: persisted } });
    expect(fetch).toHaveBeenNthCalledWith(
      1,
      "http://agent.internal:3100/mcp/entity/acme/config",
      expect.objectContaining({
        method: "PATCH",
        body: expect.stringContaining('"injectMcpContext":true'),
      }),
    );

    const loaderResponse = await entityLoader(routeArgs(new Request("https://dashboard.example/mcp?page=1&pageSize=25"), "acme"));
    const payload = await loaderResponse.json();
    expect(payload.panel.data.config).toEqual(persisted);
    expect(payload.secondary.data).toMatchObject({ total: 1, tokens: [{ id: "pat-1" }] });
    expect(payload.supporting.data).toMatchObject({ total: 1, tools: [{ toolId: "mapping-1" }] });
  });

  it("reveals a Platform token only in create action state and reloads metadata-only inventory", async () => {
    vi.mocked(fetch)
      .mockResolvedValueOnce(new Response(JSON.stringify({ id: "token-1", token: "plt_mcp_once", name: "CI" }), { status: 201 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ tokens: [{ id: "token-1", name: "CI" }], total: 1, limit: 25, offset: 0 }), { status: 200 }));
    const form = new FormData();
    form.set("intent", "create");
    form.set("name", "CI");
    form.set("permissions", "agents.list");
    form.set("tier", "scope");
    form.set("ttlSeconds", "3600");

    const actionResponse = await platformAction(routeArgs(new Request("https://dashboard.example/mcps", { method: "POST", body: form })));
    const actionPayload = await actionResponse.json();
    expect(actionPayload).toMatchObject({ ok: true, result: { id: "token-1", plaintextSecret: "plt_mcp_once" } });
    expect(actionPayload.result).not.toHaveProperty("token");

    const loaderResponse = await platformLoader(routeArgs(new Request("https://dashboard.example/mcps?page=1&pageSize=25")));
    const loaderPayload = await loaderResponse.json();
    expect(JSON.stringify(loaderPayload)).not.toContain("plt_mcp_once");
    expect(loaderPayload.panel.data).toMatchObject({ total: 1, tokens: [{ id: "token-1", name: "CI" }] });
  });
});
