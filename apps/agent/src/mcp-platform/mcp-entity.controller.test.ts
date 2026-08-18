import { beforeEach, describe, expect, it, vi } from "vitest";
import { McpEntityController } from "./mcp-entity.controller";

const entityRow = {
  id: "entity_1",
  externalId: "acme",
  projectId: "project_1",
  displayName: "Acme",
  project: { organizationId: "org_1" },
  mcpConfig: {
    enabled: true,
    identityMode: "bearer+oidc+anonymous",
    toolAllowlist: ["calendar.create"],
    rateLimitPerMinute: 60,
  },
};

function createHarness() {
  const oauth = {
    verifyAccessToken: vi.fn(),
    verifyAccessTokenHash: vi.fn(),
  };
  const toolExecutor = { execute: vi.fn() };
  const toolRouter = {
    resolve: vi.fn(),
    visibleEntitiesForAgent: vi.fn().mockReturnValue([]),
  };
  const prisma: any = {
    entity: {
      findFirst: vi.fn().mockResolvedValue(entityRow),
      findUnique: vi.fn().mockResolvedValue(entityRow),
    },
    environment: {
      findFirst: vi.fn().mockResolvedValue({ id: "env_1" }),
    },
    mcpAnonymousSession: { findFirst: vi.fn() },
  };
  const redis = {
    incr: vi.fn().mockResolvedValue(1),
    expire: vi.fn(),
    get: vi.fn(),
    publish: vi.fn(),
  };
  const bearer = { validate: vi.fn(), validateHash: vi.fn() };
  const identity = { resolve: vi.fn() };
  const acl = {
    getExposedPoliciesByName: vi.fn(),
    filterByIdentity: vi.fn(),
  };
  const registry = {};
  const controller = new McpEntityController(
    oauth as any,
    toolExecutor as any,
    toolRouter as any,
    prisma,
    redis as any,
    bearer as any,
    identity as any,
    acl as any,
    registry as any,
  );
  return {
    controller: controller as any,
    oauth,
    toolExecutor,
    toolRouter,
    prisma,
    redis,
    bearer,
    identity,
    acl,
  };
}

