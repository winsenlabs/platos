// Use case: create an organization, with the founding OWNER membership.
//
// WHY IT DID NOT EXIST. Tenancy could archive an organization, rename one,
// change a membership role and deactivate a member. It could not CREATE. The
// only place an organization was ever born was `_app.orgs.new`, as a Prisma
// nested write:
//
//     database.organization.create({
//       data: { name, slug, memberships: { create: { userId, role: OWNER } } },
//     })
//
// That nested `create` is the whole invariant. Prisma issues both inserts inside
// one implicit transaction, so an organization has never existed without an
// owner — and an organization without one has almost no way back.
// `changeMembershipRole` and `addProjectMember` both refuse an actor who is not
// an ACTIVE organization admin, so neither can hand out the first membership.
//
// THE ONE REMAINING PATH IS GATED IN THE WRONG PLACE, and it is worth saying so
// rather than rounding off. Neither `issueInvitation` here nor the oracle's
// `PlatosAuthService.issueInvitation` checks the inviter's role at all: the only
// check is in the Remix route, which looks for an OWNER/ADMIN membership before
// calling it. That gate lives in exactly the layer this issue exists to empty,
// so relying on it to repair an ownerless organization would be relying on the
// thing being deleted. Splitting the two writes below would therefore create a
// state the product has no supported way out of, which is why they are one
// `UnitOfWork.run`.
//
// WHO MAY CALL IT. The oracle asks only `requireOperator`: any authenticated
// operator may create an organization, with no quota, no allow-list and no
// platform-operator check. No finer rule is invented here — the same discipline
// `add-project-member.ts` records. What IS checked is that the founder is an
// account identity-access actually holds and has not disabled, which is the
// application half of `OrganizationMembership.userId -> User(id)`.

import type { OrganizationId, Result } from "@platos/kernel";
import { asIdentifier, err, ok, runResult } from "@platos/kernel";

import {
  OrganizationRole,
  invalidName,
  invalidSlug,
  isSlug,
  slugTaken,
  unknownOperator,
  type OrganizationMembershipId,
  type OrganizationMembershipRecord,
  type OrganizationRecord,
  type Slug,
  type UserId,
} from "../domain/index.js";

import type { TenancyDependencies } from "./dependencies.js";

export interface CreateOrganizationCommand {
  readonly name: string;
  /** Globally unique. `Organization.slug` carries a plain `@unique`. */
  readonly slug: string;
  /** The operator who will hold the founding OWNER membership. */
  readonly founderUserId: UserId;
}

export interface CreatedOrganization {
  readonly organization: OrganizationRecord;
  /** Always OWNER, always active, always written with the organization. */
  readonly founderMembership: OrganizationMembershipRecord;
}

export type CreateOrganization = (
  command: CreateOrganizationCommand,
) => Promise<Result<CreatedOrganization>>;

type Dependencies = Pick<
  TenancyDependencies,
  "repository" | "operators" | "clock" | "ids" | "unitOfWork"
>;

export function createCreateOrganization(dependencies: Dependencies): CreateOrganization {
  const { repository, operators, clock, ids, unitOfWork } = dependencies;
  return async (command) => {
    const name = command.name.trim();
    if (name.length === 0) return err(invalidName("organization"));
    if (!isSlug(command.slug)) return err(invalidSlug(command.slug));
    const slug = command.slug as Slug;

    const founder = await operators.findAccount(command.founderUserId);
    if (founder === null || founder.disabledAt !== null) return err(unknownOperator());

    // A courtesy, not the enforcer. `Organization.slug` is `@unique` and the
    // index is what makes a duplicate impossible; this read is what turns the
    // common case into a conflict a caller can act on instead of a constraint
    // violation it cannot read. A creator that loses the race still loses it at
    // the index, and the transaction below rolls back when it does.
    if ((await repository.findOrganizationBySlug(slug)) !== null) {
      return err(slugTaken("organization"));
    }

    const now = clock.now();
    const organization: OrganizationRecord = {
      id: asIdentifier<OrganizationId>(ids.uuid()),
      slug,
      name,
      archivedAt: null,
      createdAt: now,
      updatedAt: now,
    };
    const founderMembership: OrganizationMembershipRecord = {
      id: asIdentifier<OrganizationMembershipId>(ids.uuid()),
      organizationId: organization.id,
      userId: command.founderUserId,
      role: OrganizationRole.OWNER,
      deactivatedAt: null,
      createdAt: now,
      updatedAt: now,
    };

    // ONE unit of work, and nothing inside it can decide to refuse: every gate
    // above has already run. That matters more than it looks. `UnitOfWork.run`
    // COMMITS when the work resolves, so a use case that returns an error
    // `Result` from in here commits whatever it wrote before deciding — the
    // defect cost-monitoring shipped. The only way out of this block is a
    // rejection, and a rejection rolls back.
    return runResult(unitOfWork, async (transaction) => {
      await repository.saveOrganization(organization, transaction);
      await repository.saveOrganizationMembership(founderMembership, transaction);
      return ok({ organization, founderMembership });
    });
  };
}
