// Read model: the members of one organization, with the address each one signs
// in with — the listing `settings.team` renders.
//
// PORTED FROM THE ROUTE, BECAUSE THE ROUTE WAS THE ONLY PLACE IT LIVED. The Remix
// loader answers with ONE Prisma query that folds an authorization rule into a
// read: `organization.findFirst({ where: { id/slug, archivedAt: null,
// memberships: { some: { userId, deactivatedAt: null, role in OWNER/ADMIN } } },
// select: { memberships: { where: { deactivatedAt: null }, orderBy: createdAt
// asc, select: { id, role, user: { email } } } } })`, and a 403 when nothing
// comes back. Here the rule is `administrationGate` and the read is two port
// calls, so the rule can be deleted from this file only by a change a test sees.
//
// THE ADDRESS COMES THROUGH `OperatorDirectory`, not a join. `User` is
// identity-access's row (ADR M0.3 §1), and the directory is the reader port tenancy
// already asks for exactly this fact when accepting an invitation. One lookup per
// member is the honest cost of that boundary for a list bounded by one team.
//
// THE KEY IS THE ORGANIZATION THE CALLER NAMED AND THE ACTOR THE TRANSPORT
// AUTHENTICATED. A caller who administers organization B and names A reaches
// `not-a-member`, because the membership lookup is keyed by A — the forged id buys
// nothing, and it answers the same 403 a non-existent organization does.

import type { OrganizationId, Result } from "@platos/kernel";
import { err, ok } from "@platos/kernel";

import {
  administrationGate,
  isActiveMembership,
  memberListForbidden,
  type EmailAddress,
  type OrganizationMembershipRecord,
  type UserId,
} from "../domain/index.js";

import type { TenancyDependencies } from "./dependencies.js";

export interface ListOrganizationMembersCommand {
  readonly organizationId: OrganizationId;
  /** The EFFECTIVE user a transport authenticated. Never taken from a body. */
  readonly actorUserId: UserId;
}

export interface OrganizationMember {
  readonly membership: OrganizationMembershipRecord;
  /**
   * The operator account behind the membership, or null when identity-access has
   * no such user. A disabled account is still LISTED — the oracle selected
   * `user.email` with no filter — and says so, so a team page can show it.
   */
  readonly account: { readonly email: EmailAddress; readonly disabledAt: Date | null } | null;
}

export type ListOrganizationMembers = (
  command: ListOrganizationMembersCommand,
) => Promise<Result<readonly OrganizationMember[]>>;

type Dependencies = Pick<TenancyDependencies, "repository" | "operators">;

/** The oracle's `orderBy: { createdAt: "asc" }`, with the id as the stable tiebreak. */
function byCreation(left: OrganizationMembershipRecord, right: OrganizationMembershipRecord): number {
  const difference = left.createdAt.getTime() - right.createdAt.getTime();
  return difference !== 0 ? difference : left.id.localeCompare(right.id);
}

export function createListOrganizationMembers(dependencies: Dependencies): ListOrganizationMembers {
  const { repository, operators } = dependencies;
  return async (command) => {
    const organization = await repository.loadOrganization(command.organizationId);
    const actor = await repository.findOrganizationMembershipByUser(
      command.organizationId,
      command.actorUserId,
    );
    const gate = administrationGate({ organization, actorMembership: actor });
    if (gate !== null) return err(memberListForbidden(gate));

    const memberships = (await repository.listOrganizationMemberships(command.organizationId))
      .filter(isActiveMembership)
      .sort(byCreation);
    const members: OrganizationMember[] = [];
    for (const membership of memberships) {
      const account = await operators.findAccount(membership.userId);
      members.push({
        membership,
        account: account === null ? null : { email: account.email, disabledAt: account.disabledAt },
      });
    }
    return ok(members);
  };
}
