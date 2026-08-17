import crypto from "node:crypto";
import { beforeEach, describe, expect, it, vi } from "vitest";

const { prisma } = vi.hoisted(() => {
  const prisma: any = {
    personalAccessToken: {
      create: vi.fn(),
      findUnique: vi.fn(),
      findFirst: vi.fn(),
      findMany: vi.fn(),
      updateMany: vi.fn(),
    },
    tokenLifecycleAudit: { create: vi.fn() },
    organizationMembership: { findFirst: vi.fn() },
    project: { findFirst: vi.fn() },
    projectMembership: { findUnique: vi.fn() },
    environment: { findFirst: vi.fn() },
  };
  prisma.$transaction = vi.fn(async (callback: (tx: any) => unknown) => callback(prisma));
  return { prisma };
});

vi.mock("~/db.server", () => ({ prisma }));

import {
  authenticateApiRequestWithPAT,
  mintPAT,
  patAllowsScope,
  patHasCapability,
  revokePAT,
  verifyPAT,
} from "~/services/patService.server";

function persistedPAT(raw = "plt_pat_valid", overrides: Record<string, unknown> = {}) {
  return {
    id: "pat_1",
    tokenHash: crypto.createHash("sha256").update(raw).digest("hex"),
    userId: "user_1",
    scopeKind: "GLOBAL",
    organizationId: null,
    projectId: null,
    environmentId: null,
    project: null,
    environment: null,
    role: "write",
    expiresAt: new Date(Date.now() + 60_000),
    revokedAt: null,
    ...overrides,
  };
}

