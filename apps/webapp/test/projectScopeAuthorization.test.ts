import { beforeEach, describe, expect, it, vi } from "vitest";

const { prisma, replica } = vi.hoisted(() => ({
  prisma: {
    organizationMembership: { findUnique: vi.fn() },
    projectMembership: { findUnique: vi.fn() },
  },
  replica: {},
}));

vi.mock("~/db.server", () => ({ prisma, $replica: replica }));
vi.mock("~/models/project.server", () => ({ findProjectBySlug: vi.fn() }));
vi.mock("~/models/runtimeEnvironment.server", () => ({ findEnvironmentById: vi.fn() }));

import { verifyProjectAccess } from "~/services/platos/scopeVerify.server";

const scope = { organizationId: "org_1", projectId: "project_1" };

describe("canonical project authorization", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    prisma.organizationMembership.findUnique.mockResolvedValue({
      id: "membership_1",
      role: "MEMBER",
      deactivatedAt: null,
    });
    prisma.projectMembership.findUnique.mockResolvedValue({ role: "VIEWER" });
  });

  it("allows metadata reads only with a membership in the requested project", async () => {
    await expect(verifyProjectAccess(scope, "user_1", "read")).resolves.toBe(true);
    prisma.projectMembership.findUnique.mockResolvedValueOnce(null);
    await expect(verifyProjectAccess(scope, "user_1", "read")).resolves.toBe(false);
    expect(prisma.projectMembership.findUnique).toHaveBeenLastCalledWith({
      where: {
        projectId_organizationMembershipId: {
          projectId: "project_1",
          organizationMembershipId: "membership_1",
        },
      },
      select: { role: true },
    });
  });

  it("requires Project ADMIN or Organization OWNER/ADMIN for mutation", async () => {
    await expect(verifyProjectAccess(scope, "user_1", "mutate")).resolves.toBe(false);

    prisma.projectMembership.findUnique.mockResolvedValueOnce({ role: "ADMIN" });
    await expect(verifyProjectAccess(scope, "user_1", "mutate")).resolves.toBe(true);

    prisma.organizationMembership.findUnique.mockResolvedValueOnce({
      id: "membership_1",
      role: "ADMIN",
      deactivatedAt: null,
    });
    prisma.projectMembership.findUnique.mockResolvedValueOnce(null);
    await expect(verifyProjectAccess(scope, "user_1", "mutate")).resolves.toBe(true);
  });

  it("rejects deactivated organization memberships before project role checks", async () => {
    prisma.organizationMembership.findUnique.mockResolvedValueOnce({
      id: "membership_1",
      role: "ADMIN",
      deactivatedAt: new Date(),
    });

    await expect(verifyProjectAccess(scope, "user_1", "mutate")).resolves.toBe(false);
    expect(prisma.projectMembership.findUnique).not.toHaveBeenCalled();
  });
});
