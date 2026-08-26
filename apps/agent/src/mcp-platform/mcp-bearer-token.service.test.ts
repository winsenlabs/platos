import { beforeEach, describe, expect, it, vi } from "vitest";
import { McpBearerTokenService } from "./mcp-bearer-token.service";
import { createHash } from "node:crypto";

const tokenHash = (raw: string) => createHash("sha256").update(raw).digest("hex");

function createPrisma() {
  const prisma: any = {
    entity: {
      findFirst: vi.fn().mockResolvedValue({
        project: {
          id: "proj_1",
          organizationId: "org_1",
        },
      }),
    },
    mcpBearerToken: {
      count: vi.fn(),
      create: vi.fn(),
      findFirst: vi.fn(),
      findMany: vi.fn(),
      update: vi.fn(),
      updateMany: vi.fn(),
    },
    adminAudit: { create: vi.fn() },
  };
  prisma.$transaction = vi.fn(async (operation: ((tx: any) => unknown) | Promise<unknown>[]) =>
    Array.isArray(operation) ? Promise.all(operation) : operation(prisma)
  );
  return prisma;
}

describe("McpBearerTokenService credential lifecycle", () => {
  let prisma: ReturnType<typeof createPrisma>;
  let service: McpBearerTokenService;

  beforeEach(() => {
    prisma = createPrisma();
    prisma.mcpBearerToken.updateMany.mockResolvedValue({ count: 1 });
    service = new McpBearerTokenService(prisma);
  });

  it("mints only plt_ent_ credentials with a 90-day default and redacted evidence", async () => {
    const before = Date.now();
    const minted = await service.generate("entity_1", "env_1", "Claude", "user_1");

    expect(minted.raw).toMatch(/^plt_ent_/);
    const create = prisma.mcpBearerToken.create.mock.calls[0][0];
    expect(create.data.id).toBe(minted.id);
    expect(create.data.mcpUserId).toBe(`mcp:pat:${minted.id}`);
    expect(create.data.environmentId).toBe("env_1");
    expect(create.data.expiresAt.getTime()).toBeGreaterThanOrEqual(
      before + 90 * 24 * 60 * 60 * 1000
    );
    expect(prisma.adminAudit.create).toHaveBeenCalledWith({
      data: {
        environmentId: "env_1",
        actorUserId: "user_1",
        action: "mcp_bearer.mint",
        subjectType: "McpBearerToken",
        subjectId: minted.id,
        after: {
          organizationId: "org_1",
          projectId: "proj_1",
          environmentId: "env_1",
        },
        source: "entity_mcp",
      },
    });
    const evidence = prisma.adminAudit.create.mock.calls[0][0].data;
    expect(evidence).not.toHaveProperty("token");
    expect(evidence).not.toHaveProperty("tokenHash");
  });

  it("does not mint already-expired entity credentials", async () => {
    await expect(
      service.generate("entity_1", "env_1", "Claude", "user_1", {
        expiresAt: new Date(Date.now() - 1),
      })
    ).rejects.toThrow(/expiresAt must be in the future/i);
    expect(prisma.mcpBearerToken.create).not.toHaveBeenCalled();
  });

  it("rejects the retired pmt_ prefix without a database lookup", async () => {
    await expect(service.validate("pmt_retired")).resolves.toBeNull();
    expect(prisma.mcpBearerToken.findFirst).not.toHaveBeenCalled();
  });

  it("audits successful use and denies authentication when the audit fails", async () => {
    prisma.mcpBearerToken.findFirst.mockResolvedValue({
      id: "token_1",
      tokenHash: tokenHash("plt_ent_valid"),
      entityId: "entity_1",
      environmentId: "env_1",
      mcpUserId: "mcp:pat:token_1",
      scopes: ["mcp:tools"],
    });

    await expect(service.validate("plt_ent_valid")).resolves.toEqual({
      id: "token_1",
      entityPk: "entity_1",
      environmentId: "env_1",
      mcpUserId: "mcp:pat:token_1",
      scopes: ["mcp:tools"],
    });
    expect(prisma.adminAudit.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ action: "mcp_bearer.use", subjectId: "token_1" }),
      })
    );

    prisma.adminAudit.create.mockRejectedValueOnce(new Error("audit unavailable"));
    await expect(service.validate("plt_ent_valid")).rejects.toThrow("audit unavailable");
  });

  it("rejects a mismatched stored digest without recording use", async () => {
    prisma.mcpBearerToken.findFirst.mockResolvedValue({
      id: "token_1",
      tokenHash: tokenHash("plt_ent_different"),
      entityId: "entity_1",
      environmentId: "env_1",
      mcpUserId: "mcp:pat:token_1",
      scopes: ["mcp:tools"],
    });

    await expect(service.validate("plt_ent_valid")).resolves.toBeNull();
    expect(prisma.$transaction).not.toHaveBeenCalled();
  });

  it("returns bounded metadata pages with the full Entity and Environment total", async () => {
    const createdAt = new Date("2026-08-14T00:00:00.000Z");
    const row = (id: string) => ({
      id,
      environmentId: "env_1",
      label: id,
      mcpUserId: `mcp:pat:${id}`,
      scopes: ["mcp:tools"],
      createdAt,
      lastUsedAt: null,
      expiresAt: null,
      revokedAt: null,
    });
    prisma.mcpBearerToken.count.mockResolvedValue(3);
    prisma.mcpBearerToken.findMany.mockResolvedValueOnce([row("token_2")]);

    await expect(service.list("entity_1", "env_1", { limit: 1, offset: 1 })).resolves.toEqual({
      tokens: [row("token_2")],
      total: 3,
      limit: 1,
      offset: 1,
    });
    expect(prisma.mcpBearerToken.count).toHaveBeenCalledWith({
      where: { entityId: "entity_1", environmentId: "env_1" },
    });
    expect(prisma.mcpBearerToken.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { entityId: "entity_1", environmentId: "env_1" },
        orderBy: [{ createdAt: "desc" }, { id: "desc" }],
        skip: 1,
        take: 1,
      }),
    );
    prisma.mcpBearerToken.findMany.mockResolvedValueOnce([
      row("token_3"),
      row("token_2"),
      row("token_1"),
    ]);
    await expect(
      service.list("entity_1", "env_1", { limit: Number.NaN, offset: Number.NaN }),
    ).resolves.toMatchObject({ total: 3, limit: 50, offset: 0 });
  });

  it("denies use when revocation wins the transactional update race", async () => {
    prisma.mcpBearerToken.findFirst.mockResolvedValue({
      id: "token_1",
      tokenHash: tokenHash("plt_ent_valid"),
      entityId: "entity_1",
      environmentId: "env_1",
      mcpUserId: "mcp:pat:token_1",
      scopes: ["mcp:tools"],
    });
    prisma.mcpBearerToken.updateMany.mockResolvedValue({ count: 0 });

    await expect(service.validate("plt_ent_valid")).resolves.toBeNull();
    expect(prisma.adminAudit.create).not.toHaveBeenCalled();
  });

  it("records one revoke event and keeps revoke idempotent", async () => {
    prisma.mcpBearerToken.findFirst
      .mockResolvedValueOnce({ id: "token_1", revokedAt: null })
      .mockResolvedValueOnce({ id: "token_1", revokedAt: new Date() });
    prisma.mcpBearerToken.updateMany.mockResolvedValue({ count: 1 });

    await expect(
      service.revoke("token_1", "entity_1", "env_1", "user_1"),
    ).resolves.toBe(true);
    await expect(
      service.revoke("token_1", "entity_1", "env_1", "user_1"),
    ).resolves.toBe(true);

    expect(prisma.adminAudit.create).toHaveBeenCalledTimes(1);
    expect(prisma.adminAudit.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ action: "mcp_bearer.revoke", actorUserId: "user_1" }),
      })
    );
  });
});
