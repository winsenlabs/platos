// Membership: the two join rows that put a user inside the tenant tree.
//
// `OrganizationMembership` is the grant. `ProjectMembership` narrows it, and
// carries a database-enforced cross-tenant integrity key.

import type { OrganizationId, ProjectId } from "@platos/kernel";
import { err, ok, type Result } from "@platos/kernel";

import { crossTenantMembership } from "./errors.js";
import type {
  OrganizationMembershipId,
  ProjectMembershipId,
  UserId,
} from "./identifiers.js";
import type { ProjectRecord } from "./project.js";
import type { OrganizationRole, ProjectRole } from "./roles.js";

export interface OrganizationMembershipRecord {
  readonly id: OrganizationMembershipId;
  readonly organizationId: OrganizationId;
  readonly userId: UserId;
  readonly role: OrganizationRole;
  /**
   * Deactivation, not deletion. `@@unique([organizationId, userId])` means a
   * removed member's row must survive so re-inviting the same address reuses
   * it; `acceptInvitation` upserts with `deactivatedAt: null`, which is a
   * reactivation of this exact row.
   */
  readonly deactivatedAt: Date | null;
  readonly createdAt: Date;
  readonly updatedAt: Date;
}

/**
 * `ProjectMembership`.
 *
 * `organizationId` LOOKS REDUNDANT AND IS NOT. It is derivable from either
 * parent, and the schema stores it anyway so that two composite foreign keys
 * can both derive AND verify it against the two parents at once:
 *
 *   project                @relation(fields: [projectId, organizationId],
 *                                    references: [id, organizationId])
 *   organizationMembership @relation(fields: [organizationMembershipId, organizationId],
 *                                    references: [id, organizationId])
 *
 * Postgres therefore refuses, at insert time, any row that grants a member of
 * organization A a role on a project belonging to organization B. That is a
 * DB-ENFORCED INVARIANT, not an application rule, and it is restated in this
 * domain (see `checkProjectMembershipIntegrity`) because an in-memory use case
 * has no foreign keys and a future read model has none either.
 */
export interface ProjectMembershipRecord {
  readonly id: ProjectMembershipId;
  readonly projectId: ProjectId;
  readonly organizationMembershipId: OrganizationMembershipId;
  /** Integrity key. Must equal the project's AND the membership's organization. */
  readonly organizationId: OrganizationId;
  readonly role: ProjectRole;
  readonly createdAt: Date;
  readonly updatedAt: Date;
}

export function isActiveMembership(membership: OrganizationMembershipRecord): boolean {
  return membership.deactivatedAt === null;
}

export function deactivateMembership(
  membership: OrganizationMembershipRecord,
  at: Date,
): OrganizationMembershipRecord {
  if (membership.deactivatedAt !== null) return membership;
  return { ...membership, deactivatedAt: at, updatedAt: at };
}

export function reactivateMembership(
  membership: OrganizationMembershipRecord,
  role: OrganizationRole,
  at: Date,
): OrganizationMembershipRecord {
  return { ...membership, role, deactivatedAt: null, updatedAt: at };
}

export function withOrganizationRole(
  membership: OrganizationMembershipRecord,
  role: OrganizationRole,
  at: Date,
): OrganizationMembershipRecord {
  if (membership.role === role) return membership;
  return { ...membership, role, updatedAt: at };
}

/**
 * The application-layer restatement of the two composite foreign keys.
 *
 * Both parents must agree with the candidate's integrity key, and with each
 * other. Checking only one parent would let a membership pointing at a project
 * in organization A carry organization B's id and satisfy the other side.
 */
export function checkProjectMembershipIntegrity(
  candidate: ProjectMembershipRecord,
  project: ProjectRecord,
  organizationMembership: OrganizationMembershipRecord,
): Result<ProjectMembershipRecord> {
  const agrees =
    candidate.organizationId === project.organizationId &&
    candidate.organizationId === organizationMembership.organizationId &&
    candidate.projectId === project.id &&
    candidate.organizationMembershipId === organizationMembership.id;
  if (!agrees) {
    return err(
      crossTenantMembership({
        projectOrganizationId: project.organizationId,
        membershipOrganizationId: organizationMembership.organizationId,
        declaredOrganizationId: candidate.organizationId,
      }),
    );
  }
  return ok(candidate);
}

/** Count active owners — the input to the last-owner invariant. */
export function countActiveOwners(
  memberships: readonly OrganizationMembershipRecord[],
  organizationId: OrganizationId,
  owner: OrganizationRole,
): number {
  return memberships.filter(
    (membership) =>
      membership.organizationId === organizationId &&
      membership.deactivatedAt === null &&
      membership.role === owner,
  ).length;
}
