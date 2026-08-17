import { OrganizationRole, ProjectRole, type Project } from "@platos/database";
import { customAlphabet } from "nanoid";
import slug from "slug";
import { $replica, prisma } from "~/db.server";
import { createEnvironment } from "./organization.server";

export type { Project } from "@platos/database";

const suffix = customAlphabet("abcdefghijklmnopqrstuvwxyz0123456789", 6);

export class ExceededProjectLimitError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ExceededProjectLimitError";
  }
}

export async function createProject(
  { organizationId, name, userId }: { organizationId: string; name: string; userId: string },
  attemptCount = 0
) {
  const membership = await prisma.organizationMembership.findUnique({
    where: { organizationId_userId: { organizationId, userId } },
  });
  if (
    !membership ||
    membership.deactivatedAt ||
    ![OrganizationRole.OWNER, OrganizationRole.ADMIN].includes(membership.role)
  ) {
    throw new Response("Forbidden", { status: 403 });
  }
  if (attemptCount > 100) throw new Error("Unable to allocate a project slug");

  const normalizedName = name.trim();
  const projectSlug = `${slug(normalizedName)}-${suffix()}`;
  return prisma.$transaction(async (tx) => {
    const project = await tx.project.create({
      data: {
        organizationId,
        name: normalizedName,
        slug: projectSlug,
      },
      include: { organization: true },
    });
    await tx.projectMembership.create({
      data: {
        projectId: project.id,
        organizationId,
        organizationMembershipId: membership.id,
        role: ProjectRole.ADMIN,
      },
    });
    await createEnvironment({ project, name: "Development", slug: "dev", prismaClient: tx });
    await createEnvironment({ project, name: "Production", slug: "prod", prismaClient: tx });
    return project;
  });
}

export async function findProjectById(projectId: string, userId: string) {
  return $replica.project.findFirst({
    where: {
      id: projectId,
      archivedAt: null,
      organization: {
        archivedAt: null,
        memberships: { some: { userId, deactivatedAt: null } },
      },
    },
  });
}

export async function findProjectBySlug(orgSlug: string, projectSlug: string, userId: string) {
  return $replica.project.findFirst({
    where: {
      slug: projectSlug,
      archivedAt: null,
      organization: {
        slug: orgSlug,
        archivedAt: null,
        memberships: { some: { userId, deactivatedAt: null } },
      },
    },
  });
}
