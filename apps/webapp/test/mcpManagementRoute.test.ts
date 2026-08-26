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

  it("revokes a Platform token and reads the persisted revocation metadata back", async () => {
    const revokedAt = "2026-08-24T12:00:00.000Z";
    vi.mocked(fetch)
      .mockResolvedValueOnce(new Response(JSON.stringify({ id: "token-1", revokedAt }), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({
        tokens: [{ id: "token-1", name: "CI", revokedAt }],
        total: 1,
        limit: 25,
        offset: 0,
      }), { status: 200 }));
    const form = new FormData();
    form.set("intent", "revoke");
    form.set("tokenId", "token-1");

    const actionResponse = await platformAction(routeArgs(new Request("https://dashboard.example/mcps", { method: "POST", body: form })));
    expect(await actionResponse.json()).toMatchObject({ ok: true, result: { id: "token-1", revokedAt } });
    expect(fetch).toHaveBeenNthCalledWith(
      1,
      "http://agent.internal:3100/mcp/platform/tokens/token-1/revoke",
      expect.objectContaining({ method: "POST" }),
    );

    const loaderResponse = await platformLoader(routeArgs(new Request("https://dashboard.example/mcps?page=1&pageSize=25")));
    const loaderPayload = await loaderResponse.json();
    expect(loaderPayload.panel.data.tokens).toEqual([{ id: "token-1", name: "CI", revokedAt }]);
  });

  it("creates an Entity bearer once and reads back only persisted PAT metadata", async () => {
    vi.mocked(fetch)
      .mockResolvedValueOnce(new Response(JSON.stringify({ id: "pat-1", raw: "plt_ent_once", label: "CI", revokedAt: null }), { status: 201 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ entityId: "acme", config: { enabled: true } }), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({
        tokens: [{ id: "pat-1", label: "CI", revokedAt: null }],
        total: 1,
        limit: 25,
        offset: 0,
      }), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ tools: [], total: 0, limit: 200, offset: 0 }), { status: 200 }));
    const form = new FormData();
    form.set("intent", "token-create");
    form.set("label", "CI");
    form.set("scopes", "mcp:tools");
    form.set("expiresIn", "3600");

    const actionResponse = await entityAction(routeArgs(new Request("https://dashboard.example/mcps/acme", { method: "POST", body: form }), "acme"));
    const actionPayload = await actionResponse.json();
    expect(actionPayload).toMatchObject({
      ok: true,
      result: { id: "pat-1", label: "CI", plaintextSecret: "plt_ent_once" },
    });
    expect(actionPayload.result).not.toHaveProperty("raw");

    const loaderResponse = await entityLoader(routeArgs(new Request("https://dashboard.example/mcps/acme?page=1&pageSize=25"), "acme"));
    const loaderSerialized = JSON.stringify(await loaderResponse.json());
    expect(loaderSerialized).not.toContain("plt_ent_once");
    expect(JSON.parse(loaderSerialized).secondary.data.tokens).toEqual([{ id: "pat-1", label: "CI", revokedAt: null }]);
  });

  it("revokes an Entity bearer and reads revokedAt back from the safe PAT inventory", async () => {
    const revokedAt = "2026-08-24T12:00:00.000Z";
    vi.mocked(fetch)
      .mockResolvedValueOnce(new Response(JSON.stringify({ id: "pat-1", revokedAt }), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ entityId: "acme", config: { enabled: true } }), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({
        tokens: [{ id: "pat-1", label: "CI", revokedAt }],
        total: 1,
        limit: 25,
        offset: 0,
      }), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ tools: [], total: 0, limit: 200, offset: 0 }), { status: 200 }));
    const form = new FormData();
    form.set("intent", "token-revoke");
    form.set("tokenId", "pat-1");

    const actionResponse = await entityAction(routeArgs(new Request("https://dashboard.example/mcps/acme", { method: "POST", body: form }), "acme"));
    expect(await actionResponse.json()).toMatchObject({ ok: true, result: { id: "pat-1", revokedAt } });
    expect(fetch).toHaveBeenNthCalledWith(
      1,
      "http://agent.internal:3100/mcp/entity/acme/tokens/pat-1",
      expect.objectContaining({ method: "DELETE" }),
    );

    const loaderResponse = await entityLoader(routeArgs(new Request("https://dashboard.example/mcps/acme?page=1&pageSize=25"), "acme"));
    const loaderPayload = await loaderResponse.json();
    expect(loaderPayload.secondary.data.tokens).toEqual([{ id: "pat-1", label: "CI", revokedAt }]);
  });

  it.each([
    ["Platform", platformAction, undefined, { intent: "create", name: "CI", permissions: "agents.list", tier: "scope", ttlSeconds: "3600" }],
    ["Entity", entityAction, "acme", { intent: "token-create", label: "CI", scopes: "mcp:tools", expiresIn: "3600" }],
  ] as const)("keeps %s Agent failures stable and secret-safe", async (_label, action, entityId, fields) => {
    vi.mocked(fetch).mockResolvedValue(new Response(JSON.stringify({
      code: "AGENT_UNAVAILABLE",
      message: "The Agent service is unavailable",
      details: { credential: "SENTINEL_MCP_UPSTREAM_SECRET" },
    }), { status: 503 }));
    const form = new FormData();
    for (const [key, value] of Object.entries(fields)) form.set(key, value);

    const response = await action(routeArgs(new Request("https://dashboard.example/mcps", { method: "POST", body: form }), entityId));
    const serialized = JSON.stringify(await response.json());
    expect(response.status).toBe(503);
    expect(serialized).toContain("AGENT_UNAVAILABLE");
    expect(serialized).not.toContain("SENTINEL_MCP_UPSTREAM_SECRET");
    expect(serialized).not.toContain("internal");
  });

  it.each([
    ["Platform", platformAction, undefined, { intent: "create", name: "CI", permissions: "agents.list", tier: "scope", ttlSeconds: "3600" }, { id: "token-1", token: "plt_mcp_once", tokenHash: "SENTINEL_TOKEN_HASH" }],
    ["Entity", entityAction, "acme", { intent: "token-create", label: "CI", scopes: "mcp:tools", expiresIn: "3600" }, { id: "pat-1", raw: "plt_ent_once", tokenHash: "SENTINEL_TOKEN_HASH" }],
  ] as const)("fails closed when the %s create response contains persisted secret material", async (_label, action, entityId, fields, payload) => {
    vi.mocked(fetch).mockResolvedValue(new Response(JSON.stringify(payload), { status: 201 }));
    const form = new FormData();
    for (const [key, value] of Object.entries(fields)) form.set(key, value);

    const response = await action(routeArgs(new Request("https://dashboard.example/mcps", { method: "POST", body: form }), entityId));
    const serialized = JSON.stringify(await response.json());
    expect(response.status).toBe(400);
    expect(serialized).toContain("UNSAFE_CREDENTIAL_RESPONSE");
    expect(serialized).not.toContain("SENTINEL_TOKEN_HASH");
    expect(serialized).not.toContain("plt_mcp_once");
    expect(serialized).not.toContain("plt_ent_once");
  });
});
