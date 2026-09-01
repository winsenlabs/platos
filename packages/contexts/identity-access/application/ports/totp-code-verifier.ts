// TotpCodeVerifier — the RFC 6238 keyed hash, and nothing else.
//
// The split between this port and `domain/mfa.ts` is the important part of the
// design. The port answers ONE question — "for which counter, if any, do these
// six digits match this secret?" — and has no opinion about whether that counter
// may be used. The domain answers that: `acceptTotpCounter` requires the counter
// to strictly exceed `lastUsedCounter`.
//
// Put the replay rule in the verifier instead and it becomes stateful, which
// means it needs the credential, which means it needs the store, which means the
// replay rule can only be tested through a database. Splitting it here is what
// makes "a replayed counter is rejected" a two-line unit test.
//
// HMAC-SHA1 IS CORRECT HERE and is the one place this context uses it. RFC 6238
// fixes it and every authenticator app implements it; substituting SHA-256 would
// produce digits no phone agrees with. Every OTHER hash in this context is
// SHA-256 (`SecretHasher`), and the two must not be confused.

export interface TotpCodeVerifier {
  /**
   * The counter the code matches, or null.
   *
   * `candidateCounters` comes from `totpCounterWindow()`, so the tolerated clock
   * skew is the domain's decision and not this implementation's. An
   * implementation MUST test every candidate rather than returning on the first
   * match's index, and MUST compare digits in constant time.
   */
  verify(input: {
    /** The plaintext base32 shared secret, decrypted by `MfaSecretCipher`. */
    readonly secret: string;
    readonly code: string;
    readonly candidateCounters: readonly bigint[];
  }): bigint | null;

  /** Generate the code for a counter. For enrolment display and for tests. */
  generate(secret: string, counter: bigint): string;
}
