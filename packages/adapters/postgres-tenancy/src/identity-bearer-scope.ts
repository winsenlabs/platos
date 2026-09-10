// The environment ancestry every bearer-credential projection re-derives its
// scope from — and the module that exists so the two files that need it do not
// import each other.
//
// WHY IT IS ITS OWN FILE, WHICH IS A BUG THIS TRANCHE PAID FOR RATHER THAN A
// PREFERENCE. `identity-bearer.ts` holds the store factory and
// `identity-bearer-lifecycle.ts` holds the three methods it mixes in, so the
// factory imports the lifecycle. When the lifecycle ALSO imported these constants
// back out of the factory's file, the cycle resolved in the order ESM requires:
// `identity-bearer-lifecycle.ts` evaluated first, its module-level
// `PLATFORM_COLUMNS = { …, environment: ENVIRONMENT_ANCESTORS }` read the binding
// before the other module had initialised it, and every column spec was built with
// `environment: undefined`.
//
// THE SHAPE OF THE FAILURE IS WORTH RECORDING because it is not a compile error
// and not a type error. TypeScript is happy — the binding exists and has the right
// type — and the symptom arrives at RUN TIME, inside a projection, as
// `Cannot read properties of undefined (reading 'projectId')` on a row the query
// really returned. The suite that caught it was the real-PostgreSQL one; a unit
// test over a fake client would have compared a select spec it built itself and
// seen nothing.
//
// SO THE RULE IS: the two ends of a mixin do not import each other. Whatever they
// share lives here, which neither of them imports FROM the other.

import { readAuthorizationScope } from "./identity-mapping.js";
import type { ScopeAncestry } from "./identity-mapping.js";

/**
 * The relation select every one of the four bearer tables needs.
 *
 * `Environment` carries `projectId` and nothing above it — `tenancy/domain/entity.ts`
 * records that the tenant tree is walked and never denormalised — so the
 * organization comes through the project. Both are read on every projection
 * because the scope is RE-DERIVED from the row's own ancestry rather than echoed
 * from whatever the caller said its tenancy was.
 */
export const ENVIRONMENT_ANCESTORS = {
  select: { projectId: true, project: { select: { organizationId: true } } },
} as const;

export interface EnvironmentAncestor {
  readonly projectId: string;
  readonly project: { readonly organizationId: string };
}

export function environmentAncestry(environment: EnvironmentAncestor): ScopeAncestry {
  return {
    environmentProjectId: environment.projectId,
    environmentOrganizationId: environment.project.organizationId,
  };
}

/**
 * One environment id plus its ancestry, as an `AuthorizationScope`.
 *
 * `table` NAMES THE ROW so a refusal from `readAuthorizationScope` says which of
 * the four tables held the inconsistent value. Four callers, four different
 * tables, one function: without the parameter every one of them would report the
 * same thing and an operator would have to guess.
 */
export function environmentScopeOf(
  environmentId: string,
  environment: EnvironmentAncestor,
  table: string,
) {
  return readAuthorizationScope(
    { scopeKind: "ENVIRONMENT", organizationId: null, projectId: null, environmentId },
    environmentAncestry(environment),
    table,
  );
}
