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
 * WIN-268 (M4.2) P1 — the mint's vocabulary.
 *
 * `MintableBearerKind` and `McpPermissionTier` are re-exported because a caller
 * has to NAME one to call `mintBearerCredential`, and a transport that spelled
 * `"mcp-token"` as a string literal would be a second declaration of the
 * enumeration. `MCP_PERMISSION_TIERS` travels as a value for the same reason a
 * validator needs it: to refuse anything that is not one of the two without
 * writing the two down again.
 */
export type { McpPermissionTier, MintableBearerKind } from "../domain/index.js";
export { MCP_PERMISSION_TIERS, MINTABLE_BEARER_KINDS, isMintableBearerKind } from "../domain/index.js";
/**
 * WIN-268 (M4.2) stage 2 — the LISTING and REVOCATION vocabulary.
 *
 * `ListableBearerKind` travels for the same reason `MintableBearerKind` does: a
 * transport has to NAME a kind to call either method, and one that spelled
 * `"mcp-token"` as a string literal would be a second declaration of the
 * enumeration. `LISTABLE_BEARER_KINDS` travels as a VALUE so a request validator
 * can refuse anything outside it without writing the two names down again.
 *
 * IT IS A DIFFERENT CONSTANT FROM `MINTABLE_BEARER_KINDS` even though the two
 * currently hold the same two names, because they answer different questions. The
 * day something mints a `PersonalAccessToken`, one grows and the other should not
 * follow by accident.
 */
import type { ListableBearerKind, McpPermissionTier } from "../domain/index.js";
export type { ListableBearerKind };
export { LISTABLE_BEARER_KINDS, isListableBearerKind } from "../domain/index.js";
import type {
  MintBearerCredentialCommand,
  MintedBearerCredentialView,
} from "../application/mint-bearer-credential.js";
export type { MintBearerCredentialCommand, MintedBearerCredentialView };

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

/**
 * The credential whose session is to be ENDED.
 *
 * A separate type from `AuthenticateOperatorRequest` even though the field is
 * the same one, because the two carry different authority: presenting a token to
 * be checked is a read, and presenting it to be destroyed is a write. A shared
 * type would make widening one of them silently widen the other.
 */
export interface RevokeOperatorSessionRequest {
  readonly presentedToken: string | null;
}

/**
 * What a SUCCESSFUL revocation reports.
 *
 * `revokedAt` is the instant the store now holds, not the instant the caller
 * asked — a caller that stamped its own clock into an audit line would be
 * recording something no row says.
 *
 * NOTHING ELSE IS HERE. The use case returns the whole `OperatorSessionRecord`,
 * which carries `tokenHash`, `parentSessionId` and the impersonation chain; this
 * context's own banner calls those "internals it has no business with", and a
 * sign-out has less business with them than anything else on this contract.
 */
