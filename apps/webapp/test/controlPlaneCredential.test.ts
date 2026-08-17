import crypto from "node:crypto";
import { beforeEach, describe, expect, it, vi } from "vitest";

const { prisma } = vi.hoisted(() => {
  const prisma: any = {
    mcpToken: { findUnique: vi.fn(), updateMany: vi.fn() },
    tokenLifecycleAudit: { create: vi.fn() },
  };
  prisma.$transaction = vi.fn(async (callback: (tx: any) => unknown) => callback(prisma));
  return { prisma };
});

vi.mock("~/db.server", () => ({ prisma }));

import { verifyAdminControlPlaneCredential } from "~/services/controlPlaneCredential.server";

const validRow = {
  id: "credential_1",
  tokenHash: crypto.createHash("sha256").update("plt_mcp_valid").digest("hex"),
  mintedByUserId: "user_1",
  tier: "admin",
  expiresAt: new Date(Date.now() + 60_000),
  revokedAt: null,
  environment: {
    id: "env_1",
    project: { id: "proj_1", organizationId: "org_1" },
  },
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
    prisma.mcpToken.updateMany.mockResolvedValue({ count: 1 });
  });

  it.each([
    ["scope tier", { ...validRow, tier: "scope" }, "org_1"],
    ["wrong organization", validRow, "org_2"],
    ["expired", { ...validRow, expiresAt: new Date(Date.now() - 1) }, "org_1"],
    ["revoked", { ...validRow, revokedAt: new Date() }, "org_1"],
  ])("rejects %s credentials without use evidence", async (_label, row, organizationId) => {
    prisma.mcpToken.findUnique.mockResolvedValue(row);

    await expect(verifyAdminControlPlaneCredential(request(), organizationId as string))
      .resolves.toBeNull();
    expect(prisma.$transaction).not.toHaveBeenCalled();
    expect(prisma.tokenLifecycleAudit.create).not.toHaveBeenCalled();
  });

  it("hashes, organization-binds, and atomically audits a valid admin credential", async () => {
    prisma.mcpToken.findUnique.mockResolvedValue(validRow);

    await expect(verifyAdminControlPlaneCredential(request(), "org_1")).resolves.toEqual({
      id: "credential_1",
      organizationId: "org_1",
      actorUserId: "user_1",
    });
    expect(prisma.$transaction).toHaveBeenCalledTimes(1);
    expect(prisma.tokenLifecycleAudit.create).toHaveBeenCalledWith({
      data: {
        family: "MCP_TOKEN",
        mcpTokenId: "credential_1",
        scopeKind: "ENVIRONMENT",
        environmentId: "env_1",
        actorUserId: "user_1",
        action: "USE",
        outcome: "SUCCESS",
      },
    });
    const auditPayload = prisma.tokenLifecycleAudit.create.mock.calls[0][0].data;
    expect(JSON.stringify(auditPayload)).not.toContain("plt_mcp_valid");
    expect(auditPayload).not.toHaveProperty("tokenHash");
  });

  it("fails closed when use evidence cannot be written", async () => {
    prisma.mcpToken.findUnique.mockResolvedValue(validRow);
    prisma.tokenLifecycleAudit.create.mockRejectedValueOnce(new Error("audit unavailable"));

    await expect(verifyAdminControlPlaneCredential(request(), "org_1"))
      .rejects.toThrow("audit unavailable");
  });

  it("denies use without false evidence when revocation wins the update race", async () => {
    prisma.mcpToken.findUnique.mockResolvedValue(validRow);
    prisma.mcpToken.updateMany.mockResolvedValue({ count: 0 });

    await expect(verifyAdminControlPlaneCredential(request(), "org_1")).resolves.toBeNull();
    expect(prisma.tokenLifecycleAudit.create).not.toHaveBeenCalled();
  });
});
