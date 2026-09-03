// The two grants this context accepts, and the one derivation between them.
//
// `providers` sits at a junction: ADR M0.3 §1 row 4 gives it `tenancy` and
// `secrets`, and BOTH of those contexts mint their own unforgeable environment
// authorization. They are different types with the same name, and this file is
// the only place in the package that holds both.
//
//   TENANCY's operator grant is the RBAC decision — the four gates, the
//   re-derived ancestry, the access level. It is what a control-surface use case
//   demands, because "may this operator manage this environment's provider keys"
//   is a tenancy question.
//
//   SECRETS' grant is what the vault demands before it will read or write
//   material. `secrets` may not import identity-access or tenancy (its
//   allow-list is `kernel` alone), so it states the shape of the grant it
//   accepts and refuses everything else.
//
// SO ONE MUST BE DERIVED FROM THE OTHER, AND HERE IS WHY THAT IS SOUND.
//
// The derivation below is total, auditable and preserves unforgeability end to
// end. It takes only a grant that `tenancy.isEnvironmentOperatorAuthorization`
// accepts — identity against tenancy's own mint register, so nothing that
// arrived as data can be one — and it builds the secrets grant from THAT value's
// re-derived scope, never from an id a caller also supplied. This package cannot
// forge a tenancy grant, and therefore cannot forge a secrets grant either.
//
// The access level maps one-to-one because it is the same decision: both
// contexts spell it `metadata` and `secret:mutate`, and the mapping is
// exhaustive rather than defaulted, so a third level added to either side is a
// compile error here instead of a silent downgrade.
//
// THE RUNTIME PATH GOES THE OTHER WAY. `tenancy` publishes no runtime
// authorization — its own note records that the runtime and service principals
// land there only once identity-access's contract is settled — so a runtime use
// case takes the secrets grant directly from the composition root and re-checks
// its ancestry against the scope it was asked about. That check is transcribed
// from the running system, which refuses when a grant's organization or project
// does not match the scope it was called with.

import { environmentScope, err, ok, type EnvironmentScope, type Result } from "@platos/kernel";
import { asIdentifier } from "@platos/kernel";
import {
  authorizeEnvironmentOperator as mintSecretsOperatorGrant,
  type ActorId,
  type EnvironmentAuthorizationAccess,
  type EnvironmentOperatorAuthorization as SecretsOperatorGrant,
  type EnvironmentRuntimeAuthorization as SecretsRuntimeGrant,
} from "@platos/context-secrets";
import {
  authorizes,
  type EnvironmentAccess,
  type EnvironmentOperatorAuthorization as TenancyOperatorGrant,
} from "@platos/context-tenancy";

import { scopeMismatch } from "../domain/index.js";
import type { ProvidersDependencies } from "./dependencies.js";

export type { SecretsOperatorGrant, SecretsRuntimeGrant, TenancyOperatorGrant };

/**
 * Verify an operator grant, by ASKING TENANCY.
 *
 * The check goes through `TenancyContract.verifyAuthorization` rather than
 * through the pure `requireAuthorization` this package could also import, and
 * that is a deliberate choice with a cost and a reason.
 *
 * The reason: an authorization is genuine only if tenancy's own private mint
 * register holds it. A grant arriving here as `unknown` from a transport is
 * exactly the "crossed a boundary where its type was erased" case that method
 * documents itself as existing for, and asking its owner is what keeps the
 * decision in the context that owns it. In the composition root the two are the
 * same code — the contract method IS `requireAuthorization`.
 *
 * The cost: this package's tests exercise the ASK, not the register. That is the
 * right split — the register is tenancy's property and tenancy tests it — and
 * `authorization.test.ts` additionally pins that the real published check
 * rejects a hand-written literal, so the production wiring cannot be sound in
 * this file and unsound at the seam.
 */
export function verifyOperator(
  dependencies: ProvidersDependencies,
  authorization: unknown,
): Result<TenancyOperatorGrant> {
  return dependencies.tenancy.verifyAuthorization(authorization);
}

/**
 * Verify an operator grant and confirm it authorizes the environment named.
 *
 * Two separate questions, deliberately asked separately: "did tenancy mint
 * this?" and "for which environment?", the second answered from the grant's own
 * re-derived scope. A caller that skipped either would hold a value that is
 * genuine but for somewhere else. Most callers do not need this — they take the
 * environment FROM the grant, which is the shape that cannot mismatch.
 */
export function verifyOperatorGrant(
  dependencies: ProvidersDependencies,
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

/** `metadata` cannot mutate. Asking for more than the grant carries fails. */
export function requireAccess(
  grant: TenancyOperatorGrant,
  access: EnvironmentAccess,
): Result<TenancyOperatorGrant> {
  if (access === "secret:mutate" && grant.access !== "secret:mutate") {
    return err(scopeMismatch("secret:mutate", grant.access));
  }
  return ok(grant);
}

/** Exhaustive by construction: a new level on either side breaks the build. */
function vaultAccess(access: EnvironmentAccess): EnvironmentAuthorizationAccess {
  switch (access) {
    case "metadata":
      return "metadata";
    case "secret:mutate":
      return "secret:mutate";
  }
}

/**
 * Derive the vault's grant from a VERIFIED tenancy grant.
 *
 * Takes the already-verified value, not an `unknown`, so the verification cannot
 * be skipped by calling this directly.
 */
export function vaultGrantFor(grant: TenancyOperatorGrant): SecretsOperatorGrant {
  return mintSecretsOperatorGrant({
    ancestry: {
      organizationId: grant.scope.organizationId,
      projectId: grant.scope.projectId,
      environmentId: grant.scope.environmentId,
    },
    access: vaultAccess(grant.access),
    actorUserId: asIdentifier<ActorId>(grant.actorUserId),
    effectiveUserId: asIdentifier<ActorId>(grant.effectiveUserId),
  });
}

/**
 * Confirm a runtime grant covers the scope it is being used for.
 *
 * The grant carries its own ancestry, so this compares the whole chain rather
 * than the leaf alone. Matching on `environmentId` only would accept a grant
 * minted for an environment that has since been re-parented, which is precisely
 * the cross-tenant read the source's own check exists to refuse.
 */
export function verifyRuntimeGrant(
  grant: SecretsRuntimeGrant,
  scope: EnvironmentScope,
): Result<SecretsRuntimeGrant> {
  const granted = runtimeScope(grant);
  if (
    granted.organizationId !== scope.organizationId ||
    granted.projectId !== scope.projectId ||
    granted.environmentId !== scope.environmentId
  ) {
    return err(scopeMismatch(pathOf(scope), pathOf(granted)));
  }
  return ok(grant);
}

/** The environment a runtime grant covers, as a kernel scope. */
export function runtimeScope(grant: SecretsRuntimeGrant): EnvironmentScope {
  return environmentScope(
    asIdentifier(grant.organizationId),
    asIdentifier(grant.projectId),
    asIdentifier(grant.environmentId),
  );
}

function pathOf(scope: {
  readonly organizationId: string;
  readonly projectId: string;
  readonly environmentId: string;
}): string {
  return `org/${scope.organizationId}/proj/${scope.projectId}/env/${scope.environmentId}`;
}
