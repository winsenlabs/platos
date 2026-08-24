import { beforeEach, describe, expect, it, vi } from "vitest";
import { createHash } from "node:crypto";
import { AdminMintForbiddenError, PlatosMCPTokenService } from "./token.service";

const tokenHash = (raw: string) => createHash("sha256").update(raw).digest("hex");
const scope = {
  organizationId: "org_1",
  projectId: "proj_1",
  environmentId: "env_1",
  userId: "user_1",
};

function createPrisma() {
  return {
    environment: {
      findUnique: vi.fn().mockResolvedValue({
        id: "env_1",
        project: { id: "proj_1", organizationId: "org_1" },
      }),
    },
    organizationMembership: { findFirst: vi.fn() },
    mcpToken: {
      create: vi.fn(),
      findUnique: vi.fn(),
      findFirst: vi.fn(),
      findMany: vi.fn(),
      updateMany: vi.fn().mockResolvedValue({ count: 1 }),
    },
  } as any;
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
  });

  it("rejects a forged request tuple before minting", async () => {
    await expect(
      service.mint({
        scope: { ...scope, organizationId: "forged_org" },
        name: "automation",
        permissions: ["agents.read"],
      }),
    ).rejects.toThrow("Environment not found in scope");
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
  });

  it("uses canonical organization ancestry for the admin-tier role gate", async () => {
    prisma.organizationMembership.findFirst.mockResolvedValue(null);

    await expect(
      service.mint({ ...({ scope, name: "admin", permissions: ["*"] }), tier: "admin" }),
    ).rejects.toBeInstanceOf(AdminMintForbiddenError);
    expect(prisma.organizationMembership.findFirst).toHaveBeenCalledWith({
      where: {
        organizationId: "org_1",
        userId: "user_1",
        deactivatedAt: null,
        role: { in: ["OWNER", "ADMIN"] },
      },
      select: { id: true },
    });
  });

  it("returns bounded metadata pages with the full Environment total", async () => {
    const createdAt = new Date("2026-08-14T00:00:00.000Z");
    prisma.mcpToken.findMany.mockResolvedValue([
      { id: "token_3", name: "three", permissions: ["agents.read"], tier: "scope", expiresAt: null, lastUsedAt: null, revokedAt: null, createdAt },
      { id: "token_2", name: "two", permissions: ["agents.read"], tier: "scope", expiresAt: null, lastUsedAt: null, revokedAt: null, createdAt },
      { id: "token_1", name: "one", permissions: ["agents.read"], tier: "scope", expiresAt: null, lastUsedAt: null, revokedAt: null, createdAt },
    ]);

    await expect(service.list(scope, { limit: 1, offset: 1 })).resolves.toEqual({
      tokens: [{ id: "token_2", name: "two", permissions: ["agents.read"], tier: "scope", expiresAt: null, lastUsedAt: null, revokedAt: null, createdAt }],
      total: 3,
      limit: 1,
      offset: 1,
    });
    await expect(service.list(scope, { limit: Number.NaN, offset: Number.NaN })).resolves.toMatchObject({
      total: 3,
      limit: 50,
      offset: 0,
    });
  });

  it("revokes only a token owned by the canonical Environment", async () => {
    prisma.mcpToken.findFirst.mockResolvedValue({ id: "token_1", revokedAt: null });

    await expect(service.revoke("token_1", scope)).resolves.toBe(true);
    expect(prisma.mcpToken.updateMany).toHaveBeenCalledWith({
      where: { id: "token_1", environmentId: "env_1", revokedAt: null },
      data: { revokedAt: expect.any(Date), revokedBy: "user_1" },
    });
  });
});
