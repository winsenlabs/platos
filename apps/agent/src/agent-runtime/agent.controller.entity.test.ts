import { describe, expect, it, vi } from "vitest";
import { AgentController } from "./agent.controller";

const scope = {
  organizationId: "org_1",
  projectId: "proj_1",
  environmentId: "env_1",
  userId: "user_1",
  principal: "operator" as const,
};

function harness() {
  const prisma: any = {
    entityMcpConfig: {
      findUnique: vi.fn(),
      upsert: vi.fn(),
    },
    mcpBearerToken: { count: vi.fn().mockResolvedValue(0) },
  };
  const authService = {
    getEntity: vi.fn().mockResolvedValue({ id: "entity_pk", entityId: "support-core" }),
    listEntitiesPage: vi.fn(),
    registerEntity: vi.fn(),
  };
  const controller: any = Object.create(AgentController.prototype);
  controller.authService = authService;
  controller.agentService = { prisma };
  controller.entityMcpDiscovery = undefined;
  controller.toolSync = {
    isEntityConnected: vi.fn().mockReturnValue(false),
    getConnectedEntitiesInEnv: vi.fn().mockReturnValue([]),
    getConnectedSources: vi.fn().mockReturnValue([]),
  };
  return { controller, prisma, authService, req: { scope } as any };
}

