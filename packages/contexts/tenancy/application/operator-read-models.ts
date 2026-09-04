// The two reads the dashboard opens with, and the one that had no home.
//
// `_app._index` answers "where does this operator go?" with a single Prisma
// query that folds three decisions together: which organizations are mine, which
// projects can I see inside one, and which environment do I land in. The middle
// one was `operatorVisibleProjectWhere` — an authorization rule that existed only
// as a `Prisma.ProjectWhereInput`, and therefore only inside a Prisma call.
//
// Here they are two read models over the ported rule in `domain/visibility.ts`.
// Neither takes an organization id from its caller: both are keyed by the
// operator alone and walk down from the memberships that operator actually
// holds, so there is no tenant identifier in the request for anybody to
// substitute.
//
// THE REPOSITORY RETURNS EVERY MEMBERSHIP, INCLUDING DEACTIVATED ONES, and the
// filtering happens here. That is deliberate: if the store filtered, deleting
// the `deactivatedAt` clause from this file would leave every suite green, and
// the one rule a removed member's visibility depends on would be unfalsifiable.

import type { Result } from "@platos/kernel";
import { ok } from "@platos/kernel";

import {
  organizationIsListable,
  projectVisibility,
  type OrganizationMembershipRecord,
  type OrganizationRecord,
  type ProjectRecord,
  type ProjectVisibility,
  type UserId,
} from "../domain/index.js";


import type { TenancyDependencies } from "./dependencies.js";

export interface OperatorOrganization {
  readonly organization: OrganizationRecord;
  /** The membership that put them there. Carries the role a UI renders. */
  readonly membership: OrganizationMembershipRecord;
}

export interface OperatorProject {
  readonly project: ProjectRecord;
  /** WHICH arm of the rule made it visible; never merely that one did. */
  readonly through: ProjectVisibility;
}

export type ListOperatorOrganizations = (
  userId: UserId,
) => Promise<Result<readonly OperatorOrganization[]>>;

export type ListVisibleProjects = (
  userId: UserId,
) => Promise<Result<readonly OperatorProject[]>>;

type Dependencies = Pick<TenancyDependencies, "repository">;

/**
 * Oldest first, id ascending as the tiebreak.
 *
 * BOTH LISTS ARE ORDERED, and by the same rule, because the route orders BOTH:
 * `orderBy: { createdAt: "asc" }` on the membership query picks which
 * organization an operator lands in, and the same clause on the nested
 * `projects` select — with `take: 1` — picks which project inside it. Those two
 * choices are the whole landing decision, so the order is behaviour and not a
 * presentation detail a consumer may re-impose.
 *
 * The id is the tiebreak. Rows created in one transaction share an instant, and
 * an unstable order among them would land the same operator somewhere different
 * on consecutive logins.
 */
function byCreation(
  left: { readonly id: string; readonly createdAt: Date },
  right: { readonly id: string; readonly createdAt: Date },
): number {
  const difference = left.createdAt.getTime() - right.createdAt.getTime();
  return difference !== 0 ? difference : left.id.localeCompare(right.id);
}

export function createListOperatorOrganizations(
  dependencies: Dependencies,
): ListOperatorOrganizations {
  const { repository } = dependencies;
  return async (userId) => {
    const memberships = await repository.listOrganizationMembershipsForUser(userId);
    const listed: OperatorOrganization[] = [];
    for (const membership of [...memberships].sort(byCreation)) {
      const organization = await repository.loadOrganization(membership.organizationId);
      if (organization === null) continue;
      if (!organizationIsListable(organization, membership, userId)) continue;
      listed.push({ organization, membership });
    }
    return ok(listed);
  };
}

export function createListVisibleProjects(dependencies: Dependencies): ListVisibleProjects {
  const { repository } = dependencies;
  return async (userId) => {
    const memberships = await repository.listOrganizationMembershipsForUser(userId);
    const listed: OperatorProject[] = [];
    for (const membership of [...memberships].sort(byCreation)) {
      const organization = await repository.loadOrganization(membership.organizationId);
      if (organization === null) continue;
      // The organization filter the route applies on the membership query, kept
      // where the route keeps it. `projectVisibility` is faithful to the
      // fragment and stops at the project.
      if (!organizationIsListable(organization, membership, userId)) continue;

      const projectMemberships = await repository.listProjectMembershipsForMembership(
        membership.id,
      );
      const projects = [...(await repository.listProjects(organization.id))].sort(byCreation);
      for (const project of projects) {
        const through = projectVisibility({
          project,
          organizationMembership: membership,
          projectMemberships,
        });
        if (through !== null) listed.push({ project, through });
      }
    }
    return ok(listed);
  };
}
