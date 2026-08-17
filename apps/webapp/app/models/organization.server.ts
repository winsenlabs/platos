import { OrganizationRole, type Environment, type Organization, type Project, type User } from "@platos/database";
import { customAlphabet } from "nanoid";
import slug from "slug";
import { prisma, type PrismaClientOrTransaction } from "~/db.server";

export type { Organization } from "@platos/database";

const suffix = customAlphabet("1234567890abcdef", 6);

export async function createOrganization(
  { name, userId }: { name: string; userId: User["id"] },
  attemptCount = 0
): Promise<Organization> {
  if (attemptCount > 100) throw new Error("Unable to allocate an organization slug");
  const normalizedName = name.trim();
  const organizationSlug = `${slug(normalizedName)}-${suffix()}`;
  try {
    return await prisma.organization.create({
      data: {
        name: normalizedName,
        slug: organizationSlug,
        memberships: {
          create: { userId, role: OrganizationRole.OWNER },
        },
      },
    });
  } catch (error) {
    if (attemptCount < 100) return createOrganization({ name: normalizedName, userId }, attemptCount + 1);
    throw error;
  }
}

export async function createEnvironment({
  project,
  name,
  slug: environmentSlug,
  prismaClient = prisma,
}: {
  project: Pick<Project, "id">;
  name: string;
  slug: string;
  prismaClient?: PrismaClientOrTransaction;
}): Promise<Environment> {
  return prismaClient.environment.create({
    data: {
      projectId: project.id,
      name: name.trim(),
      slug: slug(environmentSlug),
    },
  });
}
