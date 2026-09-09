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

// WIN-260 (M2.5): `domainError` and `err` join them. The real-PostgreSQL
// transaction suites in `packages/adapters/postgres-tenancy` now assert that a
// returned error `Result` ROLLS BACK — they used to assert it committed — and a
// suite that cannot CONSTRUCT a `DomainError` cannot state the case.
// WIN-267 A3: `ok` joins them, and it is the SIXTH time this omission has been
// found. Every method on every port here returns `Result<T>`, and until this
// issue no package outside this one could construct the SUCCESS half of one —
// `err` was published and `ok` was not, so `packages/adapters/redis-ratelimit`
// could refuse and could not succeed. Found the same way the other five were:
// by the first implementation of a port failing to compile.
export { asIdentifier, domainError, err, ok, runResult } from "@platos/kernel";
export type { Branded, EnvironmentId, NotResult, OrganizationId, PrincipalId, ProjectId, Result, TenantScope } from "@platos/kernel";
// WIN-260 (M2.5): `runResult` joins them, and `NotResult` beside it.
// `UnitOfWork.run` REFUSES a callback whose answer is a `Result` — such a
// callback RESOLVES, and a resolved callback COMMITS, which is the defect
// `cost-monitoring` shipped — so `runResult` is the only way to end a unit of
// work with a failure, and every canonical store's suite needs it. It is
// republished HERE rather than imported from `@platos/kernel` in the adapter,
// for the reason stated above: that would be the second import edge into the
// kernel this paragraph exists to refuse.
export { environmentScope, organizationScope, projectScope } from "@platos/kernel";

export { GLOBAL_SCOPE, tenantAuthorizationScope } from "../../domain/index.js";
export { OPERATOR_IDENTITY_PROVIDERS, PRINCIPAL_TIERS } from "../../domain/index.js";

// WIN-267 A3 — WHAT `RateLimiter` ITSELF IS DECLARED IN, and it was the one port
// of the six that could not be spelled from outside this package at all.
// `rate-limiter.ts` names `AuthRateLimitAction`, `RateLimitBucket`,
// `RateLimitPolicy` and `TokenHash` in its own signatures and re-exported only
// the last, so `consume`'s parameter and its return value were both unnameable
// by the adapter ADR M0.3 §2 says is the only kind of package permitted to
// implement it. The block above records five earlier findings of exactly this
// shape; this is the sixth, and it is repaired the same way.
//
// `windowFor` IS A VALUE AND IT IS THE LOAD-BEARING ONE. `domain/rate-limit.ts`
// says outright that "THE WINDOW ARITHMETIC IS NOT HERE" — the rollover rule
// belongs to the domain, and the port owns only the atomic increment. An
// implementation that computed `floor(at / windowMs) * windowMs` for itself
// would be a SECOND statement of that rule, in the layer that cannot see the
// first, and the two would agree until somebody changed one. Publishing the
// function is what keeps the bucket key and the domain's own `isSameWindow`
// derived from a single definition.
//
// `rateLimiterUnavailable` is the refusal the port's own header requires —
// "FAILURE IS A VALUE, NOT AN EXCEPTION ... so 'the limiter is unreachable'
// arrives as data the use case must handle". An implementation that minted its
// own code would answer `consume-rate-limit.ts` with something the safety event
// it records cannot be reconciled against.
export { rateLimiterUnavailable, windowFor } from "../../domain/index.js";
export type {
  AuthRateLimitAction,
  RateLimitBucket,
  RateLimitPolicy,
  RateLimitWindow,
} from "../../domain/index.js";

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
  RawToken,
  RecoveryCodeRecord,
  RotationFamilyId,
  TokenHash,
  TokenKind,
  TokenPairPlan,
  TotpCredential,
  UserId,
} from "../../domain/index.js";

// WIN-267 A2. The three VALUES an implementation of `TokenMinter` and
// `TotpCodeVerifier` cannot be written without, republished for exactly the
// reason the WIN-258 T2 block above states: `packages/adapters/tokenmint-totp`
// implements both ports and its only edges are to this package, so without them
// it would have to reach into `../../domain/`, which
// `cross-context-contracts-only` exists to stop.
//
// NOTHING NEW IS PUBLISHED. All three are already public from
// `../../domain/index.js`, and `RawToken` and `TokenKind` above are the types
// `TokenMinter.mint`'s own signature is written in.
//
// `TOTP_DIGITS` is here rather than copied into the adapter deliberately. Six is
// a number the DOMAIN owns — `domain/mfa.ts` records it as an RFC 6238 parameter
// taken from the extraction source — and an adapter holding its own `6` could
// disagree with it while every test in both packages stayed green.
export { prefixOf, TOKEN_KINDS, TOTP_DIGITS } from "../../domain/index.js";
