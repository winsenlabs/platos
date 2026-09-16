// Read model: an environment addressed by the three SLUGS in a dashboard URL,
// authorized for the operator asking, with the sibling environments the scope
// switcher lists.
//
// PORTED FROM `apps/webapp/app/services/auth.server.ts` `requireEnvironmentScope`
// (line 75 at the base of this tranche), which is the oracle, behaviour for
// behaviour:
//
//   1. find the environment by `slug`, under a project by `slug`, under an
//      organization by `slug` — EVERY level `archivedAt: null` — or answer 404
//      "Environment not found";
//   2. run the four-gate `authorizeEnvironmentOperator` on that environment's id
//      at the requested access, and answer its refusal (403) unchanged;
//   3. return the organization, project and environment, and the project's
//      UNARCHIVED environments ordered `createdAt` ascending.
//
// THE 404/403 SPLIT IS THE ORACLE'S, AND IT IS RECORDED AS A FINDING RATHER THAN
// SILENTLY TIGHTENED. A caller can learn from it whether a slug triple names a
// live environment somewhere, which `authorizeEnvironmentOperator` by id does not
// disclose (it folds a missing environment into its forbidden answer). Changing it
// would be a behaviour change to a flow the product serves today and no decision
// covers it; the id-keyed authorization in step 2 is what keeps it from being a
// cross-tenant READ.
//
// THE AUTHORIZATION IS TENANCY'S OWN MINT, BUILT FROM THE LEAF. The slugs choose
// which environment to ask about and nothing else: step 2 re-derives the whole
// ancestry from the environment id exactly as every other authorized route does,
// so a slug triple cannot smuggle a scope the operator was not granted.

import type { EnvironmentId, Result } from "@platos/kernel";
import { asIdentifier, err, ok } from "@platos/kernel";

import {
  isEnvironmentArchived,
  isOrganizationArchived,
  isProjectArchived,
  tenantNotFound,
  type EnvironmentAccess,
  type EnvironmentOperatorAuthorization,
  type EnvironmentRecord,
  type OperatorPrincipal,
  type OrganizationRecord,
  type ProjectRecord,
  type Slug,
} from "../domain/index.js";

import type { AuthorizeEnvironmentOperator } from "./authorize-environment-operator.js";
import type { TenancyDependencies } from "./dependencies.js";

export interface ResolveOperatorEnvironmentCommand {
  readonly organizationSlug: string;
  readonly projectSlug: string;
  readonly environmentSlug: string;
  readonly operator: OperatorPrincipal;
  readonly access: EnvironmentAccess;
}

export interface OperatorEnvironment {
  readonly authorization: EnvironmentOperatorAuthorization;
  readonly organization: OrganizationRecord;
  readonly project: ProjectRecord;
  readonly environment: EnvironmentRecord;
  /** The project's unarchived environments, oldest first. Includes `environment`. */
  readonly environments: readonly EnvironmentRecord[];
}

export type ResolveOperatorEnvironment = (
  command: ResolveOperatorEnvironmentCommand,
) => Promise<Result<OperatorEnvironment>>;

type Dependencies = Pick<TenancyDependencies, "repository">;

function byCreation(left: EnvironmentRecord, right: EnvironmentRecord): number {
  const difference = left.createdAt.getTime() - right.createdAt.getTime();
  return difference !== 0 ? difference : left.id.localeCompare(right.id);
}

export function createResolveOperatorEnvironment(
  dependencies: Dependencies,
  authorize: AuthorizeEnvironmentOperator,
): ResolveOperatorEnvironment {
  const { repository } = dependencies;
  return async (command) => {
    const organization = await repository.findOrganizationBySlug(
      asIdentifier<Slug>(command.organizationSlug),
    );
    if (organization === null || isOrganizationArchived(organization)) {
      return err(tenantNotFound("environment"));
    }
    const project = await repository.findProjectBySlug(
      organization.id,
      asIdentifier<Slug>(command.projectSlug),
    );
    if (project === null || isProjectArchived(project)) return err(tenantNotFound("environment"));
    const environment = await repository.findEnvironmentBySlug(
      project.id,
      asIdentifier<Slug>(command.environmentSlug),
    );
    if (environment === null || isEnvironmentArchived(environment)) {
      return err(tenantNotFound("environment"));
    }

    const authorization = await authorize({
      environmentId: asIdentifier<EnvironmentId>(environment.id),
      operator: command.operator,
      access: command.access,
    });
    if (!authorization.ok) return err(authorization.error);

    const environments = (await repository.listEnvironments(project.id))
      .filter((sibling) => !isEnvironmentArchived(sibling))
      .sort(byCreation);
    return ok({ authorization: authorization.value, organization, project, environment, environments });
  };
}
