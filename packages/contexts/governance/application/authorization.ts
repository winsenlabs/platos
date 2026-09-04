// The grants this context accepts, and why the rating path needs a second one.
//
// THE SCOPE COMES FROM THE GRANT, NEVER FROM THE REQUEST. Every command in this
// package takes an `authorization` and no environment id. A command that carried
// both would have two answers to "which environment is this?", and the one an
// implementation reached for first would decide whether a cross-tenant write was
// possible. `verifyOperator` returns the grant; its `scope` is the only
// environment the caller gets.
//
// EVERY OPERATOR OPERATION HERE IS `metadata`-LEVEL, AND THAT IS A FINDING
// RATHER THAN AN OVERSIGHT. Tenancy discriminates exactly two access levels:
// `metadata`, its own note's "default read/administer level", and
// `secret:mutate`, which gate 4 narrows for the vault. Authoring an eval
// criterion, editing a golden set and reading the safety ledger are all
// administration, so the same grant that lets an operator READ this
// environment's safety events lets them REWRITE its criteria. That is the
// running system's behaviour — the governance surface checks the operator gate
// and nothing finer — and it is recorded here and in `contracts/index.ts` so a
// later decision to separate the two is made deliberately rather than
// discovered.
//
// THE SECOND ACTOR, AND THE LIMIT THIS CONTEXT CANNOT REMOVE ON ITS OWN. A
// `MessageRating` is an END USER's opinion. Tenancy mints operator grants only,
// and `identity-access` — which authenticates end users — is not on this
// context's §1 row 14 allow-list, so this package cannot verify an end-user
// session itself. The rating commands therefore carry a discriminated `actor`:
// an operator actor is REFUSED outright, which is the source's own rule kept
// verbatim, and an end-user actor is an assertion made by the transport that
// authenticated the session. What this context CAN check, and does, is that the
// asserted end user owns the turn being rated — the ownership comes from the
// `RatingTargetReader`, not from the caller — so an authenticated end user still
// cannot reach another end user's turn. The limit is that the assertion itself
// is trusted; it is stated here rather than papered over.

import { err, ok, type EnvironmentScope, type Result } from "@platos/kernel";
import {
  authorizes,
  type EnvironmentOperatorAuthorization as TenancyOperatorGrant,
} from "@platos/context-tenancy";

import { ratingActorForbidden, scopeMismatch, type EndUserId } from "../domain/index.js";
import type { GovernanceDependencies } from "./dependencies.js";

export type { TenancyOperatorGrant };

/**
 * Who is writing a rating.
 *
 * A closed union rather than an optional `endUserId`, so "an operator with an
 * end-user id attached" is not a state this type can represent. The source's
 * check is `if (scope.principal === "operator") throw`, on a scope that carries
 * both, which is a refusal one forgotten branch away from not happening.
 */
export type RatingActor =
  | { readonly kind: "operator" }
  | { readonly kind: "end-user"; readonly endUserId: EndUserId };

/**
 * Verify an operator grant, by ASKING TENANCY.
 *
 * The check goes through `TenancyContract.verifyAuthorization` rather than
 * through the pure `requireAuthorization` this package could also import. An
 * authorization is genuine only if tenancy's own private mint register holds it,
 * and a grant arriving here as `unknown` from a transport is exactly the
 * "crossed a boundary where its type was erased" case that method exists for.
 * In the composition root the two are the same code.
 */
export function verifyOperator(
  dependencies: GovernanceDependencies,
  authorization: unknown,
): Result<TenancyOperatorGrant> {
  return dependencies.tenancy.verifyAuthorization(authorization);
}

/**
 * Verify a grant and confirm it authorizes the environment named.
 *
 * Most callers do not need this — they take the environment FROM the grant,
 * which is the shape that cannot mismatch. It exists for the paths that must
 * compare a scope they were handed against the one they were granted.
 */
export function verifyOperatorGrant(
  dependencies: GovernanceDependencies,
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
 * Verify the environment grant AND resolve the end user allowed to vote.
 *
 * The operator branch refuses before the environment is even read, because an
 * operator writing an end user's satisfaction score is not a scoping question.
 */
export function verifyRatingActor(
  dependencies: GovernanceDependencies,
  authorization: unknown,
  actor: RatingActor,
): Result<{ readonly grant: TenancyOperatorGrant; readonly endUserId: EndUserId }> {
  if (actor.kind === "operator") return err(ratingActorForbidden());
  const verified = verifyOperator(dependencies, authorization);
  if (!verified.ok) return err(verified.error);
  return ok({ grant: verified.value, endUserId: actor.endUserId });
}

function pathOf(scope: {
  readonly organizationId: string;
  readonly projectId: string;
  readonly environmentId: string;
}): string {
  return `org/${scope.organizationId}/proj/${scope.projectId}/env/${scope.environmentId}`;
}
