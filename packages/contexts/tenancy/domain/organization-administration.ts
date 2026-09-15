// Who may administer an organization's MEMBERSHIP LIST — invite into it, and read
// it — and the one answer to "why not".
//
// TWO USE CASES ASK THE SAME QUESTION, AND IT IS ANSWERED ONCE, HERE.
//
//   issueInvitation            D1 (2026-09-15): "Only an ACTIVE member with the
//                              role OWNER or ADMIN of the target organization may
//                              issue an invitation. Any other caller is refused
//                              with a distinct code. The rule lives in the tenancy
//                              application, not in a transport." Neither oracle
//                              function had a rule; the only gate was the Remix
//                              invite route's `organization.findFirst` over
//                              OWNER/ADMIN memberships, and D1 chose to mirror it.
//
//   listOrganizationMembers    PORTED, not chosen. `settings.team`'s loader runs
//                              the same `findFirst` with `archivedAt: null` and
//                              answers 403 when it finds nothing.
//
// THE GATES ARE NAMED AND THE CODE IS NOT SHARED. Each caller mints its own code
// (`TENANCY_INVITATION_FORBIDDEN`, `TENANCY_MEMBER_LIST_FORBIDDEN`) so a log line
// says which operation refused, and the GATE travels in `details`, which the
// kernel documents as log-only. On the wire every gate is one answer — exactly the
// property the oracle's single query gave: a caller cannot use either route to
// learn whether an organization exists, is archived, or merely has not admitted
// them. A FORGED organization id (a real admin of organization B naming A) and a
// non-existent one are therefore the same 403, and neither is a 404.

import type { OrganizationMembershipRecord } from "./membership.js";
import { isActiveMembership } from "./membership.js";
import type { OrganizationRecord } from "./organization.js";
import { isOrganizationArchived } from "./organization.js";
import { isOrganizationAdmin } from "./roles.js";

/** Why an administration request was refused. Log-only; never on the wire. */
export type AdministrationGate =
  | "no-such-organization"
  | "organization-archived"
  | "not-a-member"
  | "membership-deactivated"
  | "not-an-administrator";

/**
 * The gate that closes, or null when the actor administers the organization.
 *
 * ORDER IS THE ORACLE'S QUERY, READ OUTSIDE-IN: the organization must exist and be
 * live, the actor must hold a membership IN IT (the lookup is keyed by the
 * organization, so a membership elsewhere is simply absent), that membership must
 * be active, and its role must be OWNER or ADMIN.
 */
export function administrationGate(input: {
  readonly organization: OrganizationRecord | null;
  readonly actorMembership: OrganizationMembershipRecord | null;
}): AdministrationGate | null {
  const { organization, actorMembership } = input;
  if (organization === null) return "no-such-organization";
  if (isOrganizationArchived(organization)) return "organization-archived";
  if (actorMembership === null || actorMembership.organizationId !== organization.id) {
    return "not-a-member";
  }
  if (!isActiveMembership(actorMembership)) return "membership-deactivated";
  if (!isOrganizationAdmin(actorMembership.role)) return "not-an-administrator";
  return null;
}
