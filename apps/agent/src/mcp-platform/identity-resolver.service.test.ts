import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Request } from "express";
import { McpIdentityResolverService } from "./identity-resolver.service";

function request(
  headers: Record<string, string> = {},
  query: Record<string, string> = {},
): Request {
  return {
    headers,
    query,
    socket: { remoteAddress: "127.0.0.1" },
  } as unknown as Request;
}

// WIN-268 P2 — the double is an `McpIdentityReader`, the interface the resolver
// actually names, not a fake `PrismaClient`. The one clause-shape assertion this
// suite made (that the environment lookup joins through
// `project.entities.some`) has moved to `mcp-identity.integration.test.ts`,
// where a second tenant's environment can be shown to actually be excluded
// rather than a `where` object shown to be spelled a certain way.
function createStore() {
  return {
    readMcpSurface: vi.fn(),
    findActiveEnvironmentForEntity: vi.fn().mockResolvedValue(null),
    findLiveAnonymousSession: vi.fn().mockResolvedValue(null),
    touchAnonymousSession: vi.fn().mockResolvedValue(undefined),
    createAnonymousSession: vi.fn(),
  } satisfies Record<string, unknown> as any;
}

describe("McpIdentityResolverService authentication order", () => {
  let store: ReturnType<typeof createStore>;
  let bearer: { validate: ReturnType<typeof vi.fn> };
  let service: McpIdentityResolverService;

  beforeEach(() => {
    store = createStore();
    bearer = { validate: vi.fn() };
    service = new McpIdentityResolverService(store, bearer as any);
    store.readMcpSurface.mockResolvedValue({
      enabled: true,
      identityMode: "bearer+oidc+anonymous",
    });
  });

  it("validates a plt_ent_ PAT before considering OAuth or anonymous identity", async () => {
    bearer.validate.mockResolvedValue({
      id: "token_1",
      entityPk: "entity_1",
      environmentId: "env_1",
      mcpUserId: "mcp:pat:token_1",
      scopes: ["mcp:tools"],
    });

    await expect(
      service.resolve(
        request({ authorization: "Bearer plt_ent_secret" }),
        "entity_1",
      ),
    ).resolves.toEqual({
      mcpUserId: "mcp:pat:token_1",
      environmentId: "env_1",
      identityMode: "bearer",
      metadata: {
        tokenId: "token_1",
        scopes: ["mcp:tools"],
        environmentId: "env_1",
      },
    });
    expect(store.createAnonymousSession).not.toHaveBeenCalled();
  });

  it("uses an upstream verified OAuth identity before anonymous fallback", async () => {
    const req = request();
    (req as any).mcpIdentity = {
      mcpUserId: "mcp:oidc:user",
      environmentId: "env_1",
      identityMode: "oidc",
      metadata: { clientId: "client_1" },
    };

    await expect(service.resolve(req, "entity_1")).resolves.toEqual(
      (req as any).mcpIdentity,
    );
    expect(store.createAnonymousSession).not.toHaveBeenCalled();
  });

  it("creates an environment-owned anonymous session only when enabled", async () => {
    store.findActiveEnvironmentForEntity.mockResolvedValue("env_1");
    store.createAnonymousSession.mockResolvedValue({
      id: "session_1",
      mcpUserId: "mcp:anon:generated",
    });

    const result = await service.resolve(request({}, { environmentId: "env_1" }), "entity_1");

    expect(result).toMatchObject({
      identityMode: "anonymous",
      environmentId: "env_1",
      metadata: { sessionId: "session_1", environmentId: "env_1" },
    });
    expect(store.createAnonymousSession).toHaveBeenCalledWith(
      "entity_1",
      "env_1",
      expect.objectContaining({ firstSeenIp: "127.0.0.1" }),
    );
  });

  it("requires an explicit environment when anonymous scope is ambiguous", async () => {
    await expect(service.resolve(request(), "entity_1")).resolves.toEqual({
      error: "environmentId is required for anonymous MCP authentication",
      status: 400,
    });
    expect(store.createAnonymousSession).not.toHaveBeenCalled();
  });

  it("accepts a canonical anonymous environment selector and verifies ancestry", async () => {
    store.findActiveEnvironmentForEntity.mockResolvedValue("env_2");
    store.createAnonymousSession.mockResolvedValue({
      id: "session_2",
      mcpUserId: "mcp:anon:user",
    });

    const req = request();
    (req as any).query = { environmentId: "env_2" };
    const result = await service.resolve(req, "entity_1");
    expect(result).toMatchObject({ environmentId: "env_2" });
    // The ENTITY is carried into the lookup, which is what makes the ancestry
    // check possible at all. That it actually excludes a foreign environment is
    // proved against real PostgreSQL in `mcp-identity.integration.test.ts`.
    expect(store.findActiveEnvironmentForEntity).toHaveBeenCalledWith("entity_1", "env_2");
  });

  it("rejects anonymous and bearer credentials when their modes are disabled", async () => {
    store.readMcpSurface.mockResolvedValue({ enabled: true, identityMode: "oidc" });

    await expect(service.resolve(request(), "entity_1")).resolves.toEqual({
      error: "This entity requires authentication",
      status: 401,
    });
    await expect(
      service.resolve(
        request({ authorization: "Bearer plt_ent_secret" }),
        "entity_1",
      ),
    ).resolves.toEqual({
      error: "Bearer tokens not enabled for this entity",
      status: 403,
    });
    expect(bearer.validate).not.toHaveBeenCalled();
  });
});
