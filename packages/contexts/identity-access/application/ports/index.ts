// The driven ports identity-access needs, implemented under packages/adapters/
// and wired at the composition root. `domain/` never imports this directory.
//
// Six ports, and every one of them earns its place by being something a pure
// function cannot be:
//
//   IdentityAccessRepository  the canonical store, and the conditional writes
//                             that make single-use credentials single-use
//   RateLimiter               an atomically shared counter (ADR M0.3 §13 names
//                             this one as identity-access-owned)
//   SecretHasher              a digest, and a constant-time comparison
//   TokenMinter               cryptographic randomness
//   TotpCodeVerifier          the RFC 6238 keyed hash
//   MfaSecretCipher           the one reversible envelope in this context
//
// The kernel supplies the rest — `Clock`, `IdGenerator`, `UnitOfWork`,
// `OutboxWriter`, `SafetyEventSink` — because they are cross-cutting rather than
// ours (ADR M0.3 §4, §13).
//
// `SafetyEventSink` deserves a note: ADR M0.3 §3 records `auth -> monitoring`
// (the rate-limit guard reaching into `SafetyEventService`) as one of the three
// wrong-way edges this context exists to delete. A rate-limit denial is
// published through the KERNEL sink, `governance` implements it and stays sole
// writer of SafetyEvent, and rule (g) `identity-isolation` makes the direct
// import unrepresentable.

export type { IdentityAccessRepository } from "./repository.js";
export type {
  AccessKeyStore,
  BearerCredentialStore,
  // WIN-258 T2: `EndUserStore` was declared in ./repository.ts, named on
  // `IdentityAccessRepository`, and never re-exported here — so the one store of
  // the ten that an adapter could not name was the one holding the tenant
  // clause. Found by the first implementation of the port failing to compile.
  EndUserStore,
  ImpersonationAuditStore,
  MagicLinkStore,
  OAuthStore,
  OperatorIdentityStore,
  OperatorMfaStore,
  OperatorSessionStore,
  UserStore,
} from "./repository.js";
export type { RateLimitConsumption, RateLimiter } from "./rate-limiter.js";
export type { SecretHasher } from "./secret-hasher.js";
export type { TokenMinter } from "./token-minter.js";
export type { TotpCodeVerifier } from "./totp-code-verifier.js";
export type { MfaSecretCipher } from "./mfa-secret-cipher.js";

// --- what an implementation of the ports above needs in order to build a record
//
// WIN-258 T2. `packages/adapters/postgres-tenancy` implements
// `IdentityAccessRepository` and its only edges are to this package, to
// `@platos/context-tenancy` and to the schema package. Without the re-exports
// below it would have to reach into `../../domain/`, which
// `cross-context-contracts-only` exists to stop. The precedent is the identical
// block in `@platos/context-tenancy/application/ports/index.js`, added for the
// same reason and for the same adapter. Nothing new is published: every name
// below is already public from `../../domain/index.js` or from `@platos/kernel`.

export { asIdentifier } from "@platos/kernel";
export type {
  Branded,
  EnvironmentId,
  OrganizationId,
  PrincipalId,
  ProjectId,
  TenantScope,
} from "@platos/kernel";
export { environmentScope, organizationScope, projectScope } from "@platos/kernel";

export { GLOBAL_SCOPE, tenantAuthorizationScope } from "../../domain/index.js";
export { OPERATOR_IDENTITY_PROVIDERS, PRINCIPAL_TIERS } from "../../domain/index.js";
export type {
  AccessKeyId,
  AccessKeyRecord,
  AccessKeyRotationPlan,
  AuthorizationScope,
  AuthorizationScopeKind,
  BearerCredentialKind,
  BearerCredentialRecord,
  EmailAddress,
  EndUserId,
  EndUserIdentityId,
  EndUserIdentityRecord,
  EndUserQuery,
  EndUserRecord,
  EndUserStatusFilter,
  EndUserWithIdentities,
  FamilyRevocation,
  ImpersonationAction,
  ImpersonationAuditEntry,
  MagicLinkTokenRecord,
  OAuthAuthorizationCodeRecord,
  OAuthAccessTokenRecord,
  OAuthClientId,
  OAuthRefreshTokenRecord,
  OAuthTokenId,
  OperatorIdentityProvider,
  OperatorIdentityRecord,
  OperatorSessionId,
  OperatorSessionRecord,
  OperatorUserRecord,
  PrincipalTier,
  RecoveryCodeRecord,
  RotationFamilyId,
  TokenHash,
  TokenPairPlan,
  TotpCredential,
  UserId,
} from "../../domain/index.js";