export interface RevokedOperatorSessionView {
  readonly sessionId: string;
  readonly revokedAt: Date;
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

// ---------------------------------------------------------------------------
// WIN-268 (M4.2) stage 2 — THE BEARER CREDENTIAL LISTING AND REVOCATION.
//
// `mintBearerCredential` below made two of the four MCP token routes servable on
// the V1 chassis. These two make the other four servable, and the register that
// measured the gap said so by name: "there is no `listBearerCredentials` and no
// `revokeBearerCredential`, so `GET /mcp/entity/:entityId/tokens` and
// `DELETE /mcp/entity/:entityId/tokens/:tokenId` cannot be served from a
// contract."
//
// THE SCOPE IS AN `ENVIRONMENT` TenantScope AND THERE IS NO OTHER TENANT FIELD.
// The same shape `ListEndUsersRequest` has and the same reason: the value arrives
// from `tenancy`'s four-gate decision, which re-derived the whole chain from the
// leaf, so a caller has nothing on either request it could substitute.
// ---------------------------------------------------------------------------

/** One credential as a listing shows it. NO DIGEST — see `BearerCredentialsRequest`. */
export interface BearerCredentialView {
  readonly credentialId: string;
  readonly kind: ListableBearerKind;
  /** `McpToken.name` / `McpBearerToken.label`. */
  readonly label: string;
  /** Whom it acts as: the minting operator, or the entity's own end-user id. */
  readonly principalId: PrincipalId;
  readonly permissions: readonly string[];
  /** `McpToken.tier`. Null for an entity token, whose table has no such column. */
  readonly permissionTier: McpPermissionTier | null;
  /** The entity, for an entity token. Null for a platform one. */
  readonly subjectId: string | null;
  /** RE-DERIVED by the store from the row's own ancestry, never echoed. */
  readonly scope: AuthorizationScopeView;
  readonly createdAt: Date;
  readonly expiresAt: Date | null;
  readonly lastUsedAt: Date | null;
  readonly revokedAt: Date | null;
}

/**
 * A page of credentials.
 *
 * WHAT IS DELIBERATELY ABSENT IS THE TOKEN DIGEST. `PrincipalAuthorizationView`
 * carries `credentialId` and no hash for the same reason, and here the reason has
 * teeth: one call returns up to a hundred rows, so a projection that carried the
 * digest would hand a caller a verifier for every live credential in an
 * environment. The domain models the listing row as a type of its own
 * (`BearerCredentialSummary`) with no digest field at all, so no store can leak it
 * by forgetting to strip it.
 */
export interface BearerCredentialPageView {
  readonly credentials: readonly BearerCredentialView[];
  /** Rows matching the query, ignoring the page window. */
  readonly total: number;
  readonly limit: number;
  readonly offset: number;
  readonly hasMore: boolean;
}

export interface BearerCredentialsRequest {
  readonly kind: ListableBearerKind;
  readonly scope: TenantScope;
  /**
   * The entity, for `entity-bearer-token`. REQUIRED for that kind and REFUSED
   * for `mcp-token`: `McpBearerToken` is keyed by (entity, environment) and
   * `McpToken` has no entity column, so a subject accepted and ignored on a
   * platform listing would answer a question the caller did not ask.
   */
  readonly subjectId?: string | null;
  /** Refused above 100 rather than clamped. See `RevokeBearerCredentialRequest`. */
  readonly limit?: number;
  readonly offset?: number;
}

export interface RevokeBearerCredentialRequest {
  readonly kind: ListableBearerKind;
  readonly credentialId: string;
  readonly scope: TenantScope;
  readonly subjectId?: string | null;
  /** The operator who asked. Recorded where the table has a column for it. */
  readonly revokedByUserId: string;
}

/**
 * What a revocation says happened — THREE STATES, NOT A BOOLEAN.
 *
 * Both legacy services return a boolean in which `true` covers "this call
 * revoked it" and "somebody had already revoked it". Those are different facts
 * and a caller cannot act on either without knowing which it got: a dashboard
 * that reported "revoked" for a credential somebody else killed an hour ago is
 * telling its operator they did something they did not do.
 *
 * `outcome: "absent"` DOES NOT DISTINGUISH "no such credential" FROM "not in your
 * environment", and that collapse is the opposite decision made for the opposite
 * reason: separating them would confirm the existence of a credential the caller
 * does not own, which is an existence oracle across tenants.
 */
export interface RevokedBearerCredentialView {
  readonly outcome: "revoked" | "alreadyRevoked" | "absent";
  /** The credential as it now stands. Null exactly when `outcome` is `absent`. */
  readonly credential: BearerCredentialView | null;
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
   * END a dashboard session, server-side (WIN-267 W3).
   *
   * WHY THIS IS PUBLISHED AND MINTING IS NOT. The banner above says no other
   * context may ISSUE a credential, and that is unchanged: this method creates
   * nothing and can only ever be aimed at a credential the caller is already
   * holding. A caller with no token cannot end anybody's session, and a caller
   * with a token can already do everything that session can do — so publishing
   * the destruction of it hands out no authority the presenter did not have.
   *
   * IT IS THE OTHER HALF OF `clearSessionCookie`, AND UNTIL NOW ONLY ONE HALF
   * EXISTED. `DELETE /api/v1/bff/session` could clear the browser and nothing
   * more, because `revokeOperatorSession` lived in `application/` behind no
   * contract method and a V1 transport may only reach a contract method. A user
   * who signed out was told the session had ended while it stayed valid, on the
   * server, for the rest of its lifetime — which is precisely the window a
   * stolen cookie is stolen for. The two are separate methods rather than one
   * because they fail independently: the row is ended even if the header never
   * reaches the browser, and that is the order a sign-out must happen in.
   *
   * THE REFUSALS ARE THREE AND THEY ARE DISTINCT. `UNAUTHENTICATED` for an
   * absent token and for one no row matches — deliberately the same code, since
   * separating them would confirm whether a token exists — and `SESSION_REVOKED`
   * for a session that was already ended, which tells the caller only what
   * holding that token already told them. `SESSION_EXPIRED` is NOT among them: a
   * session past its window is still ended on request, exactly as the extraction
   * source's conditional update does, so a lapsed browser can still be signed
   * out for good.
   */
  revokeOperatorSession(
    request: RevokeOperatorSessionRequest,
  ): Promise<Result<RevokedOperatorSessionView>>;

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

