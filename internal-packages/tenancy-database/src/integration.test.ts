import { execFileSync } from "node:child_process";
import { resolve } from "node:path";
import {
  Prisma,
  PrismaClient,
  PrincipalTier,
  OrganizationRole,
  ProjectRole,
} from "../generated/control";
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from "@testcontainers/postgresql";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { createEndUserClient, type EndUserClient } from "./end-user";

const future = () => new Date(Date.now() + 60 * 60 * 1000);

describe("tenancy schema integration", () => {
  let container: StartedPostgreSqlContainer;
  let control: PrismaClient;
  let endUser: EndUserClient;
  let records: Awaited<ReturnType<typeof seedEveryModel>>;

  beforeAll(async () => {
    container = await new PostgreSqlContainer("postgres:16-alpine").start();
    const databaseUrl = container.getConnectionUri();

    execFileSync(resolve(process.cwd(), "node_modules/.bin/prisma"), [
      "migrate",
      "deploy",
      "--schema",
      resolve(process.cwd(), "prisma/schema.prisma"),
    ], {
      cwd: process.cwd(),
      env: { ...process.env, DATABASE_URL: databaseUrl },
      stdio: "pipe",
    });

    control = new PrismaClient({ datasources: { db: { url: databaseUrl } } });
    endUser = createEndUserClient({ datasources: { db: { url: databaseUrl } } });
    records = await seedEveryModel(control);
  }, 120_000);

  afterAll(async () => {
    await endUser?.disconnect();
    await control?.$disconnect();
    await container?.stop();
  });

  test("round-trips every model in the authoritative schema", async () => {
    const reads = {
      User: await control.user.findUnique({ where: { id: records.user.id } }),
      OperatorSession: await control.operatorSession.findUnique({
        where: { id: records.operatorSession.id },
      }),
      Organization: await control.organization.findUnique({ where: { id: records.organization.id } }),
      OrganizationMembership: await control.organizationMembership.findUnique({
        where: { id: records.organizationMembership.id },
      }),
      OrganizationInvitation: await control.organizationInvitation.findUnique({
        where: { id: records.organizationInvitation.id },
      }),
      Project: await control.project.findUnique({ where: { id: records.project.id } }),
      ProjectMembership: await control.projectMembership.findUnique({
        where: { id: records.projectMembership.id },
      }),
      Environment: await control.environment.findUnique({ where: { id: records.environment.id } }),
      EnvironmentSession: await control.environmentSession.findUnique({
        where: { id: records.environmentSession.id },
      }),
      EndUser: await control.endUser.findUnique({ where: { id: records.endUser.id } }),
      EndUserIdentity: await control.endUserIdentity.findUnique({
        where: { id: records.endUserIdentity.id },
      }),
      EndUserSession: await control.endUserSession.findUnique({
        where: { id: records.endUserSession.id },
      }),
    };

    expect(Object.keys(reads).sort()).toEqual(
      Prisma.dmmf.datamodel.models.map((model) => model.name).sort()
    );
    for (const record of Object.values(reads)) {
      expect(record).not.toBeNull();
    }

    expect(reads.OrganizationMembership?.role).toBe(OrganizationRole.OWNER);
    expect(reads.ProjectMembership?.role).toBe(ProjectRole.ADMIN);
    expect(reads.OperatorSession?.tier).toBe(PrincipalTier.OPERATOR);
    expect(reads.EnvironmentSession?.tier).toBe(PrincipalTier.OPERATOR);
    expect(reads.EndUserSession?.tier).toBe(PrincipalTier.END_USER);
  });

  test("exposes no operator query or raw SQL path from the end-user client", async () => {
    expect(Object.keys(endUser).sort()).toEqual([
      "disconnect",
      "endUser",
      "endUserIdentity",
      "endUserSession",
    ]);
    expect("user" in endUser).toBe(false);
    expect("organization" in endUser).toBe(false);
    expect("$queryRaw" in endUser).toBe(false);
    expect("$transaction" in endUser).toBe(false);

    const visibleSession = await endUser.endUserSession.findUnique({
      where: { id: records.endUserSession.id },
      include: { identity: { include: { endUser: true } } },
    });
    expect(visibleSession?.identity.endUser.id).toBe(records.endUser.id);

    await expect(
      endUser.endUserSession.findMany({ include: { environment: true } } as never)
    ).rejects.toThrow();

    if (false) {
      // @ts-expect-error The restricted client has no operator delegate.
      endUser.user;
      // @ts-expect-error Environment is deliberately not a data-plane relation.
      endUser.endUserSession.findMany({ include: { environment: true } });
    }
  });

  test("rejects a project grant whose membership belongs to another organization", async () => {
    const otherOrganization = await control.organization.create({
      data: { slug: "other-organization", name: "Other organization" },
    });
    const otherProject = await control.project.create({
      data: {
        organizationId: otherOrganization.id,
        slug: "other-project",
        name: "Other project",
      },
    });

    await expect(
      control.projectMembership.create({
        data: {
          projectId: otherProject.id,
          organizationMembershipId: records.organizationMembership.id,
          organizationId: records.organization.id,
          role: ProjectRole.VIEWER,
        },
      })
    ).rejects.toThrow();
  });

  test("rejects end-user sessions outside the identity organization", async () => {
    const otherOrganization = await control.organization.create({
      data: { slug: "session-other-organization", name: "Session other organization" },
    });
    const otherProject = await control.project.create({
      data: {
        organizationId: otherOrganization.id,
        slug: "session-other-project",
        name: "Session other project",
      },
    });
    const otherEnvironment = await control.environment.create({
      data: { projectId: otherProject.id, slug: "isolated", name: "Isolated" },
    });

    await expect(
      endUser.endUserSession.create({
        data: {
          identityId: records.endUserIdentity.id,
          environmentId: otherEnvironment.id,
          tokenHash: "cross-organization-session-token",
          expiresAt: future(),
        },
      })
    ).rejects.toThrow();

    await expect(
      control.endUserSession.findUnique({ where: { tokenHash: "cross-organization-session-token" } })
    ).resolves.toBeNull();
  });

  test("rejects parent reparenting that would make an existing end-user session cross-organization", async () => {
    const otherOrganization = await control.organization.create({
      data: { slug: "reparent-other-organization", name: "Reparent other organization" },
    });
    const otherProject = await control.project.create({
      data: {
        organizationId: otherOrganization.id,
        slug: "reparent-other-project",
        name: "Reparent other project",
      },
    });
    const guardedProject = await control.project.create({
      data: {
        organizationId: records.organization.id,
        slug: "guarded-project",
        name: "Guarded project",
      },
    });
    const sameOrganizationProject = await control.project.create({
      data: {
        organizationId: records.organization.id,
        slug: "same-organization-project",
        name: "Same organization project",
      },
    });
    const guardedEnvironment = await control.environment.create({
      data: { projectId: guardedProject.id, slug: "guarded", name: "Guarded" },
    });
    const guardedSession = await control.endUserSession.create({
      data: {
        identityId: records.endUserIdentity.id,
        environmentId: guardedEnvironment.id,
        tokenHash: "guarded-parent-chain-session",
        expiresAt: future(),
      },
    });

    await expect(
      control.environment.update({
        where: { id: guardedEnvironment.id },
        data: { projectId: otherProject.id },
      })
    ).rejects.toThrow();
    await expect(
      control.project.update({
        where: { id: guardedProject.id },
        data: { organizationId: otherOrganization.id },
      })
    ).rejects.toThrow();
    await expect(
      control.endUser.update({
        where: { id: records.endUser.id },
        data: { organizationId: otherOrganization.id },
      })
    ).rejects.toThrow();

    await expect(
      control.environment.update({
        where: { id: guardedEnvironment.id },
        data: { projectId: sameOrganizationProject.id },
      })
    ).resolves.toMatchObject({ projectId: sameOrganizationProject.id });

    await expect(
      control.endUserSession.findUnique({
        where: { id: guardedSession.id },
        include: { environment: { include: { project: true } }, identity: { include: { endUser: true } } },
      })
    ).resolves.toMatchObject({
      environment: { project: { organizationId: records.organization.id } },
      identity: { endUser: { organizationId: records.organization.id } },
    });
  });

  test("enforces each session tier with database constraints", async () => {
    await expect(
      endUser.endUserSession.create({
        data: {
          identityId: records.endUserIdentity.id,
          environmentId: records.environment.id,
          tokenHash: "wrong-end-user-tier",
          tier: PrincipalTier.OPERATOR,
          expiresAt: future(),
        },
      })
    ).rejects.toThrow();

    await expect(
      control.operatorSession.create({
        data: {
          userId: records.user.id,
          tokenHash: "wrong-operator-tier",
          tier: PrincipalTier.END_USER,
          expiresAt: future(),
        },
      })
    ).rejects.toThrow();
  });
});

