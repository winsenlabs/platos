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
    h.acl.getExposedPoliciesByName.mockResolvedValue([{
      id: "policy_1",
      entityPk: "entity_1",
      toolId: "tool_acme",
      toolName: "calendar.create",
      exposed: true,
      minIdentityMode: "bearer",
      allowedPatIds: [],
      scopeLabels: ["mcp:tools"],
      addedAt: new Date(),
      lastReviewedAt: null,
    }]);
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

  it("lists zero tools when the selected Environment has no ALLOW row", async () => {
    h.acl.getExposedPoliciesByName.mockResolvedValue([]);

    const response = await h.controller.handleToolsList(
      1,
      {
        entityPk: "entity_1",
        entityId: "acme",
        organizationId: "org_1",
        projectId: "project_1",
        displayName: "Acme",
        // A stale Entity-global projection must not expose this name.
        config: { ...entityRow.mcpConfig, toolAllowlist: ["calendar.create"] },
      },
      {
        clientId: "pat",
        mcpUserId: "mcp:pat:pat_1",
        entityPk: "entity_1",
        environmentId: "env_without_allow",
        identityMode: "bearer",
        scopes: ["mcp:tools"],
      },
    );

    expect(response).toEqual({ jsonrpc: "2.0", id: 1, result: { tools: [] } });
    expect(h.acl.getExposedPoliciesByName).toHaveBeenCalledWith(
      "entity_1",
      "env_without_allow",
    );
    expect(h.toolRouter.resolve).not.toHaveBeenCalled();
    expect(h.toolExecutor.execute).not.toHaveBeenCalled();
  });

  it("denies call before routing when ALLOW exists only in another Environment", async () => {
    h.acl.getExposedPoliciesByName.mockResolvedValue([]);

    const response = await h.controller.handleToolsCall(
      1,
      { name: "calendar.create", arguments: {} },
      {
        entityPk: "entity_1",
        entityId: "acme",
        organizationId: "org_1",
        projectId: "project_1",
        displayName: "Acme",
        // This projection may include an ALLOW row from env_other.
        config: { ...entityRow.mcpConfig, toolAllowlist: ["calendar.create"] },
      },
      {
        clientId: "pat",
        mcpUserId: "mcp:pat:pat_1",
        entityPk: "entity_1",
        environmentId: "env_selected",
        identityMode: "bearer",
        scopes: ["mcp:tools"],
      },
    );

    expect(response).toMatchObject({
      error: { message: "tool 'calendar.create' not exposed in this environment" },
    });
    expect(h.acl.getExposedPoliciesByName).toHaveBeenCalledWith(
      "entity_1",
      "env_selected",
      "calendar.create",
    );
    expect(h.acl.filterByIdentity).not.toHaveBeenCalled();
    expect(h.toolRouter.resolve).not.toHaveBeenCalled();
    expect(h.toolExecutor.execute).not.toHaveBeenCalled();
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

describe("McpEntityController operator management", () => {
  const operatorScope = {
    organizationId: "org_1",
    projectId: "project_1",
    environmentId: "env_1",
    userId: "operator_1",
    principal: "operator",
  } as const;
  const managedEntity = {
    entityPk: "entity_1",
    entityId: "acme",
    organizationId: "org_1",
    projectId: "project_1",
    displayName: "Acme",
    config: entityRow.mcpConfig,
  };

  function managementHarness() {
    const controller: any = Object.create(McpEntityController.prototype);
    controller.loadEntity = vi.fn().mockResolvedValue(managedEntity);
    controller.bearerTokenService = { list: vi.fn(), generate: vi.fn(), revoke: vi.fn() };
    controller.toolAclService = { list: vi.fn(), upsert: vi.fn(), bulk: vi.fn() };
    controller.toolRegistry = { rebuildIndex: vi.fn() };
    controller.prisma = {
      entityMcpConfig: {
        upsert: vi.fn(),
        findUnique: vi.fn(),
      },
      environmentEntityTool: { findFirst: vi.fn() },
    };
    return controller;
  }

  it("rejects end-user management before loading scoped state", async () => {
    const controller = managementHarness();
    await expect(controller.listBearerTokens({ scope: { ...operatorScope, principal: "end-user" } }, "acme"))
      .rejects.toMatchObject({ status: 403 });
    expect(controller.loadEntity).not.toHaveBeenCalled();
    expect(controller.bearerTokenService.list).not.toHaveBeenCalled();
  });

  it("lists ACL rows only from the selected Environment and returns truthful metadata", async () => {
    const controller = managementHarness();
    controller.toolAclService.list.mockResolvedValue({ tools: [], total: 7, limit: 2, offset: 4 });

    await expect(controller.listToolAcl({ scope: operatorScope }, "acme", undefined, undefined, "2", "4"))
      .resolves.toEqual({ tools: [], total: 7, limit: 2, offset: 4 });
    expect(controller.toolAclService.list).toHaveBeenCalledWith(
      "entity_1",
      "env_1",
      expect.objectContaining({ limit: 2, offset: 4 }),
    );
  });

  it("persists combined identity, provider arrays and injectMcpContext then reads them back", async () => {
    const controller = managementHarness();
    const persisted = {
      entityId: "entity_1",
      enabled: true,
      identityMode: "bearer+oidc",
      identityProviders: [{ type: "oidc" }],
      branding: {},
      toolAllowlist: [],
      redirectUriAllowlist: [],
      rateLimitPerMinute: 60,
      injectMcpContext: true,
    };
    controller.prisma.entityMcpConfig.findUnique.mockResolvedValue(persisted);

    await expect(controller.patchMcpConfig({ scope: operatorScope }, "acme", {
      enabled: true,
      identityMode: "bearer+oidc",
      identityProviders: [{ type: "oidc" }],
      injectMcpContext: true,
    })).resolves.toEqual({ entityId: "acme", entityPk: "entity_1", config: persisted });
    expect(controller.prisma.entityMcpConfig.upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        update: expect.objectContaining({
          identityMode: "bearer+oidc",
          identityProviders: [{ type: "oidc" }],
          injectMcpContext: true,
        }),
      }),
    );
    expect(controller.toolRegistry.rebuildIndex).toHaveBeenCalledOnce();
  });

  it("replays a complete MCP config without changing persisted state", async () => {
    const controller = managementHarness();
    let persisted: Record<string, unknown> | null = null;
    controller.prisma.entityMcpConfig.upsert.mockImplementation(async ({ create, update }: any) => {
      persisted = persisted ? { ...persisted, ...update } : { ...create };
      return persisted;
    });
    controller.prisma.entityMcpConfig.findUnique.mockImplementation(async () => ({ ...persisted }));
    const body = {
      enabled: true,
      identityMode: "bearer+oidc",
      identityProviders: [{ type: "oidc" }],
      branding: { name: "Acme" },
      toolAllowlist: ["calendar.create"],
      redirectUriAllowlist: ["https://app.example/callback"],
      rateLimitPerMinute: 120,
      injectMcpContext: true,
    };

    const first = await controller.patchMcpConfig({ scope: operatorScope }, "acme", body);
    const replay = await controller.patchMcpConfig({ scope: operatorScope }, "acme", body);

    expect(replay).toEqual(first);
    expect(persisted).toMatchObject(body);
    expect(controller.prisma.entityMcpConfig.upsert).toHaveBeenCalledTimes(2);
  });

  it("keeps concurrent complete MCP config writes atomic with an unspecified final winner", async () => {
    const controller = managementHarness();
    let persisted: Record<string, unknown> | null = null;
    controller.prisma.entityMcpConfig.upsert.mockImplementation(async ({ create, update }: any) => {
      if (update.identityMode === "bearer") {
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
      persisted = persisted ? { ...persisted, ...update } : { ...create };
      return persisted;
    });
    controller.prisma.entityMcpConfig.findUnique.mockImplementation(async () => ({ ...persisted }));
    const bearer = {
      enabled: true,
      identityMode: "bearer",
      identityProviders: [],
      branding: { winner: "bearer" },
      toolAllowlist: ["calendar.create"],
      redirectUriAllowlist: ["https://bearer.example/callback"],
      rateLimitPerMinute: 60,
      injectMcpContext: false,
    };
    const oidc = {
      enabled: false,
      identityMode: "oidc",
      identityProviders: [{ type: "oidc" }],
      branding: { winner: "oidc" },
      toolAllowlist: ["tickets.list"],
      redirectUriAllowlist: ["https://oidc.example/callback"],
      rateLimitPerMinute: 90,
      injectMcpContext: true,
    };

    await Promise.all([
      controller.patchMcpConfig({ scope: operatorScope }, "acme", bearer),
      controller.patchMcpConfig({ scope: operatorScope }, "acme", oidc),
    ]);

    const persistedConfig = Object.fromEntries(
      Object.keys(bearer).map((key) => [key, persisted?.[key]]),
    );
    expect([bearer, oidc]).toContainEqual(persistedConfig);
  });

  it("rejects object-root identityProviders", async () => {
    const controller = managementHarness();
    await expect(controller.patchMcpConfig({ scope: operatorScope }, "acme", {
      identityProviders: { type: "oidc" },
    })).rejects.toMatchObject({ status: 400 });
    expect(controller.prisma.entityMcpConfig.upsert).not.toHaveBeenCalled();
  });
});
