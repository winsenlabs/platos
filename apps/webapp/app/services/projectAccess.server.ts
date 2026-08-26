import { OrganizationRole, type Prisma } from "@platos/tenancy-database";

/**
 * Organization OWNER/ADMIN may access every active Project. Other active
 * Organization members must hold an explicit membership for the Project.
 */
export function operatorVisibleProjectWhere(userId: string): Prisma.ProjectWhereInput {
  return {
    archivedAt: null,
    OR: [
      {
        organization: {
          memberships: {
            some: {
              userId,
              deactivatedAt: null,
              role: { in: [OrganizationRole.OWNER, OrganizationRole.ADMIN] },
            },
          },
        },
      },
      {
        memberships: {
          some: {
            organizationMembership: { userId, deactivatedAt: null },
          },
        },
      },
    ],
  };
}
