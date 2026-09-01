// MfaSecretCipher — reversible encryption for the ONE secret that must be.
//
// Every other secret in this context is stored as a one-way digest, because
// nothing ever needs to read it back. The TOTP shared secret is different: the
// server must reproduce the same six digits the phone does, so it must hold the
// secret in a recoverable form. `OperatorMfaTotp.encryptedSecret` is therefore
// ciphertext, and this port is the boundary that produces and consumes it.
//
// The extraction source uses AES-256-GCM with a random 96-bit IV and stores
// `iv.tag.ciphertext` base64url-joined. The algorithm is the implementation's
// business; what this port fixes is that the DOMAIN NEVER HOLDS PLAINTEXT. A
// `TotpCredential` carries `encryptedSecret` and the plaintext exists only
// inside the one use case that is verifying a code, for the length of that call.
//
// NOTE ON OWNERSHIP. `secrets` is the context that owns the credential vault and
// the data-encryption keys (ADR M0.3 §1 row 3). This is not that: it is a
// context-local envelope over one column identity-access is sole writer of, and
// identity-access may not import `secrets` (it depends on nothing but the
// kernel). Whether the two key hierarchies should converge is a real question
// and a later one; it is a composition-root decision about which key an adapter
// is handed, not a change to this interface.

export interface MfaSecretCipher {
  /** Encrypt a freshly minted shared secret for storage. */
  seal(plaintext: string): string;

  /**
   * Decrypt for one verification.
   *
   * An implementation MUST authenticate the ciphertext and reject a tampered
   * envelope rather than returning wrong plaintext: an unauthenticated mode here
   * would let a store-level attacker swap in a secret they know.
   */
  open(sealed: string): string;
}
