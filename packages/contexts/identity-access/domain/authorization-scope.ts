// What a credential is allowed to reach.
//
// Schema enum `AuthorizationScopeKind` = GLOBAL | ORGANIZATION | PROJECT |
// ENVIRONMENT. PersonalAccessToken, OAuthAccessToken, OAuthRefreshToken and
// OAuthAuthorizationCode each carry it beside three nullable id columns, and the
// combination "kind says PROJECT, projectId is null" is representable in the row
// and meaningless in the domain.
//
// The kernel already solved the tenant half: `TenantScope` is a discriminated
// union in which an environment scope cannot be missing its project. So an
// authorization scope here is GLOBAL, or a kernel `TenantScope` — and the four
// nullable columns collapse into one value that cannot be inconsistent.
//
// CROSS-SCOPE DENIAL IS THE PROPERTY THIS PROGRAMME CANNOT GET WRONG. It reduces
// to one predicate, `authorizes()`, built on the kernel's `contains()`. There is
// no second path: a use case that needs the check calls this, and a use case
// that forgets fails its negative control.

import { forbiddenScope } from "./errors.js";
import { contains, err, ok, resolvePath, type Result, type TenantScope } from "@platos/kernel";

export const AUTHORIZATION_SCOPE_KINDS = [
  "GLOBAL",
  "ORGANIZATION",
  "PROJECT",
  "ENVIRONMENT",
] as const;
export type AuthorizationScopeKind = (typeof AUTHORIZATION_SCOPE_KINDS)[number];

export interface GlobalAuthorizationScope {
  readonly kind: "GLOBAL";
}

export interface TenantAuthorizationScope {
  readonly kind: "ORGANIZATION" | "PROJECT" | "ENVIRONMENT";
  readonly tenant: TenantScope;
}

/** A grant is either unbounded, or bounded by one node of the tenant tree. */
export type AuthorizationScope = GlobalAuthorizationScope | TenantAuthorizationScope;

export const GLOBAL_SCOPE: GlobalAuthorizationScope = Object.freeze({ kind: "GLOBAL" });

const KIND_BY_LEVEL = {
  organization: "ORGANIZATION",
  project: "PROJECT",
  environment: "ENVIRONMENT",
} as const;

/** Lift a tenant node into a grant. The kind is derived, never supplied. */
export function tenantAuthorizationScope(tenant: TenantScope): TenantAuthorizationScope {
  return { kind: KIND_BY_LEVEL[tenant.level], tenant };
}

export function scopeKindOf(scope: AuthorizationScope): AuthorizationScopeKind {
  return scope.kind;
}

/**
 * The single containment predicate every authorization decision reduces to.
 *
 * GLOBAL reaches everything — that is what makes it the scope a platform
 * operator credential carries and an ordinary one never does. Every other grant
 * reaches exactly its own subtree, so an environment-scoped token is denied its
 * sibling environment, its parent project, and every other organization.
 */
export function authorizes(granted: AuthorizationScope, requested: TenantScope): boolean {
  if (granted.kind === "GLOBAL") return true;
  return contains(granted.tenant, requested);
}

export function assertAuthorizes(
  granted: AuthorizationScope,
  requested: TenantScope,
): Result<TenantScope> {
  if (!authorizes(granted, requested)) {
    return err(
      forbiddenScope(`Credential is not authorized for ${resolvePath(requested)}`),
    );
  }
  return ok(requested);
}

/**
 * Permission strings are compared exactly, with one wildcard.
 *
 * `*` grants everything. There is no prefix matching and no namespace glob:
 * `mcp:*` does not grant `mcp:write`, because a permission language with
 * partial matching is one where a new permission silently joins old grants.
 */
export const WILDCARD_PERMISSION = "*";

export function hasPermission(granted: readonly string[], required: string): boolean {
  return granted.includes(WILDCARD_PERMISSION) || granted.includes(required);
}

export function assertPermission(
  granted: readonly string[],
  required: string,
): Result<string> {
  if (!hasPermission(granted, required)) {
    return err(forbiddenScope(`Credential does not carry the ${required} permission`));
  }
  return ok(required);
}
