// Use cases: archive one level of the tenant tree, and resolve a scope.
//
// ARCHIVAL DOES NOT REWRITE DESCENDANTS. Archiving an organization sets one
// column on one row, and every environment beneath it is denied from the next
// authorization onward because gate 1 reads all three levels. Cascading the
// flag downward instead would be O(tree) writes, would race with concurrent
// project creation, and — worse — would be irreversible in practice, because a
// later un-archive could not tell which descendants had been archived on their
// own and which were archived by the cascade.

import type { EnvironmentId, OrganizationId, ProjectId, Result } from "@platos/kernel";
import { err, ok, runResult } from "@platos/kernel";

import {
  archiveEnvironment,
  archiveOrganization,
  archiveProject,
  ancestryScope,
  archivedAncestor,
  isActiveMembership,
  isOrganizationAdmin,
  membershipMutationForbidden,
  tenantNotFound,
  type AncestryLevel,
  type UserId,
} from "../domain/index.js";
import type { EnvironmentScope } from "@platos/kernel";

import type { TenancyDependencies } from "./dependencies.js";

type Dependencies = Pick<TenancyDependencies, "repository" | "clock" | "unitOfWork">;

export interface ArchiveOrganizationCommand {
  readonly organizationId: OrganizationId;
  readonly actorUserId: UserId;
}

export interface ArchiveProjectCommand {
  readonly projectId: ProjectId;
  readonly actorUserId: UserId;
}

export interface ArchiveEnvironmentCommand {
  readonly environmentId: EnvironmentId;
  readonly actorUserId: UserId;
}

async function requireOrganizationAdmin(
  dependencies: Dependencies,
  organizationId: OrganizationId,
  actorUserId: UserId,
): Promise<Result<true>> {
  const membership = await dependencies.repository.findOrganizationMembershipByUser(
    organizationId,
    actorUserId,
  );
  if (membership === null || !isActiveMembership(membership) || !isOrganizationAdmin(membership.role)) {
    return err(membershipMutationForbidden("actor-not-organization-admin"));
  }
  return ok(true);
}

export function createArchiveOrganization(dependencies: Dependencies) {
  return async (command: ArchiveOrganizationCommand): Promise<Result<void>> => {
    const organization = await dependencies.repository.loadOrganization(command.organizationId);
    if (organization === null) return err(tenantNotFound("organization"));
    const admitted = await requireOrganizationAdmin(
      dependencies,
      command.organizationId,
      command.actorUserId,
    );
    if (!admitted.ok) return err(admitted.error);
    const archived = archiveOrganization(organization, dependencies.clock.now());
    return runResult(dependencies.unitOfWork, async (transaction) => {
      await dependencies.repository.saveOrganization(archived, transaction);
      return ok(undefined);
    });
  };
}

export function createArchiveProject(dependencies: Dependencies) {
  return async (command: ArchiveProjectCommand): Promise<Result<void>> => {
    const project = await dependencies.repository.loadProject(command.projectId);
    if (project === null) return err(tenantNotFound("project"));
    const admitted = await requireOrganizationAdmin(
      dependencies,
      project.organizationId,
      command.actorUserId,
    );
    if (!admitted.ok) return err(admitted.error);
    const archived = archiveProject(project, dependencies.clock.now());
    return runResult(dependencies.unitOfWork, async (transaction) => {
      await dependencies.repository.saveProject(archived, transaction);
      return ok(undefined);
    });
  };
}

export function createArchiveEnvironment(dependencies: Dependencies) {
  return async (command: ArchiveEnvironmentCommand): Promise<Result<void>> => {
    const ancestry = await dependencies.repository.loadEnvironmentAncestry(command.environmentId);
    if (ancestry === null) return err(tenantNotFound("environment"));
    const admitted = await requireOrganizationAdmin(
      dependencies,
      ancestry.organization.id,
      command.actorUserId,
    );
    if (!admitted.ok) return err(admitted.error);
    const archived = archiveEnvironment(ancestry.environment, dependencies.clock.now());
    return runResult(dependencies.unitOfWork, async (transaction) => {
      await dependencies.repository.saveEnvironment(archived, transaction);
      return ok(undefined);
    });
  };
}

/**
 * Resolve an environment id to the scope every other context is keyed by.
 *
 * This is tenancy's most-used service: contexts 4-18 all take an
 * `EnvironmentScope` and none of them may resolve one themselves. It refuses an
 * archived tree, so a downstream context cannot obtain a usable scope for an
 * environment nobody is authorized against.
 */
export function createResolveEnvironmentScope(dependencies: Pick<TenancyDependencies, "repository">) {
  return async (
    environmentId: EnvironmentId,
  ): Promise<Result<{ readonly scope: EnvironmentScope; readonly archived: AncestryLevel | null }>> => {
    const ancestry = await dependencies.repository.loadEnvironmentAncestry(environmentId);
    if (ancestry === null) return err(tenantNotFound("environment"));
    return ok({ scope: ancestryScope(ancestry), archived: archivedAncestor(ancestry) });
  };
}
