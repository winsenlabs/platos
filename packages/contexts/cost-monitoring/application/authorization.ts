// The one grant this context accepts.
//
// `cost-monitoring` is simpler here than `providers` is, and the difference is
// worth naming because a reader coming from that file will expect two grants and
// a derivation between them.
//
// `providers` holds two, because it must both make an RBAC decision (tenancy's)
// and open a credential (secrets'). This context makes the same RBAC decision and
// NEVER opens a credential — `secrets` is not on its ADR §1 row 13 allow-list.
// The material behind an alert channel is resolved by the `Notifier` adapter at
// dispatch. So there is one grant, one verification, and no derivation.
//
// THE VERIFICATION GOES THROUGH `TenancyContract.verifyAuthorization` rather than
// through the pure `requireAuthorization` this package could also import, for the
// reason `providers` records: an authorization is genuine only if tenancy's own
// private mint register holds it, and a grant arriving here as `unknown` from a
// transport is exactly the "crossed a boundary where its type was erased" case.
// In the composition root the two are the same code.
//
// TWO ACCESS LEVELS, AND THE MAPPING IS NOT WHAT IT LOOKS LIKE.
//
// Tenancy spells them `metadata` and `secret:mutate`. Reading caps and channels
// needs `metadata`. Writing a cap ALSO needs `metadata` — a budget holds no
// secret. Writing a CHANNEL needs `secret:mutate`, because creating or updating
// one causes a credential to be minted or rotated in the vault, even though this
// context never touches the material itself. That distinction is the source's and
// it is preserved: `budgets.upsert` authorises at the lower level and
// `alert_channels.create` at the higher one.

import { err, ok, type EnvironmentScope, type Result } from "@platos/kernel";
import {
  authorizes,
  type EnvironmentAccess,
  type EnvironmentOperatorAuthorization as TenancyOperatorGrant,
} from "@platos/context-tenancy";

import { scopeMismatch } from "../domain/index.js";
import type { CostMonitoringDependencies } from "./dependencies.js";

export type { TenancyOperatorGrant };

/** Verify an operator grant, by ASKING TENANCY. */
export function verifyOperator(
  dependencies: CostMonitoringDependencies,
  authorization: unknown,
): Result<TenancyOperatorGrant> {
  return dependencies.tenancy.verifyAuthorization(authorization);
}

/**
 * Verify an operator grant and confirm it authorizes the environment named.
 *
 * Two separate questions, deliberately asked separately: "did tenancy mint
 * this?" and "for which environment?", the second answered from the grant's own
 * re-derived scope. Most callers do not need this — they take the environment
 * FROM the grant, which is the shape that cannot mismatch.
 */
export function verifyOperatorGrant(
  dependencies: CostMonitoringDependencies,
  authorization: unknown,
  scope: EnvironmentScope,
): Result<TenancyOperatorGrant> {
  const verified = verifyOperator(dependencies, authorization);
  if (!verified.ok) return err(verified.error);
  if (!authorizes(verified.value, scope)) {
    return err(scopeMismatch(pathOf(scope), pathOf(verified.value.scope)));
  }
  return ok(verified.value);
}

/** `metadata` cannot mutate a channel. Asking for more than the grant carries fails. */
export function requireAccess(
  grant: TenancyOperatorGrant,
  access: EnvironmentAccess,
): Result<TenancyOperatorGrant> {
  if (access === "secret:mutate" && grant.access !== "secret:mutate") {
    return err(scopeMismatch("secret:mutate", grant.access));
  }
  return ok(grant);
}

/**
 * Verify a grant and demand an access level, in one call.
 *
 * The two are always used together on a mutation path, and separating them at
 * every call site is how one of them comes to be forgotten.
 */
export function authorize(
  dependencies: CostMonitoringDependencies,
  authorization: unknown,
  access: EnvironmentAccess,
): Result<TenancyOperatorGrant> {
  const verified = verifyOperator(dependencies, authorization);
  if (!verified.ok) return err(verified.error);
  return requireAccess(verified.value, access);
}

function pathOf(scope: {
  readonly organizationId: string;
  readonly projectId: string;
  readonly environmentId: string;
}): string {
  return `org/${scope.organizationId}/proj/${scope.projectId}/env/${scope.environmentId}`;
}
