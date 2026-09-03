// The environment authorization value object.
//
// Two properties of the oracle are security controls rather than style, and
// both are preserved exactly.
//
// (1) UNFORGEABLE. `authorizeEnvironmentOperator` returns
//     `Object.freeze({ [environmentAuthorizationBrand]: true, ... })` where the
//     brand is a module-private `unique symbol`. A caller downstream cannot
//     write `{ access: "secret:mutate", ... }` and pass it off as an
//     authorization, because it cannot name the symbol. Here that is split into
//     two halves so it holds at BOTH compile time and run time:
//       * a `declare const` phantom brand, which no object literal can satisfy,
//         so a forged value is a type error; and
//       * a module-private WeakSet of the values this module actually minted,
//         so a value cast through `as unknown` — or copied field by field out
//         of a genuine one — is still rejected at run time by
//         `isEnvironmentOperatorAuthorization`.
//     Freezing is checked too: an authorization whose `access` was upgraded
//     after issue is not the value that was issued.
//
// (2) RE-DERIVED FROM THE LEAF. The ids on the returned value come from the
//     ancestry loaded from `environmentId` alone — `environment.id`,
//     `environment.project.id`, `environment.project.organizationId` — never
//     from the request. See `ancestry.ts`.
//
// SCOPE OF THIS FILE. Only the OPERATOR principal is modelled. The oracle also
// has `authorizeEnvironmentRuntime` (access `secret:read`) and
// `authorizeEnvironmentService` (`secret:write`), which share gate 1 and skip
// gates 2-4 entirely because a runtime actor has no membership. Their principal
// is authenticated by identity-access, so they land here only once that
// context's contract is settled; the ancestry half they need is already
// available as `archivedAncestor`.

import type { EnvironmentScope } from "@platos/kernel";
import { err, ok, type Result } from "@platos/kernel";

import { ancestryScope, archivedAncestor, isAncestryConsistent, type EnvironmentAncestry } from "./ancestry.js";
import { environmentForbidden, forgedAuthorization } from "./errors.js";
import type { UserId } from "./identifiers.js";
import { isActiveMembership, type OrganizationMembershipRecord, type ProjectMembershipRecord } from "./membership.js";
import { isOrganizationAdmin, isProjectAdmin, PrincipalTier, type OrganizationRole, type ProjectRole } from "./roles.js";

/**
 * The two access levels the oracle discriminates. `metadata` is the default
 * read/administer level; `secret:mutate` is the one gate 4 narrows.
 */
export type EnvironmentAccess = "metadata" | "secret:mutate";

/** Compile-time brand. Not exported, and `declare` emits no JavaScript. */
declare const environmentAuthorizationBrand: unique symbol;

/**
 * Run-time register of the values this module actually minted.
 *
 * A module-private symbol stamped on the object would NOT be enough: object
 * spread copies own enumerable symbol keys, so `{ ...authorization, access:
 * "secret:mutate" }` would carry the mark across and be accepted. Identity is
 * the only property a copy cannot forge, so membership of this set — not the
 * shape of the value — is what `isEnvironmentOperatorAuthorization` tests.
 *
 * Weak, so an authorization is collected with the request that produced it, and
 * process-local, which is the correct semantics: an authorization is a
 * capability held in memory, not a token that survives serialization. A value
 * that has crossed a wire must be re-derived, never re-trusted.
 */
const issuedAuthorizations = new WeakSet<object>();

export interface EnvironmentOperatorAuthorization {
  readonly [environmentAuthorizationBrand]: true;
  readonly principalType: "operator";
  readonly tier: typeof PrincipalTier.OPERATOR;
  readonly access: EnvironmentAccess;
  /** Re-derived from the leaf; the only scope this value authorizes. */
  readonly scope: EnvironmentScope;
  /** Who really acted — preserved through impersonation. */
  readonly actorUserId: UserId;
  /** Whose privileges were evaluated. Equals `actorUserId` when not impersonating. */
  readonly effectiveUserId: UserId;
  readonly organizationRole: OrganizationRole;
  readonly projectRole: ProjectRole | null;
}

/** The already-authenticated operator identity-access handed us. */
export interface OperatorPrincipal {
  readonly actorUserId: UserId;
  readonly effectiveUserId: UserId;
}

export interface EnvironmentAuthorizationInput {
  /** Loaded from the environment id alone. `null` when there is no such row. */
  readonly ancestry: EnvironmentAncestry | null;
  readonly organizationMembership: OrganizationMembershipRecord | null;
  readonly projectMembership: ProjectMembershipRecord | null;
  readonly operator: OperatorPrincipal;
  readonly access: EnvironmentAccess;
}