describe("McpEntityController full transport authentication", () => {
  let h: ReturnType<typeof createHarness>;

  beforeEach(() => {
    h = createHarness();
  });

  it("authenticates PAT before OAuth and binds it to the entity's environment", async () => {
    h.bearer.validate.mockResolvedValue({
      id: "pat_1",
      entityPk: "entity_1",
      environmentId: "env_1",
      mcpUserId: "mcp:pat:pat_1",
      scopes: ["mcp:tools"],
    });

    const result = await h.controller.authenticate("acme", "plt_ent_secret");

    expect(result.token).toMatchObject({
      clientId: "pat",
      entityPk: "entity_1",
      environmentId: "env_1",
      identityMode: "bearer",
    });
    expect(h.oauth.verifyAccessToken).not.toHaveBeenCalled();
  });

  it("rejects an OAuth token whose canonical project differs from the entity", async () => {
    h.oauth.verifyAccessToken.mockResolvedValue({
      tokenHash: "hash",
      clientId: "client_1",
      userId: "operator_1",
      mcpUserId: "mcp:oidc:user",
      identityMode: "oidc",
      scope: {
        organizationId: "org_1",
        projectId: "project_2",
        environmentId: "env_2",
      },
      scopes: ["mcp:tools"],
      expiresAt: new Date(Date.now() + 60_000),
      entityPk: "entity_1",
    });

    await expect(
      h.controller.authenticate("acme", "plt_oa_secret"),
    ).resolves.toEqual({
      error: "token project does not match entity",
      status: 403,
    });
  });

  it("accepts OAuth only in its authorized canonical environment", async () => {
    h.oauth.verifyAccessToken.mockResolvedValue({
      tokenHash: "hash",
      clientId: "client_1",
      userId: "operator_1",
      mcpUserId: "mcp:oidc:user",
      identityMode: "oidc",
      scope: {
        organizationId: "org_1",
        projectId: "project_1",
        environmentId: "env_1",
      },
      scopes: ["mcp:tools"],
      expiresAt: new Date(Date.now() + 60_000),
      entityPk: "entity_1",
    });

    await expect(
      h.controller.authenticate("acme", "plt_oa_secret"),
    ).resolves.toMatchObject({
      token: {
        entityPk: "entity_1",
        environmentId: "env_1",
        identityMode: "oidc",
      },
    });
  });

  it("falls back to anonymous only when no bearer was supplied", async () => {
    h.identity.resolve.mockResolvedValue({
      mcpUserId: "mcp:anon:user",
      environmentId: "env_1",
      identityMode: "anonymous",
      metadata: { sessionId: "session_1", environmentId: "env_1" },
    });
    h.prisma.mcpAnonymousSession.findFirst.mockResolvedValue({
      id: "session_1",
      environmentId: "env_1",
    });

    h.prisma.environment.findFirst.mockResolvedValue({
      id: "env_1",
      project: { entities: [{ id: "entity_1" }] },
    });
    const result = await h.controller.authenticate("acme", undefined, {
      headers: {},
      query: { environmentId: "env_1" },
    });

    expect(result.token).toMatchObject({
      tokenHash: "anonymous:session_1",
      mcpUserId: "mcp:anon:user",
      identityMode: "anonymous",
      scopes: ["mcp:tools"],
    });
  });

  it("never falls through an unrecognized bearer to anonymous", async () => {
    h.oauth.verifyAccessToken.mockResolvedValue(null);

    await expect(
      h.controller.authenticate("acme", "not-a-supported-token", { headers: {} }),
    ).resolves.toEqual({ error: "invalid or expired token", status: 401 });
    expect(h.identity.resolve).not.toHaveBeenCalled();
  });

  it("rejects anonymous identity when the entity disables it", async () => {
    h.prisma.entity.findUnique.mockResolvedValue({
      ...entityRow,
      mcpConfig: { ...entityRow.mcpConfig, identityMode: "bearer+oidc" },
    });
    h.prisma.environment.findFirst.mockResolvedValue({
      id: "env_1",
      project: { entities: [{ id: "entity_1" }] },
    });
    h.identity.resolve.mockResolvedValue({
      error: "This entity requires authentication",
      status: 401,
    });

    await expect(
      h.controller.authenticate("acme", undefined, {
        headers: {},
        query: { environmentId: "env_1" },
      }),
    ).resolves.toEqual({
      error: "This entity requires authentication",
      status: 401,
    });
  });

  it("denies a tool before dispatch when policy scopes do not admit the caller", async () => {
    const policy = {
      id: "policy_1",
      entityPk: "entity_1",
      toolId: "tool_1",
      toolName: "calendar.create",
      exposed: true,
      minIdentityMode: "oidc",
      allowedPatIds: [],
      scopeLabels: ["calendar:write"],
      addedAt: new Date(),
      lastReviewedAt: null,
    };
    h.acl.getExposedPoliciesByName.mockResolvedValue([policy]);
    h.acl.filterByIdentity.mockReturnValue([]);

    const response = await h.controller.handleToolsCall(
      1,
      { name: "calendar.create", arguments: {} },
      {
        entityPk: "entity_1",
        entityId: "acme",
        organizationId: "org_1",
        projectId: "project_1",
        displayName: "Acme",
        config: entityRow.mcpConfig,
      },
      {
        clientId: "pat",
        mcpUserId: "mcp:pat:pat_1",
        entityPk: "entity_1",
        environmentId: "env_1",
        identityMode: "bearer",
        scopes: ["mcp:tools"],
      },
    );

    expect(response).toMatchObject({
      error: { message: "tool 'calendar.create' not permitted for this identity" },
    });
    expect(h.toolRouter.resolve).not.toHaveBeenCalled();
    expect(h.toolExecutor.execute).not.toHaveBeenCalled();
  });

  it("carries the entity-pinned route to the executor for same-name isolation", async () => {
    h.acl.getExposedPoliciesByName.mockResolvedValue([]);
    h.acl.filterByIdentity.mockImplementation((rows: unknown[]) => rows);
    h.toolRouter.resolve.mockReturnValue({
      ok: true,
      entityPk: "entity_1",
      entityId: "acme",
      toolId: "tool_acme",
      toolName: "calendar.create",
      callbackUrl: "https://acme.example/tools",
      paramSchema: { type: "object" },
      category: "calendar",
      matched: 1,
    });
    h.toolExecutor.execute.mockResolvedValue({
      tool: "calendar.create",
      status: "success",
      result: "ok",
      latencyMs: 1,
    });

    await h.controller.handleToolsCall(
      1,
      { name: "calendar.create", arguments: {} },
      {
        entityPk: "entity_1",
        entityId: "acme",
        organizationId: "org_1",
        projectId: "project_1",
        displayName: "Acme",
        config: entityRow.mcpConfig,
      },
      {
        clientId: "pat",
        mcpUserId: "mcp:pat:pat_1",
        entityPk: "entity_1",
        environmentId: "env_1",
        identityMode: "bearer",
        scopes: ["mcp:tools"],
      },
    );

    expect(h.toolExecutor.execute).toHaveBeenCalledWith(
      expect.objectContaining({ tool: "calendar.create" }),
      expect.objectContaining({ environmentId: "env_1" }),
      expect.objectContaining({ source: "mcp_client" }),
      {
        entityPk: "entity_1",
        entityId: "acme",
        toolId: "tool_acme",
      },
    );
  });

  it("revalidates the exact PAT environment on SSE messages", async () => {
    const tokenHash = "a".repeat(64);
    h.redis.get.mockResolvedValue(JSON.stringify({
      entityIdSlug: "acme",
      tokenHash,
      token: {
        tokenHash,
        clientId: "pat",
        mcpUserId: "mcp:pat:pat_1",
        entityPk: "entity_1",
        environmentId: "env_1",
        identityMode: "bearer",
        scopes: ["mcp:tools"],
      },
    }));
    h.oauth.verifyAccessTokenHash.mockResolvedValue(null);
    h.bearer.validateHash.mockResolvedValue({
      id: "pat_1",
      entityPk: "entity_1",
      environmentId: "env_1",
      mcpUserId: "mcp:pat:pat_1",
      scopes: ["mcp:tools"],
    });
    const res = {
      status: vi.fn().mockReturnThis(),
      send: vi.fn().mockReturnThis(),
    };

    await h.controller.messages(
      "acme",
      "session_1",
      { jsonrpc: "2.0", id: 1, method: "ping" },
      res,
    );

    expect(h.bearer.validateHash).toHaveBeenCalledWith(tokenHash);
    expect(res.status).toHaveBeenCalledWith(202);
    expect(h.redis.publish).toHaveBeenCalledWith(
      "platos:mcp:entity:sse:session_1",
      JSON.stringify({ jsonrpc: "2.0", id: 1, result: {} }),
    );
  });

  it("denies an SSE message when its PAT was revoked after connection", async () => {
    const tokenHash = "b".repeat(64);
    h.redis.get.mockResolvedValue(JSON.stringify({
      entityIdSlug: "acme",
      tokenHash,
      token: {
        tokenHash,
        clientId: "pat",
        mcpUserId: "mcp:pat:pat_1",
        entityPk: "entity_1",
        environmentId: "env_1",
        identityMode: "bearer",
        scopes: ["mcp:tools"],
      },
    }));
    h.oauth.verifyAccessTokenHash.mockResolvedValue(null);
    h.bearer.validateHash.mockResolvedValue(null);
    const res = {
      status: vi.fn().mockReturnThis(),
      send: vi.fn().mockReturnThis(),
    };

    await h.controller.messages(
      "acme",
      "session_1",
      { jsonrpc: "2.0", id: 1, method: "ping" },
      res,
    );

    expect(res.status).toHaveBeenCalledWith(401);
    expect(h.redis.publish).not.toHaveBeenCalled();
  });
});
