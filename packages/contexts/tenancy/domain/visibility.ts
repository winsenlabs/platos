// Which projects an operator can see, and which organizations are theirs.
//
// WHY THIS FILE EXISTS. `apps/webapp/app/services/projectAccess.server.ts`
// expressed an AUTHORIZATION RULE as a `Prisma.ProjectWhereInput`:
//
//     archivedAt: null,
//     OR: [
//       { organization: { memberships: { some: {
//           userId, deactivatedAt: null, role: { in: [OWNER, ADMIN] } } } } },
//       { memberships: { some: {
//           organizationMembership: { userId, deactivatedAt: null } } } },
//     ]
//
// An authorization decision that exists only as a query fragment cannot be
// unit-tested, cannot be reused by a transport that is not Prisma, and cannot be
// audited against the four-gate model next door in `authorization.ts`. The QUERY
// is not ported here — the RULE is, as a predicate over rows, so that the shape
// of the eventual SQL is an adapter's business and the decision is tenancy's.
//
// WHAT THE RULE ACTUALLY SAYS, and it is not the same as the four gates:
//
//   * an organization OWNER or ADMIN sees EVERY unarchived project in the
//     organization, with no project membership — the same blanket grant gate 3
//     of `decideEnvironmentAccess` gives them; and
//   * anybody else sees exactly the projects they hold a `ProjectMembership` on,
//     and only while their ORGANIZATION membership is active. Deactivating a
//     member therefore hides every project at once, without touching a single
//     `ProjectMembership` row — which is why the deactivation clause sits on the
//     organization membership in both arms rather than on the project one.
//
// WHAT IT DOES NOT SAY. The fragment carries `archivedAt: null` for the PROJECT
// and says nothing about the organization: as a `ProjectWhereInput` it is
// composed under a membership query that has already required
// `organization: { archivedAt: null }`. The predicate below is faithful to the
// fragment and stops at the project; the organization filter is applied by the
// read model, where the route applies it. Splitting it any other way would make
// this predicate disagree with the rule it is a port of.

import { isOrganizationArchived, type OrganizationRecord } from "./organization.js";
import { isActiveMembership, type OrganizationMembershipRecord, type ProjectMembershipRecord } from "./membership.js";
import { isProjectArchived, type ProjectRecord } from "./project.js";
import { isOrganizationAdmin } from "./roles.js";
import type { UserId } from "./identifiers.js";

/**
 * WHY a project is visible.
 *
 * Two arms of one `OR` are two different grants, and a caller that cannot tell
 * them apart cannot render "you are an admin here" differently from "you were
 * added to this project". It is also what stops a test asserting mere visibility
 * from passing when the wrong arm fired.
 */
export type ProjectVisibility = "organization-admin" | "project-membership";

export interface ProjectVisibilityInput {
  readonly project: ProjectRecord;
  /** The viewer's membership in the PROJECT's organization, or null. */
  readonly organizationMembership: OrganizationMembershipRecord | null;
  /** Every project membership held through that organization membership. */
  readonly projectMemberships: readonly ProjectMembershipRecord[];
}

/**
 * The ported rule. `null` means not visible.
 *
 * The order of the two arms is deliberate: the admin grant is checked first, so
 * an admin who ALSO holds a project membership is reported as an admin. That
 * matches the `OR`, where a row satisfying both arms is returned once.
 */
export function projectVisibility(input: ProjectVisibilityInput): ProjectVisibility | null {
  if (isProjectArchived(input.project)) return null;

  const membership = input.organizationMembership;
  if (membership === null || !isActiveMembership(membership)) return null;
  if (membership.organizationId !== input.project.organizationId) return null;

  if (isOrganizationAdmin(membership.role)) return "organization-admin";

  const held = input.projectMemberships.some(
    (row) =>
      row.projectId === input.project.id && row.organizationMembershipId === membership.id,
  );
  return held ? "project-membership" : null;
}

/**
 * Whether an organization belongs on an operator's own list.
 *
 * This is the `_app._index` membership query, which is a DIFFERENT rule from the
 * one above: it takes any role, and it is the place the archived-organization
 * filter lives.
 */
export function organizationIsListable(
  organization: OrganizationRecord,
  membership: OrganizationMembershipRecord,
  userId: UserId,
): boolean {
  return (
    membership.userId === userId &&
    membership.organizationId === organization.id &&
    isActiveMembership(membership) &&
    !isOrganizationArchived(organization)
  );
}