describe("Platos PAT token lifecycle audit", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    prisma.$transaction.mockImplementation(async (callback: (tx: any) => unknown) =>
      callback(prisma)
    );
    prisma.personalAccessToken.updateMany.mockResolvedValue({ count: 1 });
    prisma.organizationMembership.findFirst.mockResolvedValue({ id: "membership_1", role: "ADMIN" });
    prisma.project.findFirst.mockResolvedValue({ id: "project_1" });
    prisma.projectMembership.findUnique.mockResolvedValue({ id: "project_membership_1" });
    prisma.environment.findFirst.mockResolvedValue({ id: "env_1" });
  });

  it("atomically mints a hash-only PAT and redacted lifecycle evidence", async () => {
    const createdAt = new Date("2026-08-17T00:00:00.000Z");
    prisma.personalAccessToken.create.mockImplementation(async ({ data }: any) => ({
      id: "pat_1",
      name: data.name,
      role: data.role,
      expiresAt: data.expiresAt,
      createdAt,
    }));

    const minted = await mintPAT({ userId: "user_1", name: "CLI", ttlSeconds: 0 });

    expect(minted.token).toMatch(/^plt_pat_/);
    expect(prisma.$transaction).toHaveBeenCalledTimes(1);
    const tokenData = prisma.personalAccessToken.create.mock.calls[0][0].data;
    expect(tokenData.tokenHash).toBe(
      crypto.createHash("sha256").update(minted.token, "utf8").digest("hex")
    );
    expect(tokenData).not.toHaveProperty("token");
    const auditData = prisma.tokenLifecycleAudit.create.mock.calls[0][0].data;
    expect(auditData).toEqual({
      family: "PERSONAL_ACCESS_TOKEN",
      personalAccessTokenId: "pat_1",
      scopeKind: "GLOBAL",
      organizationId: null,
      projectId: null,
      environmentId: null,
      actorUserId: "user_1",
      action: "MINT",
      outcome: "SUCCESS",
    });
    expect(JSON.stringify(auditData)).not.toContain(minted.token);
    expect(auditData).not.toHaveProperty("tokenHash");
  });

  it("does not return a bearer when mint evidence cannot be persisted", async () => {
    prisma.personalAccessToken.create.mockResolvedValue({
      id: "pat_1",
      name: "CLI",
      role: "write",
      expiresAt: null,
      createdAt: new Date(),
    });
    prisma.tokenLifecycleAudit.create.mockRejectedValueOnce(new Error("audit unavailable"));

    await expect(mintPAT({ userId: "user_1", name: "CLI", ttlSeconds: 0 }))
      .rejects.toThrow("audit unavailable");
  });

  it("atomically records successful use and reconstructs canonical ancestry", async () => {
    prisma.personalAccessToken.findUnique.mockResolvedValue(persistedPAT("plt_pat_valid", {
      scopeKind: "ENVIRONMENT",
      environmentId: "env_1",
      environment: {
        id: "env_1",
        project: { id: "project_1", organizationId: "org_1" },
      },
    }));

    await expect(verifyPAT("plt_pat_valid")).resolves.toMatchObject({
      id: "pat_1",
      organizationId: "org_1",
      projectId: "project_1",
      environmentId: "env_1",
    });
    expect(prisma.tokenLifecycleAudit.create).toHaveBeenCalledWith({
      data: {
        family: "PERSONAL_ACCESS_TOKEN",
        personalAccessTokenId: "pat_1",
        scopeKind: "ENVIRONMENT",
        organizationId: null,
        projectId: null,
        environmentId: "env_1",
        actorUserId: "user_1",
        action: "USE",
        outcome: "SUCCESS",
      },
    });
  });

  it("fails closed when use evidence cannot be persisted", async () => {
    prisma.personalAccessToken.findUnique.mockResolvedValue(persistedPAT());
    prisma.tokenLifecycleAudit.create.mockRejectedValueOnce(new Error("audit unavailable"));

    await expect(verifyPAT("plt_pat_valid")).rejects.toThrow("audit unavailable");
  });

  it("does not record use when revocation wins the guarded update", async () => {
    prisma.personalAccessToken.findUnique.mockResolvedValue(persistedPAT());
    prisma.personalAccessToken.updateMany.mockResolvedValueOnce({ count: 0 });

    await expect(verifyPAT("plt_pat_valid")).resolves.toBeNull();
    expect(prisma.tokenLifecycleAudit.create).not.toHaveBeenCalled();
  });

  it("records exactly one revoke for idempotent retries", async () => {
    prisma.personalAccessToken.findFirst
      .mockResolvedValueOnce({
        id: "pat_1",
        revokedAt: null,
        scopeKind: "GLOBAL",
        organizationId: null,
        projectId: null,
        environmentId: null,
      })
      .mockResolvedValueOnce({
        id: "pat_1",
        revokedAt: new Date(),
        scopeKind: "GLOBAL",
        organizationId: null,
        projectId: null,
        environmentId: null,
      });

    await expect(revokePAT("pat_1", "user_1")).resolves.toEqual({ ok: true });
    await expect(revokePAT("pat_1", "user_1")).resolves.toEqual({ ok: true });

    expect(prisma.tokenLifecycleAudit.create).toHaveBeenCalledTimes(1);
    expect(prisma.tokenLifecycleAudit.create).toHaveBeenCalledWith({
      data: expect.objectContaining({ action: "REVOKE", outcome: "SUCCESS" }),
    });
  });

  it("fails closed when revoke evidence cannot be persisted", async () => {
    prisma.personalAccessToken.findFirst.mockResolvedValue({
      id: "pat_1",
      revokedAt: null,
      scopeKind: "GLOBAL",
      organizationId: null,
      projectId: null,
      environmentId: null,
    });
    prisma.tokenLifecycleAudit.create.mockRejectedValueOnce(new Error("audit unavailable"));

    await expect(revokePAT("pat_1", "user_1")).rejects.toThrow("audit unavailable");
  });

  it("enforces capability and scope narrowing", () => {
    expect(patHasCapability("read", "write")).toBe(false);
    expect(patHasCapability("write", "read")).toBe(true);
    expect(patHasCapability("admin", "admin")).toBe(true);
    const pat = {
      id: "pat_1",
      userId: "user_1",
      organizationId: "org_1",
      projectId: "project_1",
      environmentId: "env_1",
      role: "write" as const,
      expiresAt: null,
    };
    expect(patAllowsScope(pat, {
      organizationId: "org_1",
      projectId: "project_1",
      environmentId: "env_1",
    })).toBe(true);
    expect(patAllowsScope(pat, { organizationId: "org_1", projectId: "project_1" })).toBe(false);
  });

  it("rejects invalid mint hierarchy before persistence", async () => {
    await expect(mintPAT({ userId: "user_1", name: "bad", projectId: "project_1" }))
      .rejects.toThrow(/requires an organization/i);
    await expect(mintPAT({ userId: "user_1", name: "bad", orgId: "org_1", envId: "env_1" }))
      .rejects.toThrow(/requires organization and project/i);
    expect(prisma.personalAccessToken.create).not.toHaveBeenCalled();
  });

  it("authenticates API requests only after lifecycle evidence commits", async () => {
    prisma.personalAccessToken.findUnique.mockResolvedValue(persistedPAT());

    await expect(authenticateApiRequestWithPAT(new Request("https://platos.example/api", {
      headers: { Authorization: "Bearer plt_pat_valid" },
    }))).resolves.toMatchObject({ id: "pat_1", role: "write" });
  });
});
