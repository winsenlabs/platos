// Use case: address a workspace BY SLUG, and authorize the operator for it, in
// one decision.
//
// THE OLDEST REACH IN THE PRODUCT. `apps/webapp/app/services/auth.server.ts`
// opens every environment-scoped page with a single Prisma `environment.findFirst`
// that walks `(organizationSlug, projectSlug, environmentSlug)` down three
// `archivedAt: null` filters, and then calls `authorizeEnvironmentOperator` with
// the id it found. Every route below `/orgs/:org/projects/:project/env/:env`
// depends on it, and it is the reason the webapp holds a database credential at
// all. This use case is that query, ported — the walk and the decision, in the
// layer that owns both.
//
// -----------------------------------------------------------------------------
// WHY THE RESOLUTION AND THE AUTHORIZATION ARE ONE USE CASE AND NOT TWO
//
// A published `resolveBySlugs` returning ids, with authorization left to the
// caller, would be the one place in this system where an operator learns that
// `acme/billing/production` EXISTS without being allowed to address it. Slugs are
// guessable in a way `EnvironmentId` is not — they are company names and the word
// "production" — so a lookup keyed by them is an enumeration oracle over the
// customer list unless the refusal is collapsed.
//
// This context already decided that, twice, in prose that names the property:
//
//   `environmentForbidden` — "the oracle throws one identical environmentForbidden()
//   from all four gates, so a caller probing an environment id cannot learn whether
//   the environment exists, whether it is archived, whether they are a member of the
//   organization, or merely which role they hold."
//
//   `projectCreationForbidden` — "a missing organization, an archived one and a
//   caller who is not a member all fall out of one query as one 403. A caller
//   therefore cannot use this route to learn whether an organization exists."
//
// So the three resolution failures below return `environmentForbidden` — the SAME
// code and the SAME message the four RBAC gates return — and the gate name travels
// only in `details`, which kernel `vo/error.ts` documents as log-only. Splitting
// this into two contract methods would hand a transport the job of collapsing them,
// and a transport that forgot would reintroduce the oracle silently.
//
// -----------------------------------------------------------------------------
// ARCHIVAL IS NOT RE-DECIDED HERE
//
// The oracle's query carries `archivedAt: null` at all three levels. That filter is
// NOT repeated in the walk below, and the omission is deliberate rather than a
// simplification: `authorizeEnvironmentOperator` re-derives the whole ancestry from
// the leaf and refuses an archived one through its `archived-ancestor` gate. Two
// archival rules would be two things to keep in step, and the one that stopped
// being reached would rot green. The walk finds the row; the decision decides.
//
// -----------------------------------------------------------------------------
// THE TWO PATHS ARE JOINED, AND THAT JOIN IS THE POINT
//
// The slug walk descends organization -> project -> environment. The authorization
// ascends from the environment id through `loadEnvironmentAncestry`. Those are two
// INDEPENDENT derivations of the same three ids, through different repository
// methods and different indexes, and this use case asserts they agree before it
// returns. A store whose ancestry disagreed with its own slug indexes would hand a
// caller a scope for a tenant they addressed by another tenant's name; that is the
// class of defect `crossTenantMembership` exists for, and here it is checkable for
// free because the answer was computed twice.

import { err, ok, type Result } from "@platos/kernel";

import {
  environmentForbidden,
  isSlug,
  type EnvironmentAccess,
  type EnvironmentOperatorAuthorization,
  type EnvironmentRecord,
  type OperatorPrincipal,
  type OrganizationRecord,
  type ProjectRecord,
  type Slug,
} from "../domain/index.js";

import { createAuthorizeEnvironmentOperator } from "./authorize-environment-operator.js";
import type { TenancyDependencies } from "./dependencies.js";
import { byCreation } from "./operator-read-models.js";

export interface ResolveWorkspaceCommand {
  readonly organizationSlug: string;
  readonly projectSlug: string;
  readonly environmentSlug: string;
  /** Already authenticated by identity-access. Never a raw token. */
  readonly operator: OperatorPrincipal;
  readonly access: EnvironmentAccess;
}

/**
 * Everything a dashboard page needs to render its shell, and the authorization
 * that earned it.
 *
 * `authorization` is the branded value `authorizeEnvironmentOperator` minted, not
 * a copy of it: a consumer that needs the scope must use the one tenancy
 * re-derived from the leaf, never one assembled from the slugs in a URL.
 */
export interface WorkspaceDescriptor {
  readonly authorization: EnvironmentOperatorAuthorization;
  readonly organization: OrganizationRecord;
  readonly project: ProjectRecord;
  readonly environment: EnvironmentRecord;
  /**
   * The project's UNARCHIVED environments, oldest first — the environment
   * switcher's list, and the same `where`/`orderBy` the oracle's nested select
   * carries. The addressed environment is one of them.
   */
  readonly environments: readonly EnvironmentRecord[];
}

export type ResolveWorkspace = (
  command: ResolveWorkspaceCommand,
) => Promise<Result<WorkspaceDescriptor>>;

/**
 * A slug that cannot exist and a slug that does not exist are the same fact to a
 * caller, so a malformed one is refused with the collapsed gate rather than with
 * a distinguishable validation failure. It also means the repository is never
 * asked a question its index cannot answer.
 */
function slugOrNull(value: string): Slug | null {
  return isSlug(value) ? value : null;
}

export function createResolveWorkspace(
  dependencies: Pick<TenancyDependencies, "repository">,
): ResolveWorkspace {
  const { repository } = dependencies;
  const authorize = createAuthorizeEnvironmentOperator(dependencies);

  return async (command) => {
    const organizationSlug = slugOrNull(command.organizationSlug);
    if (organizationSlug === null) return err(environmentForbidden("no-such-organization"));
    const organization = await repository.findOrganizationBySlug(organizationSlug);
    if (organization === null) return err(environmentForbidden("no-such-organization"));

    const projectSlug = slugOrNull(command.projectSlug);
    if (projectSlug === null) return err(environmentForbidden("no-such-project"));
    const project = await repository.findProjectBySlug(organization.id, projectSlug);
    if (project === null) return err(environmentForbidden("no-such-project"));

    const environmentSlug = slugOrNull(command.environmentSlug);
    if (environmentSlug === null) return err(environmentForbidden("no-such-environment"));
    const environment = await repository.findEnvironmentBySlug(project.id, environmentSlug);
    if (environment === null) return err(environmentForbidden("no-such-environment"));

    const authorization = await authorize({
      environmentId: environment.id,
      operator: command.operator,
      access: command.access,
    });
    if (!authorization.ok) return err(authorization.error);

    // THE JOIN. `scope` was re-derived from the leaf by `loadEnvironmentAncestry`;
    // the three records above were reached by walking slug indexes downward. They
    // are the same three ids computed two ways, and a store that disagreed with
    // itself must not be allowed to answer.
    const scope = authorization.value.scope;
    if (
      scope.organizationId !== organization.id ||
      scope.projectId !== project.id ||
      scope.environmentId !== environment.id
    ) {
      return err(environmentForbidden("inconsistent-ancestry"));
    }

    const environments = [...(await repository.listEnvironments(project.id))]
      .filter((candidate) => candidate.archivedAt === null)
      .sort(byCreation);

    return ok({ authorization: authorization.value, organization, project, environment, environments });
  };
}