  /**
   * List the MCP bearer credentials of one environment.
   *
   * REFUSES AN OVER-LARGE PAGE RATHER THAN CLAMPING IT, which is the one place
   * this pair departs from the legacy services on purpose. Both of them call
   * `boundedInteger(limit, 50, 1, 100)`, so a caller that asked for 500 rows is
   * answered with 100 and TOLD `limit: 100`; paging by the number it sent then
   * walks past the end of the collection while believing it has seen everything.
   * `listEndUsers` above already made this call for the same reason. The default
   * and the ceiling are still the legacy numbers.
   */
  listBearerCredentials(
    request: BearerCredentialsRequest,
  ): Promise<Result<BearerCredentialPageView>>;

  /**
   * Revoke one MCP bearer credential, idempotently, and say which of three
   * things happened.
   *
   * IT IS THE HALF OF THE CREDENTIAL LIFECYCLE THIS CONTRACT WAS MISSING.
   * `mintBearerCredential` creates one and `authenticateBearer` verifies one;
   * until this method existed nothing published could END one, so the only way to
   * withdraw a leaked ninety-day credential was the legacy deployable's own
   * route. A `Result` that is `ok` with `outcome: "absent"` is a well-formed
   * question about a credential that is not there — not a failed request.
   */
  revokeBearerCredential(
    request: RevokeBearerCredentialRequest,
  ): Promise<Result<RevokedBearerCredentialView>>;

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

  /**
   * Mint one of the two MCP bearer credentials, returning the ONLY copy of the
   * secret.
   *
   * WHY IT IS ON THE CONTRACT AT ALL. `apps/core-api`'s
   * `idempotency-policy.ts` classes eight operations `required` — no
   * `Idempotency-Key`, no execution — and two of them mint an MCP token. A V1
   * route may only reach a contract method, so until this one existed the gate
   * was binding two operations that could not be served: the winner of an
   * idempotency race reached the framework's own 404 while holding a
   * reservation that then replayed the 404 for a day.
   *
   * THE SCOPE THAT ARRIVES IS THE ONE THE CALLER WAS AUTHORIZED FOR. It must be
   * an ENVIRONMENT scope, and it is re-derived by the store from the
   * environment's own ancestry before the view is built, so a forged
   * organization/project/environment triple cannot survive the round trip. The
   * cross-tenant DECISION is `tenancy`'s and is made before this call; what is
   * enforced here is that nothing the request said about tenancy is echoed back.
   *
   * ONLY TWO OF THE FOUR BEARER KINDS ARE MINTABLE. `PersonalAccessToken` and
   * `EndUserSession` exist in the schema with zero production call sites, so
   * there is no oracle for what a minted one contains; `MintableBearerKind` is
   * the enumeration and the reason is recorded in `domain/bearer-token.ts`.
   */
  mintBearerCredential(
    command: MintBearerCredentialCommand,
  ): Promise<Result<MintedBearerCredentialView>>;
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
  "CREDENTIAL_QUERY_INVALID",
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
