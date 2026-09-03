// The one grant this context accepts, and why there is only one.
//
// `providers` holds two grants and derives one from the other, because the vault
// it calls demands its own. `agents` does not: it touches no secret material, it
// calls no vault, and the only authorization it needs is tenancy's RBAC
// decision. So there is one verification, stated here once, and every use case
// in the package goes through it.
//
// EVERY OPERATION IN THIS CONTEXT IS `metadata`-LEVEL, AND THAT IS A FINDING
// RATHER THAN AN OVERSIGHT. Tenancy discriminates exactly two access levels:
// `metadata`, which its own note calls "the default read/administer level", and
// `secret:mutate`, which gate 4 narrows for the vault. Authoring an agent is
// administration, not secret mutation, so it falls on the `metadata` side —
// which means the same grant that lets an operator READ this environment's
// agents lets them REWRITE one. That is the running system's behaviour: the
// agent control surface checks the operator gate and nothing finer. It is
// recorded here, and in `contracts/index.ts`, so that a later decision to
// separate authoring from reading is made deliberately rather than discovered.
//
// THE SCOPE COMES FROM THE GRANT, NEVER FROM THE REQUEST. Every command in this
// package takes an `authorization` and no environment id. A command that carried
// both would have two answers to "which environment is this?", and the one an
// implementation reached for first would decide whether a cross-tenant write was
// possible. `verifyOperator` returns the grant; its `scope` is the only
// environment the caller gets.

import { err, ok, type EnvironmentScope, type ProjectId, type Result } from "@platos/kernel";
import {
  authorizes,
  type EnvironmentOperatorAuthorization as TenancyOperatorGrant,
} from "@platos/context-tenancy";

import { scopeMismatch } from "../domain/index.js";
import type { AgentsDependencies } from "./dependencies.js";

export type { TenancyOperatorGrant };

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
  dependencies: AgentsDependencies,
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
 * FROM the grant, which is the shape that cannot mismatch. The exceptions are
 * the paths that must compare a scope they were handed against the one they were
 * granted, and those are the paths this exists for.
 */
export function verifyOperatorGrant(
  dependencies: AgentsDependencies,
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

/**
 * The project an environment grant reaches.
 *
 * `Agent` hangs off Project and `AgentBinding` off Environment, so almost every
 * use case here needs both. Deriving the project from the grant's own re-derived
 * scope — rather than accepting one on the command — is what keeps the
 * project-scoped half of this context inside the environment-scoped
 * authorization it was granted.
 */
export function projectOf(grant: TenancyOperatorGrant): ProjectId {
  return grant.scope.projectId;
}

function pathOf(scope: {
  readonly organizationId: string;
  readonly projectId: string;
  readonly environmentId: string;
}): string {
  return `org/${scope.organizationId}/proj/${scope.projectId}/env/${scope.environmentId}`;
}
