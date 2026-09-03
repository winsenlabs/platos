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