function grant(
  input: EnvironmentAuthorizationInput,
  ancestry: EnvironmentAncestry,
  organizationMembership: OrganizationMembershipRecord,
  projectRole: ProjectRole | null,
): EnvironmentOperatorAuthorization {
  const value = {
    principalType: "operator",
    tier: PrincipalTier.OPERATOR,
    access: input.access,
    scope: ancestryScope(ancestry),
    actorUserId: input.operator.actorUserId,
    effectiveUserId: input.operator.effectiveUserId,
    organizationRole: organizationMembership.role,
    projectRole,
  };
  const frozen = Object.freeze(value);
  issuedAuthorizations.add(frozen);
  return frozen as unknown as EnvironmentOperatorAuthorization;
}

/**
 * The four gates, in the oracle's order. Every denial is the same
 * `TENANCY_ENVIRONMENT_FORBIDDEN`; only `details.gate` differs, and details are
 * log-only.
 */
export function decideEnvironmentAccess(
  input: EnvironmentAuthorizationInput,
): Result<EnvironmentOperatorAuthorization> {
  const { ancestry } = input;
  // GATE 1 — the environment exists and no ancestor is archived. A missing row
  // and an archived one are the same answer, so probing cannot enumerate ids.
  if (ancestry === null || archivedAncestor(ancestry) !== null) {
    return err(environmentForbidden("archived-ancestor"));
  }
  if (!isAncestryConsistent(ancestry)) {
    return err(environmentForbidden("inconsistent-ancestry"));
  }

  // GATE 2 — an ACTIVE organization membership for the effective user.
  const organizationMembership = input.organizationMembership;
  if (organizationMembership === null || !isActiveMembership(organizationMembership)) {
    return err(environmentForbidden("organization-membership"));
  }
  if (organizationMembership.organizationId !== ancestry.organization.id) {
    return err(environmentForbidden("organization-membership"));
  }
  if (organizationMembership.userId !== input.operator.effectiveUserId) {
    return err(environmentForbidden("organization-membership"));
  }

  // GATE 3 — an organization admin needs no project membership; anybody else does.
  const organizationAdmin = isOrganizationAdmin(organizationMembership.role);
  const projectMembership = input.projectMembership;
  if (!organizationAdmin && projectMembership === null) {
    return err(environmentForbidden("project-membership"));
  }
  if (projectMembership !== null && !projectMembershipMatches(projectMembership, ancestry, organizationMembership)) {
    return err(environmentForbidden("project-membership"));
  }

  // GATE 4 — mutating a secret needs org-admin or project ADMIN. An EDITOR and
  // a VIEWER are both refused, identically.
  const projectRole = projectMembership?.role ?? null;
  if (input.access === "secret:mutate" && !organizationAdmin && !isProjectAdmin(projectRole)) {
    return err(environmentForbidden("secret-mutate-role"));
  }

  return ok(grant(input, ancestry, organizationMembership, projectRole));
}

/**
 * A project membership only counts if it is this project's, this membership's,
 * and carries the matching integrity key. The oracle gets this from the unique
 * lookup `projectId_organizationMembershipId`; stating it keeps a fake or a
 * cache from smuggling in somebody else's row.
 */
function projectMembershipMatches(
  projectMembership: ProjectMembershipRecord,
  ancestry: EnvironmentAncestry,
  organizationMembership: OrganizationMembershipRecord,
): boolean {
  return (
    projectMembership.projectId === ancestry.project.id &&
    projectMembership.organizationMembershipId === organizationMembership.id &&
    projectMembership.organizationId === ancestry.organization.id
  );
}

/**
 * The run-time half of unforgeability. A downstream context that receives an
 * `EnvironmentOperatorAuthorization` over a boundary where the type was erased
 * — a queue payload, a JSON round trip, an `unknown` from a transport — calls
 * this before trusting it.
 */
export function isEnvironmentOperatorAuthorization(
  value: unknown,
): value is EnvironmentOperatorAuthorization {
  if (typeof value !== "object" || value === null) return false;
  // Both halves matter: identity proves this module minted it, and the freeze
  // check proves nothing has since been assigned onto it.
  return issuedAuthorizations.has(value) && Object.isFrozen(value);
}

/** `isEnvironmentOperatorAuthorization` as a `Result`, for use-case composition. */
export function requireAuthorization(value: unknown): Result<EnvironmentOperatorAuthorization> {
  return isEnvironmentOperatorAuthorization(value) ? ok(value) : err(forgedAuthorization());
}

/**
 * An authorization proves access to ONE environment. Asking it about a
 * different one is answered from its own re-derived scope, never from an id the
 * caller also supplied.
 */
export function authorizes(
  authorization: EnvironmentOperatorAuthorization,
  scope: EnvironmentScope,
): boolean {
  return (
    authorization.scope.organizationId === scope.organizationId &&
    authorization.scope.projectId === scope.projectId &&
    authorization.scope.environmentId === scope.environmentId
  );
}