describe("AgentController clean Entity transport routes", () => {
  it("passes canonical Environment scope into clean Entity registration", async () => {
    const h = harness();
    h.authService.registerEntity.mockResolvedValue({
      id: "entity_pk",
      entityId: "support-core",
      plaintextSecret: "shown-once",
    });

    const result = await h.controller.registerEntity(h.req, {
      entityId: "support-core",
      displayName: "Support Core",
      mcpUrls: ["https://entity.example/mcp"],
      serviceSecret: "auto",
    });

    expect(h.authService.registerEntity).toHaveBeenCalledWith(
      expect.objectContaining({
        organizationId: scope.organizationId,
        projectId: scope.projectId,
        environmentId: scope.environmentId,
        entityId: "support-core",
      }),
      scope
    );
    expect(result.plaintextSecret).toBe("shown-once");
  });

  it("filters MCP navigation data without exposing Entity secrets", async () => {
    const h = harness();
    h.authService.listEntitiesPage.mockResolvedValue({
      entities: [
        { id: "mcp-1", entityId: "mcp-source", connectionKind: "mcp", serviceSecret: "sentinel" },
      ],
      total: 1,
    });

    const result = await h.controller.listEntities(h.req, "mcp");

    expect(result.entities).toEqual([
      expect.objectContaining({ id: "mcp-1", entityId: "mcp-source", connectionKind: "mcp" }),
    ]);
    expect(JSON.stringify(result)).not.toContain("sentinel");
    expect(h.authService.listEntitiesPage).toHaveBeenCalledWith(
      scope.organizationId,
      scope.projectId,
      expect.objectContaining({ connectionKind: "mcp", limit: 25, offset: 0 }),
    );
  });

  it("returns clean MCP config defaults and counts active bearer rows", async () => {
    const h = harness();
    h.prisma.entityMcpConfig.findUnique.mockResolvedValue(null);
    h.prisma.mcpBearerToken.count.mockResolvedValue(3);

    const result = await h.controller.getEntityMcpConfig(h.req, "support-core");

    expect(h.prisma.entityMcpConfig.findUnique).toHaveBeenCalledWith({
      where: { entityId: "entity_pk" },
    });
    expect(h.prisma.mcpBearerToken.count).toHaveBeenCalledWith({
      where: { entityId: "entity_pk", revokedAt: null },
    });
    expect(result).toMatchObject({
      entityPk: "entity_pk",
      entityId: "support-core",
      enabled: false,
      identityMode: "bearer",
      identityProviders: [],
      branding: {},
      bearerTokenCount: 3,
      consentCopy: null,
      exists: false,
    });
  });

  it("accepts a canonical Entity UUID and returns the external identifier", async () => {
    const h = harness();
    const canonicalId = "11111111-1111-4111-8111-111111111111";
    h.authService.getEntity.mockResolvedValue({ id: canonicalId, entityId: "support-core" });
    h.prisma.entityMcpConfig.findUnique.mockResolvedValue(null);

    const detail = await h.controller.getEntity(h.req, canonicalId);
    const mcp = await h.controller.getEntityMcpConfig(h.req, canonicalId);

    expect(h.authService.getEntity).toHaveBeenCalledWith("org_1", "proj_1", canonicalId);
    expect(detail).toMatchObject({ id: canonicalId, entityId: "support-core" });
    expect(mcp).toMatchObject({ entityPk: canonicalId, entityId: "support-core" });
  });

  it("throws true HTTP 404 errors for absent Entity detail and MCP config", async () => {
    const h = harness();
    h.authService.getEntity.mockResolvedValue(null);

    await expect(h.controller.getEntity(h.req, "missing")).rejects.toMatchObject({ status: 404 });
    await expect(h.controller.getEntityMcpConfig(h.req, "missing")).rejects.toMatchObject({ status: 404 });
  });

  it("upserts EntityMcpConfig without retired denormalized fields", async () => {
    const h = harness();
    h.prisma.entityMcpConfig.findUnique.mockResolvedValue({
      entityId: "entity_pk",
      enabled: true,
      identityMode: "oidc",
      identityProviders: [{ type: "oidc" }],
      branding: { name: "Support" },
      toolAllowlist: ["tickets.list"],
      redirectUriAllowlist: ["https://client.example/callback"],
      rateLimitPerMinute: 120,
    });
    h.prisma.mcpBearerToken.count.mockResolvedValue(2);

    const result = await h.controller.patchEntityMcpConfig(h.req, "support-core", {
      enabled: true,
      identityMode: "oidc",
      identityProviders: { type: "oidc" },
      branding: { name: "Support" },
      toolAllowlist: ["tickets.list"],
      consentCopy: "retired field",
      redirectUriAllowlist: ["https://client.example/callback"],
      rateLimitPerMinute: 120,
    });

    const upsert = h.prisma.entityMcpConfig.upsert.mock.calls[0][0];
    expect(upsert.where).toEqual({ entityId: "entity_pk" });
    expect(upsert.create).toMatchObject({
      entityId: "entity_pk",
      enabled: true,
      identityMode: "oidc",
      branding: { name: "Support" },
    });
    expect(upsert.create).not.toHaveProperty("entityPk");
    expect(upsert.create).not.toHaveProperty("bearerTokenCount");
    expect(upsert.create).not.toHaveProperty("consentCopy");
    expect(upsert.update).not.toHaveProperty("consentCopy");
    expect(result).toMatchObject({
      entityPk: "entity_pk",
      bearerTokenCount: 2,
      consentCopy: null,
      exists: true,
    });
  });

  it("rejects legacy linked-agent and test-credential mutations", async () => {
    const h = harness();

    await expect(
      h.controller.patchEntity(h.req, "support-core", { linkedAgentIds: ["agent-1"] })
    ).rejects.toMatchObject({ status: 501 });
    await expect(
      h.controller.patchEntity(h.req, "support-core", {
        testCredentials: { headers: [{ name: "Authorization", value: "sentinel" }] },
      })
    ).rejects.toMatchObject({ status: 501 });
  });

  it("returns a stable unsupported response for legacy test-credential reads", async () => {
    const h = harness();
    const json = vi.fn();
    const status = vi.fn(() => ({ json }));

    await h.controller.getEntityTestCredentials(h.req, "support-core", { status } as any);

    expect(status).toHaveBeenCalledWith(501);
    expect(json).toHaveBeenCalledWith({
      error: "unsupported",
      message: "Entity test credentials are not supported.",
    });
  });
});
