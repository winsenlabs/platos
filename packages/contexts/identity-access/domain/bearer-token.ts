// The scoped bearer credentials: McpToken, McpBearerToken, PersonalAccessToken
// and EndUserSession.
//
// These four rows differ in which table they live in and almost nothing else.
// Each is a hashed opaque secret with an optional expiry, an optional
// revocation, a tier, a scope and a permission list, and each was being
// verified by its own hand-written sequence of null checks. Modelling them once
// means the expired-before-revoked ordering, the scope check and the permission
// check cannot drift apart between them.
//
// MODELLING NOTE — PersonalAccessToken and EndUserSession.
// Both tables exist in the baseline schema and both have ZERO production call
// sites: nothing mints them and nothing verifies them. They therefore have no
// behavioural oracle, and everything below about them is derived from the schema
// alone rather than from observed behaviour. They are modelled minimally and
// deliberately: the shared lifecycle, the scope, and nothing invented. When a
// call site appears, whatever it needs beyond this is new design and should be
// recorded as such rather than back-fitted onto a guess made here.

import { assertAuthorizes, assertPermission, type AuthorizationScope } from "./authorization-scope.js";
import { requireUsableAt, type RevocableCredential } from "./credential.js";
import type { PrincipalTier, TokenHash } from "./principal.js";
import { err, ok, type PrincipalId, type Result, type TenantScope } from "@platos/kernel";

export type BearerCredentialKind =
  /** McpToken — a minted platform MCP credential. Oracle: token.service. */
  | "mcp-token"
  /** McpBearerToken — an entity-scoped MCP credential. Oracle: mcp-bearer-token.service. */
  | "entity-bearer-token"
  /** PersonalAccessToken — schema only; see the modelling note above. */
  | "personal-access-token"
  /** EndUserSession — schema only; see the modelling note above. */
  | "end-user-session";

export interface BearerCredentialRecord extends RevocableCredential {
  readonly credentialId: string;
  readonly kind: BearerCredentialKind;
  readonly tokenHash: TokenHash;
  readonly tier: PrincipalTier;
  readonly principalId: PrincipalId;
  readonly scope: AuthorizationScope;
  readonly permissions: readonly string[];
  readonly lastUsedAt: Date | null;
}

export interface BearerAuthorization {
  readonly credentialId: string;
  readonly kind: BearerCredentialKind;
  readonly tier: PrincipalTier;
  readonly principalId: PrincipalId;
  readonly scope: AuthorizationScope;
  readonly permissions: readonly string[];
}

export interface BearerAuthenticationRequest {
  readonly credential: BearerCredentialRecord;
  /** Where the request is addressed. Null for a scope-agnostic introspection. */
  readonly requestedScope: TenantScope | null;
  /** The permission the operation needs, when it names one. */
  readonly requiredPermission: string | null;
  readonly now: Date;
}

/**
 * Lifecycle, then scope, then permission — in that order.
 *
 * Checking permission before scope would let a caller learn which permissions a
 * credential carries by probing an environment it cannot reach: the answers
 * would differ by permission rather than being uniformly "not authorized for
 * this scope". Lifecycle first, because a revoked credential must not be
 * evaluated for anything at all.
 */
export function authenticateBearerCredential(
  request: BearerAuthenticationRequest,
): Result<BearerAuthorization> {
  const usable = requireUsableAt(request.credential, request.now);
  if (!usable.ok) return err(usable.error);

  const credential = usable.value;
  if (request.requestedScope !== null) {
    const authorized = assertAuthorizes(credential.scope, request.requestedScope);
    if (!authorized.ok) return err(authorized.error);
  }
  if (request.requiredPermission !== null) {
    const permitted = assertPermission(credential.permissions, request.requiredPermission);
    if (!permitted.ok) return err(permitted.error);
  }

  return ok({
    credentialId: credential.credentialId,
    kind: credential.kind,
    tier: credential.tier,
    principalId: credential.principalId,
    scope: credential.scope,
    permissions: credential.permissions,
  });
}

export function touchedCredential(
  credential: BearerCredentialRecord,
  now: Date,
): BearerCredentialRecord {
  return { ...credential, lastUsedAt: now };
}

export function revokedCredential(
  credential: BearerCredentialRecord,
  now: Date,
): BearerCredentialRecord {
  return { ...credential, revokedAt: now };
}
