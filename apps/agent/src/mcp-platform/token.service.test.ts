import { beforeEach, describe, expect, it, vi } from "vitest";
import { createHash } from "node:crypto";
import { MCPTokenForbiddenError, PlatosMCPTokenService } from "./token.service";

const tokenHash = (raw: string) => createHash("sha256").update(raw).digest("hex");
const scope = {
  organizationId: "org_1",
  projectId: "proj_1",
  environmentId: "env_1",
  userId: "user_1",
};

function createPrisma() {
  const prisma = {
    environment: {
      findUnique: vi.fn().mockResolvedValue({
        id: "env_1",
        project: { id: "proj_1", organizationId: "org_1" },
      }),
    },
    organizationMembership: {
      findUnique: vi.fn().mockResolvedValue({ id: "membership_1", role: "MEMBER", deactivatedAt: null }),
    },
    projectMembership: { findUnique: vi.fn().mockResolvedValue({ role: "ADMIN" }) },
    mcpToken: {
      create: vi.fn(),
      findUnique: vi.fn(),
      findFirst: vi.fn(),
      findMany: vi.fn(),
      updateMany: vi.fn().mockResolvedValue({ count: 1 }),
    },
    tokenLifecycleAudit: { create: vi.fn() },
  } as any;
  prisma.$transaction = vi.fn(async (callback: (tx: any) => unknown) => callback(prisma));
  return prisma;
}

function verifiedRow(raw = "plt_mcp_valid") {
  return {
    id: "token_1",
    tokenHash: tokenHash(raw),
    permissions: ["*"],
    mintedByUserId: "user_1",
    expiresAt: new Date(Date.now() + 60_000),
    revokedAt: null,
    tier: "scope",
    environment: { id: "env_1", project: { id: "proj_1", organizationId: "org_1" } },
  };
}

