import { beforeEach, describe, expect, it, vi } from "vitest";
import { PlatosMCPTokenService } from "./token.service";
import { createHash } from "node:crypto";

const tokenHash = (raw: string) => createHash("sha256").update(raw).digest("hex");

const scope = {
  organizationId: "org_1",
  projectId: "proj_1",
  environmentId: "env_1",
  userId: "user_1",
};

function createPrisma() {
  const prisma: any = {
    orgMember: { findFirst: vi.fn() },
    platosMCPToken: {
      create: vi.fn(),
      findUnique: vi.fn(),
      findFirst: vi.fn(),
      findMany: vi.fn(),
      update: vi.fn(),
      updateMany: vi.fn(),
    },
    platosCredentialAudit: { create: vi.fn() },
  };
  prisma.$transaction = vi.fn(async (callback: (tx: any) => unknown) => callback(prisma));
  return prisma;
}

describe("PlatosMCPTokenService credential lifecycle", () => {
  let prisma: ReturnType<typeof createPrisma>;
  let service: PlatosMCPTokenService;

  beforeEach(() => {
    prisma = createPrisma();
    prisma.platosMCPToken.updateMany.mockResolvedValue({ count: 1 });
    service = new PlatosMCPTokenService(prisma);
  });

  it("mints plt_mcp_ credentials and atomically records redacted evidence", async () => {
    prisma.platosMCPToken.create.mockResolvedValue({
      id: "token_1",
      tokenHash: tokenHash("plt_mcp_valid"),
      name: "automation",
      permissions: ["agents.read"],
      tier: "scope",
      expiresAt: new Date("2026-11-12T00:00:00.000Z"),
      createdAt: new Date("2026-08-14T00:00:00.000Z"),
    });

    const minted = await service.mint({ scope, name: "automation", permissions: ["agents.read"] });

    expect(minted.token).toMatch(/^plt_mcp_/);
    expect(prisma.$transaction).toHaveBeenCalledOnce();
    expect(prisma.platosCredentialAudit.create).toHaveBeenCalledWith({
      data: {
        family: "control_plane",
        credentialId: "token_1",
        action: "mint",
        organizationId: "org_1",
        projectId: "proj_1",
        environmentId: "env_1",
        actorUserId: "user_1",
      },
    });
    const evidence = prisma.platosCredentialAudit.create.mock.calls[0][0].data;
    expect(evidence).not.toHaveProperty("token");
    expect(evidence).not.toHaveProperty("tokenHash");
  });

  it("does not mint non-expiring control-plane credentials", async () => {
    await expect(
      service.mint({ scope, name: "automation", permissions: ["agents.read"], ttlSeconds: 0 })
    ).rejects.toThrow(/ttlSeconds must be a positive number/i);
    expect(prisma.platosMCPToken.create).not.toHaveBeenCalled();
  });

  it("records successful use and denies use when evidence cannot be persisted", async () => {
    prisma.platosMCPToken.findUnique.mockResolvedValue({
      id: "token_1",
      tokenHash: tokenHash("plt_mcp_valid"),
      organizationId: "org_1",
      projectId: "proj_1",
      environmentId: "env_1",
      permissions: ["*"],
      mintedByUserId: "user_1",
      expiresAt: new Date(Date.now() + 60_000),
      revokedAt: null,
      tier: "admin",
    });

    const verified = await service.verify("plt_mcp_valid");
    expect(verified?.tier).toBe("admin");
    expect(prisma.platosCredentialAudit.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ action: "use", credentialId: "token_1" }),
      })
    );

    prisma.platosCredentialAudit.create.mockRejectedValueOnce(new Error("audit unavailable"));
    await expect(service.verify("plt_mcp_valid")).rejects.toThrow("audit unavailable");
  });

  it("rejects a mismatched stored digest without recording use", async () => {
    prisma.platosMCPToken.findUnique.mockResolvedValue({
      id: "token_1",
      tokenHash: tokenHash("plt_mcp_different"),
      organizationId: "org_1",
      projectId: "proj_1",
      environmentId: "env_1",
      permissions: ["*"],
      mintedByUserId: "user_1",
      expiresAt: new Date(Date.now() + 60_000),
      revokedAt: null,
      tier: "admin",
    });

    await expect(service.verify("plt_mcp_valid")).resolves.toBeNull();
    expect(prisma.$transaction).not.toHaveBeenCalled();
  });

  it("denies use when revocation wins the transactional update race", async () => {
    prisma.platosMCPToken.findUnique.mockResolvedValue({
      id: "token_1",
      tokenHash: tokenHash("plt_mcp_valid"),
      organizationId: "org_1",
      projectId: "proj_1",
      environmentId: "env_1",
      permissions: ["*"],
      mintedByUserId: "user_1",
      expiresAt: new Date(Date.now() + 60_000),
      revokedAt: null,
      tier: "admin",
    });
    prisma.platosMCPToken.updateMany.mockResolvedValue({ count: 0 });

    await expect(service.verify("plt_mcp_valid")).resolves.toBeNull();
    expect(prisma.platosCredentialAudit.create).not.toHaveBeenCalled();
  });

  it.each([
    { revokedAt: new Date(), expiresAt: null },
    { revokedAt: null, expiresAt: new Date(Date.now() - 1) },
  ])("does not audit rejected credentials", async ({ revokedAt, expiresAt }) => {
    prisma.platosMCPToken.findUnique.mockResolvedValue({
      id: "token_1",
      tokenHash: tokenHash("plt_mcp_rejected"),
      organizationId: "org_1",
      projectId: "proj_1",
      environmentId: "env_1",
      permissions: ["*"],
      mintedByUserId: "user_1",
      expiresAt,
      revokedAt,
      tier: "scope",
    });

    await expect(service.verify("plt_mcp_rejected")).resolves.toBeNull();
    expect(prisma.$transaction).not.toHaveBeenCalled();
    expect(prisma.platosCredentialAudit.create).not.toHaveBeenCalled();
  });

  it("records only the first revoke and treats later revokes as idempotent", async () => {
    prisma.platosMCPToken.findFirst
      .mockResolvedValueOnce({ id: "token_1", revokedAt: null })
      .mockResolvedValueOnce({ id: "token_1", revokedAt: new Date() });
    prisma.platosMCPToken.updateMany.mockResolvedValue({ count: 1 });

    await expect(service.revoke("token_1", scope)).resolves.toBe(true);
    await expect(service.revoke("token_1", scope)).resolves.toBe(true);

    expect(prisma.platosCredentialAudit.create).toHaveBeenCalledTimes(1);
    expect(prisma.platosCredentialAudit.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ action: "revoke", actorUserId: "user_1" }),
      })
    );
  });
});
