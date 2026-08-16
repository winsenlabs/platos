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
  const oauth = { verifyAccessToken: vi.fn() };
  const toolExecutor = { execute: vi.fn() };
  const toolRouter = {
    resolve: vi.fn(),
    visibleEntitiesForAgent: vi.fn().mockReturnValue([]),
  };
  const prisma: any = {
    entity: { findFirst: vi.fn().mockResolvedValue(entityRow) },
    environment: {
      findFirst: vi.fn().mockResolvedValue({ id: "env_1" }),
    },
    mcpAnonymousSession: { findFirst: vi.fn() },
  };
  const redis = { incr: vi.fn().mockResolvedValue(1), expire: vi.fn() };
  const bearer = { validate: vi.fn() };
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

  it("falls back to anonymous only when no bearer was supplied", async () => {
    h.identity.resolve.mockResolvedValue({
      mcpUserId: "mcp:anon:user",
      identityMode: "anonymous",
      metadata: { sessionId: "session_1" },
    });
    h.prisma.mcpAnonymousSession.findFirst.mockResolvedValue({
      id: "session_1",
      environmentId: "env_1",
    });

    const result = await h.controller.authenticate("acme", undefined, {
      headers: {},
    });

    expect(result.token).toMatchObject({
      tokenHash: "anonymous:session_1",
      mcpUserId: "mcp:anon:user",
      identityMode: "anonymous",
      scopes: ["mcp:tools"],
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
});
