import crypto from "node:crypto";
import { beforeEach, describe, expect, it, vi } from "vitest";

const { prisma } = vi.hoisted(() => {
  const prisma: any = {
    platosPAT: {
      create: vi.fn(),
      findFirst: vi.fn(),
      findMany: vi.fn(),
      update: vi.fn(),
      updateMany: vi.fn(),
    },
    platosCredentialAudit: { create: vi.fn() },
    orgMember: { findFirst: vi.fn() },
    project: { findFirst: vi.fn() },
    runtimeEnvironment: { findFirst: vi.fn() },
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

describe("Platos PAT credential lifecycle", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    prisma.$transaction.mockImplementation(async (callback: (tx: any) => unknown) =>
      callback(prisma)
    );
    prisma.platosPAT.updateMany.mockResolvedValue({ count: 1 });
    prisma.orgMember.findFirst.mockResolvedValue({ role: "ADMIN" });
    prisma.project.findFirst.mockResolvedValue({ id: "project_1" });
    prisma.runtimeEnvironment.findFirst.mockResolvedValue({ id: "env_1" });
  });

  it("mints plt_pat_ credentials with a 90-day default and redacted evidence", async () => {
    const createdAt = new Date("2026-08-14T00:00:00.000Z");
    prisma.platosPAT.create.mockImplementation(async ({ data }: any) => ({
      id: "pat_1",
      name: data.name,
      role: data.role,
      organizationId: data.organizationId,
      projectId: data.projectId,
      environmentId: data.environmentId,
      expiresAt: data.expiresAt,
      createdAt,
    }));
    const before = Date.now();

    const minted = await mintPAT({ userId: "user_1", name: "CLI" });

    expect(minted.token).toMatch(/^plt_pat_/);
    expect(minted.expiresAt?.getTime()).toBeGreaterThanOrEqual(before + 90 * 24 * 60 * 60 * 1000);
    expect(prisma.platosCredentialAudit.create).toHaveBeenCalledWith({
      data: {
        family: "user_api",
        credentialId: "pat_1",
        action: "mint",
        organizationId: null,
        projectId: null,
        environmentId: null,
        actorUserId: "user_1",
      },
    });
    const evidence = prisma.platosCredentialAudit.create.mock.calls[0][0].data;
    expect(evidence).not.toHaveProperty("token");
    expect(evidence).not.toHaveProperty("tokenHash");
  });

  it("audits successful use and authenticates API requests", async () => {
    const tokenHash = crypto.createHash("sha256").update("plt_pat_valid").digest("hex");
    prisma.platosPAT.findFirst.mockResolvedValue({
      id: "pat_1",
      tokenHash,
      userId: "user_1",
      organizationId: null,
      projectId: null,
      environmentId: null,
      role: "write",
      expiresAt: new Date(Date.now() + 60_000),
      revokedAt: null,
    });

    await expect(
      authenticateApiRequestWithPAT(
        new Request("https://platos.example/api", {
          headers: { Authorization: "Bearer plt_pat_valid" },
        })
      )
    ).resolves.toEqual({
      id: "pat_1",
      userId: "user_1",
      organizationId: null,
      projectId: null,
      environmentId: null,
      role: "write",
      expiresAt: expect.any(Date),
    });
    expect(prisma.platosCredentialAudit.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ action: "use", credentialId: "pat_1" }),
      })
    );
  });

  it("enforces read, write, and admin capabilities", () => {
    expect(patHasCapability("read", "read")).toBe(true);
    expect(patHasCapability("read", "write")).toBe(false);
    expect(patHasCapability("read", "admin")).toBe(false);
    expect(patHasCapability("write", "read")).toBe(true);
    expect(patHasCapability("write", "write")).toBe(true);
    expect(patHasCapability("write", "admin")).toBe(false);
    expect(patHasCapability("admin", "admin")).toBe(true);
  });

  it.each([
    ["read", "POST", false],
    ["write", "POST", true],
    ["write", "GET", true],
    ["write", "DELETE", true],
    ["admin", "DELETE", true],
  ] as const)("enforces %s capability on %s requests", async (role, method, allowed) => {
    const raw = `plt_pat_${role}_${method}`;
    prisma.platosPAT.findFirst.mockResolvedValue({
      id: "pat_1",
      tokenHash: crypto.createHash("sha256").update(raw).digest("hex"),
      userId: "user_1",
      organizationId: "org_1",
      projectId: null,
      environmentId: null,
      role,
      expiresAt: null,
      revokedAt: null,
    });

    const result = await authenticateApiRequestWithPAT(
      new Request("https://platos.example/api", {
        method,
        headers: { Authorization: `Bearer ${raw}` },
      })
    );
    expect(Boolean(result)).toBe(allowed);
  });

  it("requires explicit admin capability for admin routes", async () => {
    const raw = "plt_pat_admin_only";
    prisma.platosPAT.findFirst.mockResolvedValue({
      id: "pat_1",
      tokenHash: crypto.createHash("sha256").update(raw).digest("hex"),
      userId: "user_1",
      organizationId: "org_1",
      projectId: null,
      environmentId: null,
      role: "write",
      expiresAt: null,
      revokedAt: null,
    });

    await expect(
      authenticateApiRequestWithPAT(
        new Request("https://platos.example/admin", {
          headers: { Authorization: `Bearer ${raw}` },
        }),
        "admin"
      )
    ).resolves.toBeUndefined();
  });

  it("denies organization, project, environment, and broader-scope access", () => {
    const pat = {
      id: "pat_1",
      userId: "user_1",
      organizationId: "org_1",
      projectId: "project_1",
      environmentId: "env_1",
      role: "write" as const,
      expiresAt: null,
    };

    expect(
      patAllowsScope(pat, {
        organizationId: "org_1",
        projectId: "project_1",
        environmentId: "env_1",
      })
    ).toBe(true);
    expect(
      patAllowsScope(pat, {
        organizationId: "org_2",
        projectId: "project_1",
        environmentId: "env_1",
      })
    ).toBe(false);
    expect(
      patAllowsScope(pat, {
        organizationId: "org_1",
        projectId: "project_2",
        environmentId: "env_1",
      })
    ).toBe(false);
    expect(
      patAllowsScope(pat, {
        organizationId: "org_1",
        projectId: "project_1",
        environmentId: "env_2",
      })
    ).toBe(false);
    expect(patAllowsScope(pat, { organizationId: "org_1", projectId: "project_1" })).toBe(false);
  });

  it("rejects invalid scope hierarchy before mint", async () => {
    await expect(
      mintPAT({ userId: "user_1", name: "bad", projectId: "project_1" })
    ).rejects.toThrow(/requires an organization/i);
    await expect(
      mintPAT({ userId: "user_1", name: "bad", orgId: "org_1", envId: "env_1" })
    ).rejects.toThrow(/requires organization and project/i);
    expect(prisma.platosPAT.create).not.toHaveBeenCalled();
  });

  it("rejects scope pins outside the user's hierarchy", async () => {
    prisma.project.findFirst.mockResolvedValueOnce(null);
    await expect(
      mintPAT({
        userId: "user_1",
        name: "cross-project",
        orgId: "org_1",
        projectId: "project_other_org",
      })
    ).rejects.toThrow(/does not belong to the organization/i);

    prisma.runtimeEnvironment.findFirst.mockResolvedValueOnce(null);
    await expect(
      mintPAT({
        userId: "user_1",
        name: "cross-env",
        orgId: "org_1",
        projectId: "project_1",
        envId: "env_other_project",
      })
    ).rejects.toThrow(/does not belong to the project/i);
  });

  it("requires organization admin authority for admin PATs", async () => {
    await expect(
      mintPAT({ userId: "user_1", name: "unscoped admin", role: "admin" })
    ).rejects.toThrow(/requires an organization scope/i);

    prisma.orgMember.findFirst.mockResolvedValueOnce({ role: "MEMBER" });
    await expect(
      mintPAT({ userId: "user_1", name: "admin", role: "admin", orgId: "org_1" })
    ).rejects.toThrow(/requires organization admin/i);
  });

  it("does not audit expired or revoked credentials", async () => {
    prisma.platosPAT.findFirst.mockResolvedValue({
      id: "pat_1",
      tokenHash: "00".repeat(32),
      userId: "user_1",
      organizationId: null,
      projectId: null,
      environmentId: null,
      role: "write",
      expiresAt: null,
      revokedAt: new Date(),
    });

    await expect(verifyPAT("plt_pat_unknown")).resolves.toBeNull();
    expect(prisma.$transaction).not.toHaveBeenCalled();
    expect(prisma.platosCredentialAudit.create).not.toHaveBeenCalled();
  });

  it("denies use when lifecycle evidence cannot be persisted", async () => {
    const tokenHash = crypto.createHash("sha256").update("plt_pat_valid").digest("hex");
    prisma.platosPAT.findFirst.mockResolvedValue({
      id: "pat_1",
      tokenHash,
      userId: "user_1",
      organizationId: null,
      projectId: null,
      environmentId: null,
      role: "write",
      expiresAt: null,
      revokedAt: null,
    });
    prisma.platosCredentialAudit.create.mockRejectedValueOnce(new Error("audit unavailable"));

    await expect(verifyPAT("plt_pat_valid")).rejects.toThrow("audit unavailable");
  });

  it("denies use when revocation wins the transactional update race", async () => {
    const tokenHash = crypto.createHash("sha256").update("plt_pat_valid").digest("hex");
    prisma.platosPAT.findFirst.mockResolvedValue({
      id: "pat_1",
      tokenHash,
      userId: "user_1",
      organizationId: null,
      projectId: null,
      environmentId: null,
      role: "write",
      expiresAt: null,
      revokedAt: null,
    });
    prisma.platosPAT.updateMany.mockResolvedValue({ count: 0 });

    await expect(verifyPAT("plt_pat_valid")).resolves.toBeNull();
    expect(prisma.platosCredentialAudit.create).not.toHaveBeenCalled();
  });

  it("records only the first revoke", async () => {
    prisma.platosPAT.findFirst
      .mockResolvedValueOnce({
        id: "pat_1",
        revokedAt: null,
        organizationId: null,
        projectId: null,
        environmentId: null,
      })
      .mockResolvedValueOnce({
        id: "pat_1",
        revokedAt: new Date(),
        organizationId: null,
        projectId: null,
        environmentId: null,
      });
    prisma.platosPAT.updateMany.mockResolvedValue({ count: 1 });

    await expect(revokePAT("pat_1", "user_1")).resolves.toEqual({ ok: true });
    await expect(revokePAT("pat_1", "user_1")).resolves.toEqual({ ok: true });

    expect(prisma.platosCredentialAudit.create).toHaveBeenCalledTimes(1);
    expect(prisma.platosCredentialAudit.create).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ action: "revoke" }) })
    );
  });
});
