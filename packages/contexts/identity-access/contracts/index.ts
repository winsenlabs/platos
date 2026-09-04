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
//
// `issueSessionCookie` IS NOT AN EXCEPTION TO THAT. It mints no credential: it
// takes a token `issueOperatorSession` already returned and decides how a
// browser must hold it. A caller that has no token cannot obtain one here.

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

/** Every outcome the limiter can reach, including the one that is a refusal. */
export type RateLimitOutcome = "allowed" | "limited" | "degraded";

/**
 * What a SUCCESSFUL consumption reports.
 *
 * `limited` is deliberately not among these. A limited decision is a REFUSAL, so
 * it arrives as `err` with code `RATE_LIMITED`, and the kernel error's
 * `retryAfterSeconds` carries the wait. That way a caller which ignores the
 * failure branch cannot proceed — the property an authentication budget needs —
 * whereas an `ok` carrying `outcome: "limited"` would let a forgotten check
 * become an unlimited window.
 */
export interface RateLimitDecisionView {
  readonly outcome: Exclude<RateLimitOutcome, "limited">;
  /** Requests left in the current window; null when the limiter was degraded. */
  readonly remaining: number | null;
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

/**
 * One identity that reaches an end user, as the accounts listing renders it.
 *
 * `identityId` is deliberately absent — the same reasoning that drops `kind`
 * from `PrincipalAuthorizationView`. It is a storage fact, the oracle's own
 * `select` does not return it, and a consumer that held it would be able to
 * address a row this contract publishes no operation for.
 */
export interface EndUserIdentityView {
  readonly issuer: string;
  readonly channel: string;
  readonly subject: string;
  readonly verifiedAt: Date | null;
  readonly disabledAt: Date | null;
}

/**
 * An end user — the SECOND principal tier, and never an operator.
 *
 * `organizationId` is absent because it cannot be anything but the scope the
 * caller asked under: echoing it back would invite a consumer to believe the
 * listing decided which tenant to answer for, when the authorized scope did.
 */
export interface EndUserView {
  readonly endUserId: string;
  readonly displayName: string | null;
  readonly disabledAt: Date | null;
  readonly createdAt: Date;
  readonly identities: readonly EndUserIdentityView[];
}

export interface EndUserPageView {
  readonly users: readonly EndUserView[];
  /** Rows matching the filters, ignoring the page window. */
  readonly total: number;
  readonly limit: number;
  readonly offset: number;
  readonly hasMore: boolean;
}

/**
 * NOTE WHAT IS MISSING: an organization id.
 *
 * The tenant is taken from `scope`, which is the value tenancy minted by
 * re-deriving the whole chain from a leaf. There is no field on this request a
 * caller could use to address another tenant.
 */
export interface ListEndUsersRequest {
  readonly scope: TenantScope;
  /** `active`, `disabled`, or absent. Anything else is refused, not ignored. */
  readonly status?: string | null;
  readonly search?: string | null;
  readonly limit?: number;
  readonly offset?: number;
}

/**
 * The session-cookie exchange contract.
 *
 * CORE OWNS THE SHAPE; A BFF MAY ONLY SET THE BYTES. Every attribute that makes
 * the credential safe — the `__Host-` prefix, `Secure`, `HttpOnly`, `SameSite`,
 * `Path`, the absence of `Domain`, and the lifetime — was decided in the Remix
 * tree, where a second front end would have decided them again and got one of
 * them wrong. They are decided here, once, and refused rather than corrected
 * when a caller asks for a combination a browser would drop.
 */
export interface SessionCookieShapeView {
  readonly name: string;
  readonly httpOnly: true;
  readonly path: "/";
  readonly sameSite: "lax" | "strict";
  readonly secure: boolean;
  /** Always null. `__Host-` forbids the attribute; see domain/session-cookie.ts. */
  readonly domain: null;
}

export interface SessionCookieDirectiveView {
  readonly shape: SessionCookieShapeView;
  /** The raw token, or the empty string when clearing. */
  readonly value: string;
  readonly expiresAt: Date;
  readonly maxAgeSeconds: number;
}

/** ONE fact decides the shape: whether the browser reaches this over TLS. */
export interface SessionTransport {
  readonly secure: boolean;
}

export interface IssueSessionCookieRequest extends SessionTransport {
  readonly token: string;
  /** The session's own expiry. A cookie may not be asked to outlive it. */
  readonly sessionExpiresAt: Date;
  /** A SHORTER browser lifetime, when a caller wants one. Never longer. */
  readonly expiresAt?: Date;
}

export interface RotateSessionCookieRequest extends IssueSessionCookieRequest {
  /** The token being replaced. A "rotation" that reuses it is refused. */
  readonly previousToken: string;
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

  /**
   * List the end users of one tenant, with the total the page is a window into.
   *
   * This context is sole writer of `EndUser` and published no read of it, so the
   * only listing in the product reached past every contract into the database.
   * An over-large page, an unknown status and an over-long search term are
   * REFUSALS rather than corrections: a silently clamped page is a caller that
   * believes it has seen everything.
   */
  listEndUsers(request: ListEndUsersRequest): Promise<Result<EndUserPageView>>;

  /** The cookie attributes for one install, before any value is put in it. */
  describeSessionCookie(transport: SessionTransport): Result<SessionCookieShapeView>;

  /** The directive that puts a live session in a browser. */
  issueSessionCookie(request: IssueSessionCookieRequest): Result<SessionCookieDirectiveView>;

  /**
   * The directive for a session whose token has just changed — MFA verified,
   * impersonation started or stopped. Refuses to re-issue the same token.
   */
  rotateSessionCookie(request: RotateSessionCookieRequest): Result<SessionCookieDirectiveView>;

  /** The directive that ends the session in the browser. */
  clearSessionCookie(transport: SessionTransport): Result<SessionCookieDirectiveView>;

  /**
   * Recognise a directive this context minted and nobody has modified.
   *
   * It does not stop a BFF writing whatever header it likes — nothing in a
   * process can. It stops a MODIFIED directive being accepted back, which is
   * what makes "the BFF only sets the bytes" checkable at the seam.
   */
  verifySessionCookie(value: unknown): Result<SessionCookieDirectiveView>;
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
  "INVALID_END_USER_FILTER",
  "INVALID_SESSION_COOKIE",
  "UNAUTHENTICATED",
  "SESSION_EXPIRED",
  "SESSION_REVOKED",
  "MFA_REQUIRED",
  "INVALID_MFA_CODE",
  "RATE_LIMITED",
  "FORBIDDEN_SCOPE",
  "MISSING_PERMISSION",
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