async function seedEveryModel(control: PrismaClient) {
  const user = await control.user.create({
    data: { email: "owner@example.test", displayName: "Owner" },
  });
  const operatorSession = await control.operatorSession.create({
    data: { userId: user.id, tokenHash: "operator-session-token", expiresAt: future() },
  });
  const organization = await control.organization.create({
    data: { slug: "round-trip-organization", name: "Round-trip organization" },
  });
  const organizationMembership = await control.organizationMembership.create({
    data: { organizationId: organization.id, userId: user.id, role: OrganizationRole.OWNER },
  });
  const organizationInvitation = await control.organizationInvitation.create({
    data: {
      organizationId: organization.id,
      inviterId: user.id,
      email: "invitee@example.test",
      role: OrganizationRole.MEMBER,
      tokenHash: "organization-invitation-token",
      expiresAt: future(),
    },
  });
  const project = await control.project.create({
    data: { organizationId: organization.id, slug: "round-trip-project", name: "Round-trip project" },
  });
  const projectMembership = await control.projectMembership.create({
    data: {
      projectId: project.id,
      organizationMembershipId: organizationMembership.id,
      organizationId: organization.id,
      role: ProjectRole.ADMIN,
    },
  });
  const environment = await control.environment.create({
    data: { projectId: project.id, slug: "isolated", name: "Isolated" },
  });
  const environmentSession = await control.environmentSession.create({
    data: {
      environmentId: environment.id,
      operatorSessionId: operatorSession.id,
      ipAddress: "127.0.0.1",
      userAgent: "tenancy-integration-test",
    },
  });
  const endUser = await control.endUser.create({
    data: { organizationId: organization.id, displayName: "End user" },
  });
  const endUserIdentity = await control.endUserIdentity.create({
    data: {
      endUserId: endUser.id,
      organizationId: organization.id,
      issuer: "integration-test",
      channel: "web",
      subject: "end-user-subject",
      verifiedAt: new Date(),
    },
  });
  const endUserSession = await control.endUserSession.create({
    data: {
      identityId: endUserIdentity.id,
      environmentId: environment.id,
      tokenHash: "end-user-session-token",
      expiresAt: future(),
    },
  });

  return {
    user,
    operatorSession,
    organization,
    organizationMembership,
    organizationInvitation,
    project,
    projectMembership,
    environment,
    environmentSession,
    endUser,
    endUserIdentity,
    endUserSession,
  };
}
