// Use case: create a project, with its first environment and the creator's
// ADMIN project membership, in ONE unit of work.
//
// THE ORACLE IS THE ONLY PLACE THIS INVARIANT EXISTS. `_app.orgs.$slug_.
// projects.new` wraps three writes in `database.$transaction`:
//
//     project.create({ data: { organizationId, name, slug,
//                              environments: { create: { name, slug } } } })
//     projectMembership.create({ data: { projectId, organizationMembershipId,
//                                        organizationId, role: ADMIN } })
//
// (the environment is a nested create, so it is the second insert of three).
// Every one of the three is load-bearing:
//
//   * a project with NO environment is unreachable — every route below the
//     project is `/env/:envParam/...`, and the redirect the create issues names
//     the environment it just made;
//   * a project with no ADMIN membership is only reachable by an organization
//     OWNER/ADMIN, so a plain MEMBER who created it would immediately lose it —
//     gate 3 of `decideEnvironmentAccess` waves an organization admin through
//     and demands a project membership from everybody else;
//   * and a `ProjectMembership` whose `organizationId` disagrees with either
//     parent is refused by two composite foreign keys, which is why the
//     candidate row goes through `checkProjectMembershipIntegrity` before the
//     transaction opens rather than being trusted.
//
// A PARTIAL CREATE MUST NOT COMMIT, and the way that is guaranteed here is that
// nothing inside `unitOfWork.run` can refuse. Every gate runs first. The block
// contains three writes and an `ok`, so the only exit is a rejection — which is
// the only thing `UnitOfWork.run` rolls back on. Returning an error `Result` from
// inside it would RESOLVE the promise and therefore commit; that is the defect
// cost-monitoring shipped, and it is designed out rather than tested for.
//
// WHO MAY CALL IT. The oracle's gate is one query: an `OrganizationMembership`
// for this user, `deactivatedAt: null`, whose organization is unarchived. That
// is ANY ACTIVE MEMBER — a MEMBER may create a project, and does not need to be
// an organization admin. No stricter rule is invented here.

import type { EnvironmentId, OrganizationId, ProjectId, Result } from "@platos/kernel";
import { asIdentifier, err, ok, runResult } from "@platos/kernel";

import {
  ProjectRole,
  checkProjectMembershipIntegrity,
  invalidName,
  invalidSlug,
  isActiveMembership,
  isOrganizationArchived,
  isSlug,
  projectCreationForbidden,
  slugTaken,
  type EnvironmentRecord,
  type ProjectMembershipId,
  type ProjectMembershipRecord,
  type ProjectRecord,
  type Slug,
  type UserId,
} from "../domain/index.js";

import type { TenancyDependencies } from "./dependencies.js";

export interface CreateProjectCommand {
  readonly organizationId: OrganizationId;
  /** The active member creating it. Receives the ADMIN project membership. */
  readonly actorUserId: UserId;
  readonly name: string;
  /** Unique within the organization: `@@unique([organizationId, slug])`. */
  readonly slug: string;
  readonly environmentName: string;
  /** Unique within the new project: `@@unique([projectId, slug])`. */
  readonly environmentSlug: string;
}

export interface CreatedProject {
  readonly project: ProjectRecord;
  /** The first environment. There is no state in which this is absent. */
  readonly environment: EnvironmentRecord;
  /** The creator's project membership. Always ADMIN. */
  readonly membership: ProjectMembershipRecord;
}

export type CreateProject = (command: CreateProjectCommand) => Promise<Result<CreatedProject>>;

type Dependencies = Pick<TenancyDependencies, "repository" | "clock" | "ids" | "unitOfWork">;

export function createCreateProject(dependencies: Dependencies): CreateProject {
  const { repository, clock, ids, unitOfWork } = dependencies;
  return async (command) => {
    const name = command.name.trim();
    const environmentName = command.environmentName.trim();
    if (name.length === 0) return err(invalidName("project"));
    if (!isSlug(command.slug)) return err(invalidSlug(command.slug));
    if (environmentName.length === 0) return err(invalidName("environment", "environmentName"));
    if (!isSlug(command.environmentSlug)) {
      return err(invalidSlug(command.environmentSlug, "environmentSlug"));
    }
    const slug = command.slug as Slug;
    const environmentSlug = command.environmentSlug as Slug;

    // The FOUR refusals below carry ONE code and differ only in `details.gate`.
    // The oracle folds all four into a single membership query —
    // `{ userId, deactivatedAt: null, organization: { slug, archivedAt: null } }`
    // — and answers one 403 to every one of them, so a caller cannot use this
    // route to discover whether an organization exists, whether it has been
    // archived, or whether their own membership is still active.
    const organization = await repository.loadOrganization(command.organizationId);
    if (organization === null) return err(projectCreationForbidden("no-such-organization"));
    if (isOrganizationArchived(organization)) {
      return err(projectCreationForbidden("organization-archived"));
    }
    const member = await repository.findOrganizationMembershipByUser(
      organization.id,
      command.actorUserId,
    );
    if (member === null) return err(projectCreationForbidden("not-a-member"));
    if (!isActiveMembership(member)) {
      return err(projectCreationForbidden("membership-deactivated"));
    }

    // As in `createOrganization`: the index is the enforcer, this read is what
    // makes the common case legible.
    if ((await repository.findProjectBySlug(organization.id, slug)) !== null) {
      return err(slugTaken("project"));
    }

    const now = clock.now();
    const project: ProjectRecord = {
      id: asIdentifier<ProjectId>(ids.uuid()),
      organizationId: organization.id,
      slug,
      name,
      archivedAt: null,
      createdAt: now,
      updatedAt: now,
    };
    const environment: EnvironmentRecord = {
      id: asIdentifier<EnvironmentId>(ids.uuid()),
      projectId: project.id,
      slug: environmentSlug,
      name: environmentName,
      archivedAt: null,
      accessKeyRevocationVersion: 0,
      memoryFeedbackBackfillCursor: null,
      memoryFeedbackBackfillCompletedAt: null,
      createdAt: now,
      updatedAt: now,
    };
    const candidate: ProjectMembershipRecord = {
      id: asIdentifier<ProjectMembershipId>(ids.uuid()),
      projectId: project.id,
      organizationMembershipId: member.id,
      // Derived from the project, exactly as the composite foreign key derives
      // it, and then verified against BOTH parents below.
      organizationId: project.organizationId,
      role: ProjectRole.ADMIN,
      createdAt: now,
      updatedAt: now,
    };
    const membership = checkProjectMembershipIntegrity(candidate, project, member);
    if (!membership.ok) return err(membership.error);

    return runResult(unitOfWork, async (transaction) => {
      await repository.saveProject(project, transaction);
      await repository.saveEnvironment(environment, transaction);
      await repository.saveProjectMembership(membership.value, transaction);
      return ok({ project, environment, membership: membership.value });
    });
  };
}