describe("PlatosMCPTokenService clean-tenancy lifecycle", () => {
  let prisma: ReturnType<typeof createPrisma>;
  let service: PlatosMCPTokenService;

  beforeEach(() => {
    prisma = createPrisma();
    service = new PlatosMCPTokenService(prisma);
  });

  it("retains the plt_mcp_ prefix and persists only Environment ownership", async () => {
    prisma.mcpToken.create.mockResolvedValue({
      id: "token_1",
      name: "automation",
      permissions: ["agents.read"],
      tier: "scope",
      expiresAt: new Date("2026-11-12T00:00:00.000Z"),
      createdAt: new Date("2026-08-14T00:00:00.000Z"),
    });

    const minted = await service.mint({ scope, name: "automation", permissions: ["agents.read"] });

    expect(minted.token).toMatch(/^plt_mcp_/);
    const data = prisma.mcpToken.create.mock.calls[0][0].data;
    expect(data.environmentId).toBe("env_1");
    expect(data.tokenHash).toMatch(/^[0-9a-f]{64}$/);
    expect(data).not.toHaveProperty("organizationId");
    expect(data).not.toHaveProperty("projectId");
    expect(data).not.toHaveProperty("token");
    expect(prisma.$transaction).toHaveBeenCalledTimes(1);
    expect(prisma.tokenLifecycleAudit.create).toHaveBeenCalledWith({
      data: {
        family: "MCP_TOKEN",
        mcpTokenId: "token_1",
        scopeKind: "ENVIRONMENT",
        environmentId: "env_1",
        actorUserId: "user_1",
        action: "MINT",
        outcome: "SUCCESS",
      },
    });
    expect(JSON.stringify(prisma.tokenLifecycleAudit.create.mock.calls[0][0])).not.toContain(
      minted.token,
    );
    expect(prisma.tokenLifecycleAudit.create.mock.calls[0][0].data).not.toHaveProperty("tokenHash");
  });

  it("rejects a forged request tuple before minting", async () => {
    await expect(
      service.mint({
        scope: { ...scope, organizationId: "forged_org" },
        name: "automation",
        permissions: ["agents.read"],
      }),
    ).rejects.toBeInstanceOf(MCPTokenForbiddenError);
    expect(prisma.mcpToken.create).not.toHaveBeenCalled();
  });

  it("derives verified scope from persisted Environment ancestry", async () => {
    prisma.mcpToken.findUnique.mockResolvedValue({
      id: "token_1",
      tokenHash: tokenHash("plt_mcp_valid"),
      permissions: ["*"],
      mintedByUserId: "user_1",
      expiresAt: new Date(Date.now() + 60_000),
      revokedAt: null,
      tier: "admin",
      environment: {
        id: "env_canonical",
        project: { id: "proj_canonical", organizationId: "org_canonical" },
      },
    });

    await expect(service.verify("plt_mcp_valid")).resolves.toMatchObject({
      tier: "admin",
      scope: {
        environmentId: "env_canonical",
        projectId: "proj_canonical",
        organizationId: "org_canonical",
      },
    });
    expect(prisma.tokenLifecycleAudit.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        family: "MCP_TOKEN",
        mcpTokenId: "token_1",
        scopeKind: "ENVIRONMENT",
        environmentId: "env_canonical",
        action: "USE",
        outcome: "SUCCESS",
      }),
    });
  });

  it("denies verification when revocation wins the last-used update race", async () => {
    prisma.mcpToken.findUnique.mockResolvedValue({
      id: "token_1",
      tokenHash: tokenHash("plt_mcp_valid"),
      permissions: ["*"],
      mintedByUserId: "user_1",
      expiresAt: new Date(Date.now() + 60_000),
      revokedAt: null,
      tier: "scope",
      environment: { id: "env_1", project: { id: "proj_1", organizationId: "org_1" } },
    });
    prisma.mcpToken.updateMany.mockResolvedValue({ count: 0 });

    await expect(service.verify("plt_mcp_valid")).resolves.toBeNull();
    expect(prisma.tokenLifecycleAudit.create).not.toHaveBeenCalled();
  });

  it("enforces the mutation role gate for admin-tier tokens", async () => {
    prisma.projectMembership.findUnique.mockResolvedValue({ role: "EDITOR" });

    await expect(
      service.mint({ ...({ scope, name: "admin", permissions: ["*"] }), tier: "admin" }),
    ).rejects.toBeInstanceOf(MCPTokenForbiddenError);
  });

  it("denies an ordinary organization member outside the canonical project", async () => {
    prisma.projectMembership.findUnique.mockResolvedValue(null);

    await expect(service.list(scope)).rejects.toBeInstanceOf(MCPTokenForbiddenError);
    await expect(
      service.mint({ scope, name: "cross-project", permissions: ["*"] }),
    ).rejects.toBeInstanceOf(MCPTokenForbiddenError);
    prisma.mcpToken.findFirst.mockResolvedValue({ id: "token_1", revokedAt: null });
    await expect(service.revoke("token_1", scope)).rejects.toBeInstanceOf(MCPTokenForbiddenError);
    expect(prisma.mcpToken.findMany).not.toHaveBeenCalled();
    expect(prisma.mcpToken.create).not.toHaveBeenCalled();
    expect(prisma.mcpToken.updateMany).not.toHaveBeenCalled();
  });

  it("permits organization administrators to mutate without a project row", async () => {
    prisma.organizationMembership.findUnique.mockResolvedValue({
      id: "membership_1",
      role: "ADMIN",
      deactivatedAt: null,
    });
    prisma.projectMembership.findUnique.mockResolvedValue(null);
    prisma.mcpToken.create.mockResolvedValue({
      id: "token_1",
      name: "admin",
      permissions: ["*"],
      tier: "admin",
      expiresAt: new Date(),
      createdAt: new Date(),
    });

    await expect(service.mint({ scope, name: "admin", permissions: ["*"], tier: "admin" }))
      .resolves.toMatchObject({ id: "token_1" });
  });

  it("revokes only a token owned by the canonical Environment", async () => {
    prisma.mcpToken.findFirst.mockResolvedValue({ id: "token_1", revokedAt: null });

    await expect(service.revoke("token_1", scope)).resolves.toBe(true);
    expect(prisma.mcpToken.updateMany).toHaveBeenCalledWith({
      where: { id: "token_1", environmentId: "env_1", revokedAt: null },
      data: { revokedAt: expect.any(Date), revokedBy: "user_1" },
    });
    expect(prisma.tokenLifecycleAudit.create).toHaveBeenCalledWith({
      data: {
        family: "MCP_TOKEN",
        mcpTokenId: "token_1",
        scopeKind: "ENVIRONMENT",
        environmentId: "env_1",
        actorUserId: "user_1",
        action: "REVOKE",
        outcome: "SUCCESS",
      },
    });
  });

  it("records exactly one revoke for idempotent retries", async () => {
    prisma.mcpToken.findFirst
      .mockResolvedValueOnce({ id: "token_1", revokedAt: null })
      .mockResolvedValueOnce({ id: "token_1", revokedAt: new Date() });

    await expect(service.revoke("token_1", scope)).resolves.toBe(true);
    await expect(service.revoke("token_1", scope)).resolves.toBe(true);

    expect(prisma.tokenLifecycleAudit.create).toHaveBeenCalledTimes(1);
  });

  it("fails closed when mint evidence cannot be persisted", async () => {
    prisma.mcpToken.create.mockResolvedValue({
      id: "token_1",
      name: "automation",
      permissions: ["agents.read"],
      tier: "scope",
      expiresAt: new Date(),
      createdAt: new Date(),
    });
    prisma.tokenLifecycleAudit.create.mockRejectedValue(new Error("audit unavailable"));

    await expect(
      service.mint({ scope, name: "automation", permissions: ["agents.read"] }),
    ).rejects.toThrow("audit unavailable");
  });

  it("fails closed when use evidence cannot be persisted", async () => {
    prisma.mcpToken.findUnique.mockResolvedValue(verifiedRow());
    prisma.tokenLifecycleAudit.create.mockRejectedValue(new Error("audit unavailable"));

    await expect(service.verify("plt_mcp_valid")).rejects.toThrow("audit unavailable");
  });

  it("fails closed when revoke evidence cannot be persisted", async () => {
    prisma.mcpToken.findFirst.mockResolvedValue({ id: "token_1", revokedAt: null });
    prisma.tokenLifecycleAudit.create.mockRejectedValue(new Error("audit unavailable"));

    await expect(service.revoke("token_1", scope)).rejects.toThrow("audit unavailable");
  });
});
