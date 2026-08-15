import { beforeEach, describe, expect, it, vi } from "vitest";
import { McpBearerTokenService } from "./mcp-bearer-token.service";
import { createHash } from "node:crypto";

const tokenHash = (raw: string) => createHash("sha256").update(raw).digest("hex");

function createPrisma() {
  const prisma: any = {
    platosConnectedEntity: {
      findUnique: vi.fn().mockResolvedValue({ organizationId: "org_1", projectId: "proj_1" }),
    },
    platosMcpBearerToken: {
      create: vi.fn(),
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

describe("McpBearerTokenService credential lifecycle", () => {
  let prisma: ReturnType<typeof createPrisma>;
  let service: McpBearerTokenService;

  beforeEach(() => {
    prisma = createPrisma();
    prisma.platosMcpBearerToken.updateMany.mockResolvedValue({ count: 1 });
    service = new McpBearerTokenService(prisma);
  });

  it("mints only plt_ent_ credentials with a 90-day default and redacted evidence", async () => {
    const before = Date.now();
    const minted = await service.generate("entity_1", "Claude", "user_1");

    expect(minted.raw).toMatch(/^plt_ent_/);
    const create = prisma.platosMcpBearerToken.create.mock.calls[0][0];
    expect(create.data.id).toBe(minted.id);
    expect(create.data.mcpUserId).toBe(`mcp:pat:${minted.id}`);
    expect(create.data.expiresAt.getTime()).toBeGreaterThanOrEqual(
      before + 90 * 24 * 60 * 60 * 1000
    );
    expect(prisma.platosCredentialAudit.create).toHaveBeenCalledWith({
      data: {
        family: "entity_mcp",
        credentialId: minted.id,
        action: "mint",
        organizationId: "org_1",
        projectId: "proj_1",
        actorUserId: "user_1",
      },
    });
    const evidence = prisma.platosCredentialAudit.create.mock.calls[0][0].data;
    expect(evidence).not.toHaveProperty("token");
    expect(evidence).not.toHaveProperty("tokenHash");
  });

  it("does not mint already-expired entity credentials", async () => {
    await expect(
      service.generate("entity_1", "Claude", "user_1", {
        expiresAt: new Date(Date.now() - 1),
      })
    ).rejects.toThrow(/expiresAt must be in the future/i);
    expect(prisma.platosMcpBearerToken.create).not.toHaveBeenCalled();
  });

  it("rejects the retired pmt_ prefix without a database lookup", async () => {
    await expect(service.validate("pmt_retired")).resolves.toBeNull();
    expect(prisma.platosMcpBearerToken.findFirst).not.toHaveBeenCalled();
  });

  it("audits successful use and denies authentication when the audit fails", async () => {
    prisma.platosMcpBearerToken.findFirst.mockResolvedValue({
      id: "token_1",
      tokenHash: tokenHash("plt_ent_valid"),
      entityPk: "entity_1",
      mcpUserId: "mcp:pat:token_1",
      scopes: ["mcp:tools"],
    });

    await expect(service.validate("plt_ent_valid")).resolves.toEqual({
      id: "token_1",
      entityPk: "entity_1",
      mcpUserId: "mcp:pat:token_1",
      scopes: ["mcp:tools"],
    });
    expect(prisma.platosCredentialAudit.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ action: "use", credentialId: "token_1" }),
      })
    );

    prisma.platosCredentialAudit.create.mockRejectedValueOnce(new Error("audit unavailable"));
    await expect(service.validate("plt_ent_valid")).rejects.toThrow("audit unavailable");
  });

  it("rejects a mismatched stored digest without recording use", async () => {
    prisma.platosMcpBearerToken.findFirst.mockResolvedValue({
      id: "token_1",
      tokenHash: tokenHash("plt_ent_different"),
      entityPk: "entity_1",
      mcpUserId: "mcp:pat:token_1",
      scopes: ["mcp:tools"],
    });

    await expect(service.validate("plt_ent_valid")).resolves.toBeNull();
    expect(prisma.$transaction).not.toHaveBeenCalled();
  });

  it("denies use when revocation wins the transactional update race", async () => {
    prisma.platosMcpBearerToken.findFirst.mockResolvedValue({
      id: "token_1",
      tokenHash: tokenHash("plt_ent_valid"),
      entityPk: "entity_1",
      mcpUserId: "mcp:pat:token_1",
      scopes: ["mcp:tools"],
    });
    prisma.platosMcpBearerToken.updateMany.mockResolvedValue({ count: 0 });

    await expect(service.validate("plt_ent_valid")).resolves.toBeNull();
    expect(prisma.platosCredentialAudit.create).not.toHaveBeenCalled();
  });

  it("records one revoke event and keeps revoke idempotent", async () => {
    prisma.platosMcpBearerToken.findFirst
      .mockResolvedValueOnce({ id: "token_1", revokedAt: null })
      .mockResolvedValueOnce({ id: "token_1", revokedAt: new Date() });
    prisma.platosMcpBearerToken.updateMany.mockResolvedValue({ count: 1 });

    await expect(service.revoke("token_1", "entity_1", "user_1")).resolves.toBe(true);
    await expect(service.revoke("token_1", "entity_1", "user_1")).resolves.toBe(true);

    expect(prisma.platosCredentialAudit.create).toHaveBeenCalledTimes(1);
    expect(prisma.platosCredentialAudit.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ action: "revoke", actorUserId: "user_1" }),
      })
    );
  });
});
