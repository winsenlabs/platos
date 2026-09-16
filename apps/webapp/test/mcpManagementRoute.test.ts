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
  env: {
    NODE_ENV: "test",
    PLATOS_AGENT_API_URL: "http://agent.internal:3100",
    // WIN-257 T8 — the two MINTS on these screens now dispatch to core-api while
    // the config, the ACL, the listings and the revocations stay on the agent.
    // Two upstreams in one suite is the per-route cutover (D11) made visible: the
    // assertions below name which host each operation went to.
    PLATOS_CORE_API_URL: "http://core.internal:3030",
    PLATOS_INTERNAL_AUTH_TOKEN: "internal",
  },
}));

/** A V1 mint, in the envelope `itemEnvelope` writes. */
function mintEnvelope(overrides: Record<string, unknown>): string {
  return JSON.stringify({
    data: {
      tokenId: "token-1",
      token: "plt_mcp_once",
      label: "CI",
      permissions: ["agents.list"],
      tier: "scope",
      expiresAt: "2026-12-01T00:00:00.000Z",
      createdAt: "2026-08-24T12:00:00.000Z",
      ...overrides,
    },
    meta: { contractVersion: "M0.1" },
  });
}

/** A V1 refusal, in the envelope `writeFailure` writes. */
function faultEnvelope(code: string, body: string): string {
  return JSON.stringify({ error: { code, title: "unavailable", body, errorId: "e", traceRef: "t", version: "1" } });
}

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
      .mockResolvedValueOnce(new Response(mintEnvelope({}), { status: 201 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ tokens: [{ id: "token-1", name: "CI" }], total: 1, limit: 25, offset: 0 }), { status: 200 }));
    const form = new FormData();
    form.set("intent", "create");
    form.set("name", "CI");
    form.set("permissions", "agents.list");
    form.set("tier", "scope");
    form.set("ttlSeconds", "3600");

    const actionResponse = await platformAction(routeArgs(new Request("https://dashboard.example/mcps", { method: "POST", body: form })));
    const actionPayload = await actionResponse.json();
    expect(actionPayload).toMatchObject({ ok: true, result: { tokenId: "token-1", plaintextSecret: "plt_mcp_once" } });
    expect(actionPayload.result).not.toHaveProperty("token");
    // THE MINT WENT TO CORE-API, WITH THE KEY ITS POLICY DEMANDS. `http/
    // idempotency-policy.ts` marks this operation `required`: a replayed form
    // submission must not leave a second live credential nobody holds.
    const [mintUrl, mintInit] = vi.mocked(fetch).mock.calls[0] ?? [];
    expect(String(mintUrl)).toBe("http://core.internal:3030/mcp/platform/tokens");
    expect((mintInit as RequestInit).method).toBe("POST");
    expect((mintInit as any).headers["Idempotency-Key"]).toMatch(/^[A-Za-z0-9_.:-]{1,255}$/u);
    expect(JSON.parse(String((mintInit as RequestInit).body))).toMatchObject({
      environmentId: "env-1",
      name: "CI",
      tier: "scope",
    });
    // AND CARRIED THE OPERATOR'S COOKIE, NOT THE AGENT'S SHARED SECRET.
    expect((mintInit as any).headers["X-Platos-Internal-Auth"]).toBeUndefined();

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
      .mockResolvedValueOnce(new Response(mintEnvelope({ tokenId: "pat-1", token: "plt_ent_once", tier: null }), { status: 201 }))
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
      result: { tokenId: "pat-1", label: "CI", plaintextSecret: "plt_ent_once" },
    });
    // THE FIELD CHANGED NAME ON THE WIRE AND NOT ON THE SCREEN. The agent handler
    // answered `{ raw }`; the V1 mint answers `{ token }` because that is what
    // both legacy handlers returned and what every existing client reads
    // (`token-mint.ts`). `plaintextSecret` is what this surface has always
    // rendered, so the rename stops at the seam.
    expect(actionPayload.result).not.toHaveProperty("raw");
    expect(actionPayload.result).not.toHaveProperty("token");
    const [mintUrl, mintInit] = vi.mocked(fetch).mock.calls[0] ?? [];
    expect(String(mintUrl)).toBe("http://core.internal:3030/mcp/entity/acme/tokens");
    expect((mintInit as any).headers["Idempotency-Key"]).toMatch(/^[A-Za-z0-9_.:-]{1,255}$/u);
    expect(JSON.parse(String((mintInit as RequestInit).body))).toMatchObject({
      environmentId: "env-1",
      label: "CI",
      ttlSeconds: 3600,
    });

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
  ] as const)("keeps %s mint failures stable and secret-safe", async (_label, action, entityId, fields) => {
    // THE REFUSAL IS CORE-API'S NOW, AND IT KEEPS ITS CODE AND ITS STATUS.
    // `m4Mutation.server.ts` names `CoreApiError` explicitly for this: the
    // fallback it would otherwise take renders `error.message`, which for a V1
    // failure is another deployable's prose written for an operator reading core's
    // logs.
    vi.mocked(fetch).mockResolvedValue(
      new Response(faultEnvelope("TENANCY_ENVIRONMENT_FORBIDDEN", "SENTINEL_MCP_UPSTREAM_SECRET"), { status: 503 }),
    );
    const form = new FormData();
    for (const [key, value] of Object.entries(fields)) form.set(key, value);

    const response = await action(routeArgs(new Request("https://dashboard.example/mcps", { method: "POST", body: form }), entityId));
    const serialized = JSON.stringify(await response.json());
    expect(response.status).toBe(503);
    expect(serialized).toContain("TENANCY_ENVIRONMENT_FORBIDDEN");
    expect(serialized).not.toContain("SENTINEL_MCP_UPSTREAM_SECRET");
    expect(serialized).not.toContain("internal");
  });

  it.each([
    ["Platform", platformAction, undefined, { intent: "create", name: "CI", permissions: "agents.list", tier: "scope", ttlSeconds: "3600" }, { tokenHash: "SENTINEL_TOKEN_HASH" }],
    ["Entity", entityAction, "acme", { intent: "token-create", label: "CI", scopes: "mcp:tools", expiresIn: "3600" }, { tokenId: "pat-1", token: "plt_ent_once", tokenHash: "SENTINEL_TOKEN_HASH" }],
  ] as const)("fails closed when the %s create response contains persisted secret material", async (_label, action, entityId, fields, payload) => {
    // A SECOND SECRET ON A MINT RESPONSE IS STILL REFUSED. `token` is split off
    // by name and everything left is swept by `assertCredentialSafePayload`; this
    // is what stops the published field list quietly growing a `tokenHash`.
    vi.mocked(fetch).mockResolvedValue(new Response(mintEnvelope(payload), { status: 201 }));
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
