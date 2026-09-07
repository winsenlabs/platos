// Use case: grant an organization member a role on one project.
//
// This is where the cross-tenant integrity key is enforced in the application.
// The command carries `organizationId` because a transport will: it is on the
// route, in the session, or in the body. The use case does NOT trust it — it
// loads the project and the organization membership, and refuses unless all
// three agree. That is the same thing the two composite foreign keys do in
// Postgres, restated where an in-memory use case can see it.
//
// NO ORACLE EXISTS FOR THE AUTHORIZATION HALF. `ProjectMembership` is created
// nowhere in production TypeScript — only in an integration fixture — so there
// is no observed rule about who may grant a project role. Rather than invent
// one, the gate below is the narrowest thing already true elsewhere: gate 3 of
// `authorizeEnvironmentOperator` treats an organization OWNER/ADMIN as
// authorized over every project in the organization without any project
// membership. Anything finer (a project ADMIN granting project roles, say) is a
// product decision and is deliberately NOT assumed here.

import type { OrganizationId, ProjectId, Result, TransactionScope } from "@platos/kernel";
import { asIdentifier, err, ok, runResult } from "@platos/kernel";

import {
  checkProjectMembershipIntegrity,
  isActiveMembership,
  isOrganizationAdmin,
  membershipMutationForbidden,
  tenantNotFound,
  type OrganizationMembershipId,
  type ProjectMembershipId,
  type ProjectMembershipRecord,
  type ProjectRole,
  type UserId,
} from "../domain/index.js";

import type { TenancyDependencies } from "./dependencies.js";

export interface AddProjectMemberCommand {
  readonly projectId: ProjectId;
  readonly organizationMembershipId: OrganizationMembershipId;
  /**
   * The integrity key as the caller believes it to be. Verified against the
   * project AND the organization membership; never used to look anything up.
   */
  readonly organizationId: OrganizationId;
  readonly role: ProjectRole;
  readonly actorUserId: UserId;
}

export type AddProjectMember = (
  command: AddProjectMemberCommand,
) => Promise<Result<ProjectMembershipRecord>>;

type Dependencies = Pick<
  TenancyDependencies,
  "repository" | "clock" | "ids" | "unitOfWork"
>;

export function createAddProjectMember(dependencies: Dependencies): AddProjectMember {
  const { repository, clock, ids, unitOfWork } = dependencies;
  return async (command) => {
    const project = await repository.loadProject(command.projectId);
    if (project === null) return err(tenantNotFound("project"));

    // The actor is checked against the PROJECT'S organization, never against
    // the one the command declared.
    const actor = await repository.findOrganizationMembershipByUser(
      project.organizationId,
      command.actorUserId,
    );
    if (actor === null || !isActiveMembership(actor) || !isOrganizationAdmin(actor.role)) {
      return err(membershipMutationForbidden("actor-not-organization-admin"));
    }

    const organizationMembership = await repository.findOrganizationMembershipById(
      command.organizationId,
      command.organizationMembershipId,
    );
    if (organizationMembership === null || !isActiveMembership(organizationMembership)) {
      return err(membershipMutationForbidden("target-not-active"));
    }

    const now = clock.now();
    const candidate: ProjectMembershipRecord = {
      id: asIdentifier<ProjectMembershipId>(ids.uuid()),
      projectId: command.projectId,
      organizationMembershipId: command.organizationMembershipId,
      organizationId: command.organizationId,
      role: command.role,
      createdAt: now,
      updatedAt: now,
    };
    const verified = checkProjectMembershipIntegrity(candidate, project, organizationMembership);
    if (!verified.ok) return err(verified.error);

    return runResult(unitOfWork, async (transaction: TransactionScope) => {
      await repository.saveProjectMembership(verified.value, transaction);
      return ok(verified.value);
    });
  };
}
