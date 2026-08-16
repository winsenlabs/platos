import { describe, expect, it, vi } from "vitest";
import type { ControlDatabaseClient } from "../shared/database.provider";
import { EnvironmentService } from "./environment.service";
import { OrganizationService } from "./organization.service";

const scope = {
  organizationId: "org-a",
  projectId: "project-a",
  environmentId: "env-a",
};

function organizationService(prisma: Record<string, unknown>) {
  return new OrganizationService(prisma as unknown as ControlDatabaseClient);
}

function environmentService(prisma: Record<string, unknown>) {
  return new EnvironmentService(prisma, { invalidate: vi.fn() } as any);
}

describe("admin canonical organization tenancy", () => {
  it("lists only active memberships and projects public fields from the canonical Organization", async () => {
    const createdAt = new Date("2026-08-15T00:00:00.000Z");
    const findMany = vi.fn().mockResolvedValue([
      {
        role: "OWNER",
        organization: {
          id: "org-a",
          slug: "acme",
          name: "Acme",
          createdAt,
          updatedAt: createdAt,
          archivedAt: null,
        },
      },
    ]);
    const service = organizationService({
      organizationMembership: { findMany },
    });

    await expect(service.listForUser("user-a")).resolves.toEqual([
      {
        id: "org-a",
        slug: "acme",
        title: "Acme",
        createdAt,
        updatedAt: createdAt,
        deletedAt: null,
        companySize: null,
        memberRole: "ADMIN",
      },
    ]);
    expect(findMany).toHaveBeenCalledWith({
      where: {
        userId: "user-a",
        deactivatedAt: null,
        organization: { archivedAt: null },
      },
      select: {
        role: true,
        organization: {
          select: {
            id: true,
            slug: true,
            name: true,
            createdAt: true,
            updatedAt: true,
            archivedAt: true,
          },
        },
      },
      orderBy: { organization: { name: "asc" } },
    });
  });

  it("counts only active members and live invitations before creating an invite", async () => {
    const membershipFindFirst = vi
      .fn()
      .mockResolvedValueOnce({ role: "ADMIN" })
      .mockResolvedValueOnce(null);
    const membershipCount = vi.fn().mockResolvedValue(0);
    const invitationCount = vi.fn().mockResolvedValue(0);
    const invitationFindFirst = vi.fn().mockResolvedValue(null);
    const invitationCreate = vi.fn().mockResolvedValue({
      id: "invite-a",
      email: "new@example.com",
      role: "MEMBER",
    });
    const service = organizationService({
      organizationMembership: {
        findFirst: membershipFindFirst,
        count: membershipCount,
      },
      organizationInvitation: {
        findFirst: invitationFindFirst,
        count: invitationCount,
        create: invitationCreate,
      },
    });

    await expect(
      service.addMemberInvite("org-a", "admin-a", {
        email: " New@Example.com ",
      }),
    ).resolves.toEqual({
      id: "invite-a",
      email: "new@example.com",
      role: "MEMBER",
    });

    expect(membershipCount).toHaveBeenCalledWith({
      where: { organizationId: "org-a", deactivatedAt: null },
    });
    expect(invitationCount).toHaveBeenCalledWith({
      where: {
        organizationId: "org-a",
        acceptedAt: null,
        revokedAt: null,
        expiresAt: { gt: expect.any(Date) },
      },
    });
    const createData = invitationCreate.mock.calls[0][0].data;
    expect(createData).toMatchObject({
      organizationId: "org-a",
      email: "new@example.com",
      inviterId: "admin-a",
      role: "MEMBER",
      tokenHash: expect.stringMatching(/^[a-f0-9]{64}$/),
      expiresAt: expect.any(Date),
    });
    expect(JSON.stringify(createData)).not.toContain("plt_inv_");
  });

  it("protects the last OWNER or ADMIN using the active canonical membership count", async () => {
    const count = vi.fn().mockResolvedValue(1);
    const remove = vi.fn();
    const findFirst = vi
      .fn()
      .mockResolvedValueOnce({ role: "OWNER" })
      .mockResolvedValueOnce({ id: "member-a", role: "ADMIN" });
    const service = organizationService({
      organizationMembership: { findFirst, count, delete: remove },
    });

    await expect(
      service.removeMember("org-a", "owner-a", { memberId: "member-a" }),
    ).rejects.toThrow("last_admin_protected");
    expect(count).toHaveBeenCalledWith({
      where: {
        organizationId: "org-a",
        deactivatedAt: null,
        role: { in: ["OWNER", "ADMIN"] },
      },
    });
    expect(remove).not.toHaveBeenCalled();
  });
});

