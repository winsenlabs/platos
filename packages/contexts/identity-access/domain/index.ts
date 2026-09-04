// The identity-access domain.
//
// ADR M0.3 §2: this layer may import its own files and `@platos/kernel`, and
// nothing else — no application layer, no other context, no vendor SDK, no
// wall clock and no randomness. Everything here is a total function of its
// arguments, which is what makes an authentication decision testable at an
// arbitrary instant instead of only at `Date.now()`.
//
// The layout follows the rows this context is sole writer of (ADR M0.3 §1):
//
//   principal            User, OperatorIdentity, EndUser, EndUserIdentity
//   session              OperatorSession + the impersonation chain
//   magic-link           MagicLinkToken
//   mfa                  OperatorMfaTotp, OperatorMfaRecoveryCode
//   rate-limit           AuthRateLimitBucket
//   access-key           AccessKey, AccessKeyBootstrapGrant
//   oauth                OAuthClient/AccessToken/RefreshToken/AuthorizationCode
//   bearer-token         McpToken, McpBearerToken, PersonalAccessToken,
//                        EndUserSession
//   authorization-scope  the scope every one of them is bounded by
//   credential           the lifecycle rule all of them share
//   token                the prefix registry that routes a presented secret
//
// ImpersonationAudit is written by `impersonation` in the application layer,
// because an audit row is a record of a use case having happened rather than a
// decision the domain makes.
//
// NOT HERE, DELIBERATELY: OrganizationInvitation. ADR M0.3 §1 row 2 makes
// `tenancy` its sole writer. identity-access owns the `plt_inv_` prefix (it
// mints the secret) and the INVITE_ACCEPT rate-limit bucket (it owns the
// buckets), and the invitation row and its acceptance rules belong next door.

export * from "./access-key.js";
export * from "./authorization-scope.js";
export * from "./bearer-token.js";
export * from "./credential.js";
export * from "./end-user.js";
export * from "./errors.js";
export * from "./magic-link.js";
export * from "./mfa.js";
export * from "./oauth.js";
export * from "./principal.js";
export * from "./rate-limit.js";
export * from "./session-cookie.js";
export * from "./session.js";
export * from "./token.js";
