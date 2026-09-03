// The published surface of identity-access.
//
// ADR M0.3 §2: another context may import THIS and nothing else — never
// `domain/`, never `application/`, never an adapter
// (`cross-context-contracts-only`). Three contexts are on the allow-list to
// import it (`tenancy`, `tools`, `channels`) plus the composition root, and
// rule (g) `identity-isolation` guarantees the arrow never points back: this
// context imports nothing but the kernel.
//
// THE DTOs BELOW ARE NOT THE DOMAIN ENTITIES. They are flat, serialisable
// projections carrying only what a caller needs to make an authorization
// decision. A consumer that received `OperatorSessionRecord` would be holding
// `tokenHash`, `parentSessionId` and the impersonation chain — internals it has
// no business with, and which could not then be changed without breaking it.
//
// WHAT IS DELIBERATELY ABSENT: minting. No other context may issue a session, a
// magic link, an access key or an OAuth pair. Those use cases exist in
// `application/` and are reachable only from the composition root's transports,
// so "who can create a credential" has exactly one answer.

import type { DomainError, PrincipalId, Result, TenantScope } from "@platos/kernel";

export type { AuthorizationScopeKind, PrincipalTier, TokenKind } from "../domain/index.js";
export { TOKEN_PREFIXES, classifyToken, prefixOf } from "../domain/index.js";
export type { AuthRateLimitAction, RateLimitPolicy } from "../domain/index.js";

/**
 * A grant's reach, flattened for the wire.
 *
 * `tenant` is null exactly when `kind` is GLOBAL. The domain models this as a
 * discriminated union; the contract keeps the nullable form because it has to
 * survive JSON, and the two agree at the boundary.
 */
export interface AuthorizationScopeView {
  readonly kind: "GLOBAL" | "ORGANIZATION" | "PROJECT" | "ENVIRONMENT";
  readonly tenant: TenantScope | null;
}

/** The result of authenticating a dashboard session. */
export interface OperatorAuthorizationView {
  readonly sessionId: string;
  /** The real human. Never the impersonated account. */
  readonly actorUserId: string;
  /** Whose permissions apply — the impersonated account, when impersonating. */
  readonly effectiveUserId: string;
  readonly email: string;
  readonly expiresAt: Date;
  readonly mfaVerifiedAt: Date | null;
  /** Present only while impersonation is active. */
  readonly impersonating: { readonly targetUserId: string } | null;
}

/** The result of authenticating a scoped bearer credential. */
export interface PrincipalAuthorizationView {
  readonly principalId: PrincipalId;
  readonly tier: "OPERATOR" | "END_USER";
  readonly credentialId: string;
  readonly scope: AuthorizationScopeView;
  readonly permissions: readonly string[];
}

export type RateLimitOutcome = "allowed" | "limited" | "degraded";

export interface RateLimitDecisionView {
  readonly outcome: RateLimitOutcome;
  /** Populated only when `outcome` is `"limited"`. */
  readonly retryAfterSeconds: number | null;
}

export interface AuthenticateOperatorRequest {
  readonly presentedToken: string | null;
}

export interface AuthenticateBearerRequest {
  readonly presentedToken: string | null;
  /** Where the request is addressed. Null skips the cross-scope check. */
  readonly requestedScope: TenantScope | null;
  readonly requiredPermission?: string;
}

export interface RateLimitRequest {
  readonly action: "LOGIN" | "INVITE_ACCEPT" | "MFA_VERIFY";
  readonly identifier: string;
  readonly scope: TenantScope;
  readonly principalId: PrincipalId | null;
}

/**
 * The identity-access façade.
 *
 * Every method returns `Result`, so a consumer's failure handling is
 * type-checked rather than discovered. `DomainError.category` is what a
 * transport maps to its own status space; no method here names an HTTP status.
 */
export interface IdentityAccessContract {
  readonly name: "identity-access";

  /** Verify a dashboard session token. */
  authenticateOperator(
    request: AuthenticateOperatorRequest,
  ): Promise<Result<OperatorAuthorizationView>>;

  /**
   * Verify a scoped bearer credential and, when a scope is supplied, deny it
   * across scopes. This is the method `tools` and `channels` call, and the
   * reason neither of them needs its own notion of who is calling.
   */
  authenticateBearer(
    request: AuthenticateBearerRequest,
  ): Promise<Result<PrincipalAuthorizationView>>;

  /**
   * Spend one unit of an authentication budget.
   *
   * A `degraded` outcome means the limiter was unreachable and the request was
   * allowed through under the documented fail-open policy. It is reported rather
   * than hidden, so a caller that must not run unlimited can refuse.
   */
  consumeRateLimit(request: RateLimitRequest): Promise<Result<RateLimitDecisionView>>;
}

/**
 * Integration events this context publishes through the kernel `OutboxWriter`.
 *
 * Dotted, first segment names the owning context (kernel `DomainEvent`).
 * Renaming one is a breaking change; a consumer ignores names it does not know.
 */
export const IDENTITY_ACCESS_EVENTS = {
  operatorSessionStarted: "identity.session.started",
  operatorSessionRevoked: "identity.session.revoked",
  secondFactorEnrolled: "identity.mfa.enrolled",
  impersonationStarted: "identity.impersonation.started",
  impersonationStopped: "identity.impersonation.stopped",
  accessKeyRotated: "identity.access_key.rotated",
  accessKeysRevoked: "identity.access_key.revoked",
  refreshTokenReplayed: "identity.oauth.refresh_token_replayed",
  rateLimitExceeded: "identity.rate_limit.exceeded",
} as const;

export type IdentityAccessEventName =
  (typeof IDENTITY_ACCESS_EVENTS)[keyof typeof IDENTITY_ACCESS_EVENTS];

/** The failure codes a consumer may branch on. Stable within a major. */
export const IDENTITY_ACCESS_ERROR_CODES = [
  "UNAUTHENTICATED",
  "SESSION_EXPIRED",
  "SESSION_REVOKED",
  "MFA_REQUIRED",
  "INVALID_MFA_CODE",
  "RATE_LIMITED",
  "FORBIDDEN_SCOPE",
  "IMPERSONATION_FORBIDDEN",
  "CREDENTIAL_EXPIRED",
  "CREDENTIAL_REVOKED",
  "TOKEN_REPLAYED",
  "INVALID_GRANT",
  "UNKNOWN_CLIENT",
  "INVALID_ACCESS_KEY_MATERIAL",
  "ACCESS_KEY_ROTATION_SUPERSEDED",
  "BOOTSTRAP_GRANT_UNAVAILABLE",
  "IDENTITY_STORE_UNAVAILABLE",
] as const;

export type IdentityAccessErrorCode = (typeof IDENTITY_ACCESS_ERROR_CODES)[number];

export function isIdentityAccessError(error: DomainError): error is DomainError & {
  readonly code: IdentityAccessErrorCode;
} {
  return (IDENTITY_ACCESS_ERROR_CODES as readonly string[]).includes(error.code);
}
