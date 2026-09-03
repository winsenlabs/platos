// Use case: authorize an operator for one environment.
//
// This is the whole RBAC model of the product today. The oracle
// (`authorizeEnvironmentOperator`, auth.ts:142-210) is four gates in one
// function, and this use case is the same four gates with the reads named
// separately from the decision, so the decision itself is pure and testable
// without a database.
//
// The command carries the ENVIRONMENT ID AND THE AUTHENTICATED OPERATOR, and
// no other tenant identifier. There is nowhere to put an organization id, so
// there is nothing for a caller to spoof.

import type { EnvironmentId } from "@platos/kernel";
import { err, ok, type Result } from "@platos/kernel";

import {
  decideEnvironmentAccess,
  type EnvironmentAccess,
  type EnvironmentAncestry,
  type EnvironmentOperatorAuthorization,
  type OperatorPrincipal,
  type OrganizationMembershipRecord,
  type ProjectMembershipRecord,
  environmentForbidden,
} from "../domain/index.js";

import type { TenancyDependencies } from "./dependencies.js";

export interface AuthorizeEnvironmentOperatorCommand {
  readonly environmentId: EnvironmentId;
  /** Already authenticated by identity-access. Never a raw token. */
  readonly operator: OperatorPrincipal;
  readonly access: EnvironmentAccess;
}

export type AuthorizeEnvironmentOperator = (
  command: AuthorizeEnvironmentOperatorCommand,
) => Promise<Result<EnvironmentOperatorAuthorization>>;

interface Memberships {
  readonly organizationMembership: OrganizationMembershipRecord | null;
  readonly projectMembership: ProjectMembershipRecord | null;
}

async function loadMemberships(
  repository: TenancyDependencies["repository"],
  ancestry: EnvironmentAncestry,
  operator: OperatorPrincipal,
): Promise<Memberships> {
  const organizationMembership = await repository.findOrganizationMembershipByUser(
    ancestry.organization.id,
    operator.effectiveUserId,
  );
  if (organizationMembership === null) {
    return { organizationMembership: null, projectMembership: null };
  }
  const projectMembership = await repository.findProjectMembership(
    ancestry.project.id,
    organizationMembership.id,
  );
  return { organizationMembership, projectMembership };
}

export function createAuthorizeEnvironmentOperator(
  dependencies: Pick<TenancyDependencies, "repository">,
): AuthorizeEnvironmentOperator {
  const { repository } = dependencies;
  return async (command) => {
    // Ancestry comes from the LEAF and only the leaf.
    const ancestry = await repository.loadEnvironmentAncestry(command.environmentId);
    if (ancestry === null) return err(environmentForbidden("archived-ancestor"));

    const memberships = await loadMemberships(repository, ancestry, command.operator);
    const decision = decideEnvironmentAccess({
      ancestry,
      organizationMembership: memberships.organizationMembership,
      projectMembership: memberships.projectMembership,
      operator: command.operator,
      access: command.access,
    });
    return decision.ok ? ok(decision.value) : err(decision.error);
  };
}