describe("admin canonical Environment tenancy", () => {
  it("lists Environments through persisted Project and Organization ancestry", async () => {
    const findMany = vi.fn().mockResolvedValue([
      {
        id: "env-a",
        slug: "development",
        name: "Development",
        createdAt: new Date("2026-08-15T00:00:00.000Z"),
        updatedAt: new Date("2026-08-15T01:00:00.000Z"),
        archivedAt: null,
      },
    ]);
    const service = environmentService({
      organizationMembership: {
        findFirst: vi.fn().mockResolvedValue({ id: "membership-a" }),
      },
      environment: { findMany },
    });

    const result = await service.list(scope, "user-a");

    expect(result).toHaveLength(1);
    expect(findMany).toHaveBeenCalledWith({
      where: {
        projectId: "project-a",
        project: { organizationId: "org-a" },
        archivedAt: null,
      },
      orderBy: { slug: "asc" },
      select: {
        id: true,
        slug: true,
        name: true,
        createdAt: true,
        updatedAt: true,
        archivedAt: true,
      },
    });
  });

  it("creates an Environment only after resolving the canonical Project ancestry", async () => {
    const projectFindFirst = vi.fn().mockResolvedValue({ id: "project-a" });
    const create = vi.fn().mockResolvedValue({
      id: "env-b",
      slug: "preview",
      name: "preview",
      createdAt: new Date("2026-08-15T00:00:00.000Z"),
    });
    const service = environmentService({
      organizationMembership: {
        findFirst: vi.fn().mockResolvedValue({ role: "OWNER" }),
      },
      project: { findFirst: projectFindFirst },
      environment: { create },
    });

    await service.create(scope, "owner-a", { slug: " Preview " });

    expect(projectFindFirst).toHaveBeenCalledWith({
      where: {
        id: "project-a",
        organizationId: "org-a",
        archivedAt: null,
      },
      select: { id: true },
    });
    expect(create).toHaveBeenCalledWith({
      data: {
        slug: "preview",
        name: "preview",
        projectId: "project-a",
      },
      select: {
        id: true,
        slug: true,
        name: true,
        createdAt: true,
      },
    });
  });

  it("counts active AgentBindings and Threads with the full Environment ancestry before archive", async () => {
    const bindingCount = vi.fn().mockResolvedValue(0);
    const threadCount = vi.fn().mockResolvedValue(0);
    const update = vi.fn().mockResolvedValue({ id: "env-a" });
    const service = environmentService({
      organizationMembership: {
        findFirst: vi.fn().mockResolvedValue({ role: "ADMIN" }),
      },
      environment: {
        findFirst: vi.fn().mockResolvedValue({
          id: "env-a",
          archivedAt: null,
          slug: "development",
        }),
        update,
      },
      agentBinding: { count: bindingCount },
      thread: { count: threadCount },
    });

    await expect(
      service.deleteEnvironment(scope, "admin-a", { environmentId: "env-a" }),
    ).resolves.toEqual({ archived: true });

    const ancestry = {
      project: { id: "project-a", organizationId: "org-a" },
    };
    expect(bindingCount).toHaveBeenCalledWith({
      where: {
        environmentId: "env-a",
        environment: ancestry,
        agent: { projectId: "project-a", isActive: true },
      },
    });
    expect(threadCount).toHaveBeenCalledWith({
      where: {
        environmentId: "env-a",
        environment: ancestry,
        archivedAt: null,
      },
    });
    expect(update).toHaveBeenCalledWith({
      where: { id: "env-a" },
      data: { archivedAt: expect.any(Date) },
    });
  });

  it("does not archive while an active AgentBinding exists", async () => {
    const update = vi.fn();
    const service = environmentService({
      organizationMembership: {
        findFirst: vi.fn().mockResolvedValue({ role: "OWNER" }),
      },
      environment: {
        findFirst: vi.fn().mockResolvedValue({
          id: "env-a",
          archivedAt: null,
          slug: "development",
        }),
        update,
      },
      agentBinding: { count: vi.fn().mockResolvedValue(2) },
      thread: { count: vi.fn().mockResolvedValue(4) },
    });

    await expect(
      service.deleteEnvironment(scope, "owner-a", { environmentId: "env-a" }),
    ).rejects.toThrow("env_in_use_by_agents:2");
    expect(update).not.toHaveBeenCalled();
  });
});
