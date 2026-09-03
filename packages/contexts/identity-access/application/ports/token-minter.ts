// TokenMinter — where the randomness comes from.
//
// A minted token is `<prefix><256 bits of base64url randomness>`. The prefix is
// the domain's (see `domain/token.ts`); the randomness is a runtime facility and
// therefore a port, for the same reason `Clock` is one: a use case that reaches
// for a global random source cannot be replayed, and a test cannot pin what it
// produced.
//
// AN IMPLEMENTATION MUST USE A CRYPTOGRAPHIC SOURCE. Every secret this context
// issues is guessable at exactly the rate its generator is predictable, and no
// downstream check compensates for a weak one — the hash of a guessable token is
// a guessable hash. The fake used in tests is deliberately sequential and
// obviously unfit for anything else.

import type { RawToken, TokenKind } from "../../domain/index.js";

export interface TokenMinter {
  /** A fresh opaque secret carrying `kind`'s registered prefix. */
  mint(kind: TokenKind): RawToken;

  /**
   * The TOTP shared secret, base32 as authenticator apps expect.
   *
   * Twenty bytes, matching the extraction source and the RFC 6238 SHA-1 block
   * size the code generation uses.
   */
  mintTotpSecret(): string;

  /**
   * A batch of recovery codes, in their display form.
   *
   * They are shown to the human once and stored only as verifiers, so this is
   * the single moment they exist in plaintext anywhere in the system.
   */
  mintRecoveryCodes(count: number): readonly string[];
}
