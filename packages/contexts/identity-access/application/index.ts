// The identity-access use cases.
//
// Every one of them is a FUNCTION that takes its ports as its first argument and
// returns `Result<T>`. No class, no container, no decorator, no module-level
// state — ADR M0.3 §2 bans the framework from this layer, and the shape is what
// makes WIN-256's "invokable in memory" criterion literally true: give it
// `testPorts()` and call it.
//
// FAILURE IS RETURNED, NEVER THROWN. A caller's failure paths are visible in the
// type, and an exception crossing this boundary means a defect rather than a
// business outcome. The `throw` in `fakeMfaSecretCipher` is the exception that
// proves the rule: a tampered envelope is not a business outcome.
//
// The ports live in `./ports/`; `./testing.js` and `./in-memory-repository.js`
// are the fakes the suite runs against and are shipped with the package so an
// adapter can conformance-test itself against the same behaviour.

export type { IdentityAccessPorts, PortsOf } from "./dependencies.js";
export * from "./ports/index.js";

export { createIdentityAccessService } from "./identity-access-service.js";
export {
  authenticateOperator,
  revokeOperatorSession,
  type AuthenticateOperatorInput,
  type AuthenticateOperatorPorts,
} from "./authenticate-operator.js";
export {
  issueOperatorSession,
  type IssuedOperatorSession,
  type IssueOperatorSessionInput,
  type IssueOperatorSessionPorts,
} from "./issue-operator-session.js";
export {
  completeMagicLinkLogin,
  startMagicLinkLogin,
  type CompletedMagicLinkLogin,
  type CompleteMagicLinkLoginInput,
  type StartedMagicLinkLogin,
  type StartMagicLinkLoginInput,
} from "./magic-link-login.js";
export { verifyMfaForSession, type VerifyMfaInput, type VerifyMfaPorts } from "./verify-mfa.js";
export {
  beginTotpEnrolment,
  confirmTotpEnrolment,
  type BegunTotpEnrolment,
  type ConfirmedTotpEnrolment,
  type ConfirmTotpEnrolmentInput,
} from "./enrol-totp.js";
export {
  consumeRateLimit,
  isWithinRateLimit,
  type ConsumeRateLimitInput,
  type ConsumeRateLimitPorts,
} from "./consume-rate-limit.js";
export {
  revokeAccessKeys,
  rotateAccessKey,
  type RotateAccessKeyInput,
  type RotateAccessKeyPorts,
} from "./rotate-access-key.js";
export {
  exchangeOAuthRefreshToken,
  type ExchangedTokenPair,
  type ExchangeRefreshTokenInput,
  type ExchangeRefreshTokenPorts,
} from "./exchange-oauth-refresh-token.js";
export {
  listEndUsers,
  type EndUserId,
  type EndUserIdentityId,
  type EndUserIdentityRecord,
  type EndUserPage,
  type EndUserRecord,
  type EndUserWithIdentities,
  type ListEndUsersInput,
  type ListEndUsersPorts,
} from "./list-end-users.js";
export {
  authenticateBearerToken,
  type AuthenticateBearerTokenInput,
  type AuthenticateBearerTokenPorts,
} from "./authenticate-bearer-token.js";
export {
  startImpersonation,
  stopImpersonation,
  type ImpersonationPorts,
  type StartImpersonationInput,
  type StopImpersonationInput,
} from "./impersonation.js";

export {
  inMemoryIdentityAccessRepository,
  type InMemoryIdentityAccessRepository,
  type InMemoryState,
} from "./in-memory-repository.js";
export {
  fakeMfaSecretCipher,
  fakeRateLimiter,
  fakeSecretHasher,
  fakeTokenMinter,
  fakeTotpCodeVerifier,
  fixedClock,
  recordingSafetySink,
  sequentialIdGenerator,
  silentLogger,
  testPorts,
  type FakeRateLimiter,
  type MutableClock,
  type RecordingSafetySink,
  type TestPorts,
} from "./testing.js";
