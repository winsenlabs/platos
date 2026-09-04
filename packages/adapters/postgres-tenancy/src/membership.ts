// Organization and project membership, over PostgreSQL.
//
// THE TENANT IS IN THE KEY, NOT IN A CHECK AFTERWARDS. Every lookup here that
// takes an organization uses a compound unique index that CONTAINS the
// organization: `@@unique([organizationId, userId])` and `@@unique([id,
// organizationId])` for organization memberships, `@@unique([projectId,
// organizationMembershipId])` for project ones. A `findUnique({ where: { id } })`
// followed by `row.organizationId === organizationId` would answer the same
// questions with the same values and would have already loaded a row belonging
// to another tenant — and the guard doing the comparing is one careless edit
// from being gone. The schema's own `ProjectMembership` comment calls
// `organizationId` an "integrity key" for the same reason.
//
// `countActiveOwners` READS THROUGH `reader()`, WHICH IS WHY IT IS CORRECT. The
// port says it is "read under the organization row lock", and the port gives it
// no transaction parameter, so the only way it can be inside the caller's
// transaction — and therefore behind the caller's lock — is the ambient frame
// `transaction.ts` maintains. A version of this method that took the pooled
// client would return a count from outside the lock, and the last-owner race
// would be open again with every test still green.

import type {
  OrganizationId,
  OrganizationMembershipId,
  OrganizationMembershipRecord,
  OrganizationMembershipUpsert,
  ProjectId,
  ProjectMembershipRecord,
  TransactionScope,
  UserId,
} from "@platos/context-tenancy/application/ports/index.js";
import { OrganizationRole } from "@platos/context-tenancy/application/ports/index.js";

import { toOrganizationMembership, toProjectMembership } from "./mapping.js";
import { LIST_ORDER } from "./tree.js";
import type { TenancyTransactions } from "./transaction.js";

export function createMembershipRepository(transactions: TenancyTransactions) {
  return {
    async findOrganizationMembershipByUser(
      organizationId: OrganizationId,
      userId: UserId,
    ): Promise<OrganizationMembershipRecord | null> {
      const row = await transactions.reader().organizationMembership.findUnique({
        where: { organizationId_userId: { organizationId, userId } },
      });
      return row === null ? null : toOrganizationMembership(row);
    },

    async findOrganizationMembershipById(
      organizationId: OrganizationId,
      membershipId: OrganizationMembershipId,
    ): Promise<OrganizationMembershipRecord | null> {
      const row = await transactions.reader().organizationMembership.findUnique({
        where: { id_organizationId: { id: membershipId, organizationId } },
      });
      return row === null ? null : toOrganizationMembership(row);
    },

    async countActiveOwners(organizationId: OrganizationId): Promise<number> {
      return await transactions.reader().organizationMembership.count({
        where: { organizationId, deactivatedAt: null, role: OrganizationRole.OWNER },
      });
    },

    async listOrganizationMembershipsForUser(
      userId: UserId,
    ): Promise<readonly OrganizationMembershipRecord[]> {
      // Deactivated rows INCLUDED, exactly as the port says. The rule that a
      // removed member sees nothing lives in the read model, and a filter here
      // would make deleting that rule invisible to every test that covers it.
      const rows = await transactions
        .reader()
        .organizationMembership.findMany({ where: { userId }, orderBy: [...LIST_ORDER] });
      return rows.map(toOrganizationMembership);
    },

    async listProjectMembershipsForMembership(
      organizationMembershipId: OrganizationMembershipId,
    ): Promise<readonly ProjectMembershipRecord[]> {
      const rows = await transactions.reader().projectMembership.findMany({
        where: { organizationMembershipId },
        orderBy: [...LIST_ORDER],
      });
      return rows.map(toProjectMembership);
    },

    async findProjectMembership(
      projectId: ProjectId,
      organizationMembershipId: OrganizationMembershipId,
    ): Promise<ProjectMembershipRecord | null> {
      const row = await transactions.reader().projectMembership.findUnique({
        where: { projectId_organizationMembershipId: { projectId, organizationMembershipId } },
      });
      return row === null ? null : toProjectMembership(row);
    },

    async saveOrganizationMembership(
      membership: OrganizationMembershipRecord,
      transaction: TransactionScope,
    ): Promise<void> {
      const data = {
        organizationId: membership.organizationId,
        userId: membership.userId,
        role: membership.role,
        deactivatedAt: membership.deactivatedAt,
        createdAt: membership.createdAt,
        updatedAt: membership.updatedAt,
      };
      await transactions.writer(transaction).organizationMembership.upsert({
        where: { id: membership.id },
        create: { id: membership.id, ...data },
        update: data,
      });
    },

    async upsertOrganizationMembership(
      upsert: OrganizationMembershipUpsert,
      transaction: TransactionScope,
    ): Promise<OrganizationMembershipRecord> {
      // Keyed on `@@unique([organizationId, userId])`, so a concurrent accept of
      // two invitations for one address resolves in the index rather than in a
      // read-then-write window. Reactivation is part of the same statement: an
      // accepted invitation restores a removed member at the invited role.
      const row = await transactions.writer(transaction).organizationMembership.upsert({
        where: {
          organizationId_userId: { organizationId: upsert.organizationId, userId: upsert.userId },
        },
        create: {
          organizationId: upsert.organizationId,
          userId: upsert.userId,
          role: upsert.role,
          deactivatedAt: null,
          createdAt: upsert.at,
          updatedAt: upsert.at,
        },
        update: { role: upsert.role, deactivatedAt: null, updatedAt: upsert.at },
      });
      return toOrganizationMembership(row);
    },

    async saveProjectMembership(
      membership: ProjectMembershipRecord,
      transaction: TransactionScope,
    ): Promise<void> {
      const data = {
        projectId: membership.projectId,
        organizationMembershipId: membership.organizationMembershipId,
        organizationId: membership.organizationId,
        role: membership.role,
        createdAt: membership.createdAt,
        updatedAt: membership.updatedAt,
      };
      await transactions.writer(transaction).projectMembership.upsert({
        where: { id: membership.id },
        create: { id: membership.id, ...data },
        update: data,
      });
    },
  };
}
