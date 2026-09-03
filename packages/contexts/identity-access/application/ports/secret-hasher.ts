// SecretHasher — the only place a bearer secret becomes a stored verifier.
//
// WHY THIS IS A PORT AND NOT A DOMAIN FUNCTION. Hashing needs a digest
// implementation and comparison needs a constant-time primitive, both of which
// come from a runtime library. ADR M0.3 §2 keeps `domain/` and `application/`
// free of everything but Platos-owned interfaces, so the three lines of
// `node:crypto` the extraction source calls live in the adapter and the domain
// sees this instead. That is not ceremony: it is what lets every rule in
// `domain/` be exercised with a fake hasher and no runtime at all.
//
// SHA-256 HEX, FOR EVERY TOKEN VERIFIER. `OperatorSession.tokenHash`,
// `MagicLinkToken.tokenHash`, `AccessKey.keyHash`, `OAuthAccessToken.tokenHash`,
// `AuthRateLimitBucket.identifierHash` and the rest are all the same digest of
// the same shape, and the unique indexes over them assume it. An implementation
// that changed the algorithm would not fail a test — it would silently stop
// matching every row already written.
//
// There are no passwords in this system, so no work factor is required or
// wanted: these are high-entropy random tokens, not human-chosen secrets, and a
// slow KDF here would only make every request slower.

import type { RawToken, TokenHash } from "../../domain/index.js";

export interface SecretHasher {
  /** SHA-256 of the UTF-8 bytes, lower-case hex. */
  hash(secret: RawToken | string): TokenHash;

  /**
   * Constant-time equality.
   *
   * MUST compare lengths FIRST and return false without a timing-sensitive
   * comparison when they differ — the platform primitive throws on unequal
   * lengths, and an implementation that let that throw would turn a
   * length-mismatch into an exception a caller could time.
   */
  equals(left: string, right: string): boolean;

  /**
   * The PKCE challenge derivation: base64url of the SHA-256 of the verifier.
   *
   * Same digest, different encoding, and the difference is not incidental —
   * RFC 7636 fixes base64url and a hex challenge would never match a compliant
   * client's.
   */
  deriveCodeChallenge(codeVerifier: string): string;
}
