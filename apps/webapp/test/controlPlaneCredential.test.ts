import crypto from "node:crypto";
import { beforeEach, describe, expect, it, vi } from "vitest";

const { prisma } = vi.hoisted(() => {
  const prisma: any = {
    platosMCPToken: { findUnique: vi.fn(), updateMany: vi.fn() },
    platosCredentialAudit: { create: vi.fn() },
  };
  prisma.$transaction = vi.fn(async (callback: (tx: any) => unknown) => callback(prisma));
  return { prisma };
});

vi.mock("~/db.server", () => ({ prisma }));

import { verifyAdminControlPlaneCredential } from "~/services/controlPlaneCredential.server";

const validRow = {
  id: "credential_1",
  tokenHash: crypto.createHash("sha256").update("plt_mcp_valid").digest("hex"),
  organizationId: "org_1",
  projectId: "proj_1",
  environmentId: "env_1",
  mintedByUserId: "user_1",
  tier: "admin",
  expiresAt: new Date(Date.now() + 60_000),
  revokedAt: null,
};

function request(token = "plt_mcp_valid") {
  return new Request("https://platos.example/admin", {
    headers: { Authorization: `Bearer ${token}` },
  });
}

describe("verifyAdminControlPlaneCredential", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    prisma.$transaction.mockImplementation(async (callback: (tx: any) => unknown) =>
      callback(prisma)
    );
    prisma.platosMCPToken.updateMany.mockResolvedValue({ count: 1 });
  });

  it.each([
    ["wrong prefix", "plt_pat_wrong", validRow, "org_1"],
    ["scope tier", "plt_mcp_scope", { ...validRow, tier: "scope" }, "org_1"],
    ["wrong organization", "plt_mcp_other", validRow, "org_2"],
    ["expired", "plt_mcp_expired", { ...validRow, expiresAt: new Date(Date.now() - 1) }, "org_1"],
    ["revoked", "plt_mcp_revoked", { ...validRow, revokedAt: new Date() }, "org_1"],
  ])("rejects %s credentials without use evidence", async (_label, token, row, organizationId) => {
    prisma.platosMCPToken.findUnique.mockResolvedValue(row);

    await expect(
      verifyAdminControlPlaneCredential(request(token as string), organizationId as string)
    ).resolves.toBeNull();
    expect(prisma.$transaction).not.toHaveBeenCalled();
    expect(prisma.platosCredentialAudit.create).not.toHaveBeenCalled();
  });

  it("hashes, organization-binds, and audits a valid admin credential", async () => {
    prisma.platosMCPToken.findUnique.mockResolvedValue(validRow);

    await expect(verifyAdminControlPlaneCredential(request(), "org_1")).resolves.toEqual({
      id: "credential_1",
      organizationId: "org_1",
      actorUserId: "user_1",
    });
    expect(prisma.platosMCPToken.findUnique).toHaveBeenCalledWith(
      expect.objectContaining({
        where: {
          tokenHash: crypto.createHash("sha256").update("plt_mcp_valid").digest("hex"),
        },
      })
    );
    expect(prisma.platosCredentialAudit.create).toHaveBeenCalledWith({
      data: {
        family: "control_plane",
        credentialId: "credential_1",
        action: "use",
        organizationId: "org_1",
        projectId: "proj_1",
        environmentId: "env_1",
        actorUserId: "user_1",
      },
    });
  });

  it("fails closed when use evidence cannot be written", async () => {
    prisma.platosMCPToken.findUnique.mockResolvedValue(validRow);
    prisma.platosCredentialAudit.create.mockRejectedValueOnce(new Error("audit unavailable"));

    await expect(verifyAdminControlPlaneCredential(request(), "org_1")).rejects.toThrow(
      "audit unavailable"
    );
  });

  it("rejects a mismatched stored digest without use evidence", async () => {
    prisma.platosMCPToken.findUnique.mockResolvedValue({
      ...validRow,
      tokenHash: crypto.createHash("sha256").update("plt_mcp_other").digest("hex"),
    });

    await expect(verifyAdminControlPlaneCredential(request(), "org_1")).resolves.toBeNull();
    expect(prisma.$transaction).not.toHaveBeenCalled();
  });

  it("denies use when revocation wins the transactional update race", async () => {
    prisma.platosMCPToken.findUnique.mockResolvedValue(validRow);
    prisma.platosMCPToken.updateMany.mockResolvedValue({ count: 0 });

    await expect(verifyAdminControlPlaneCredential(request(), "org_1")).resolves.toBeNull();
    expect(prisma.platosCredentialAudit.create).not.toHaveBeenCalled();
  });
});
