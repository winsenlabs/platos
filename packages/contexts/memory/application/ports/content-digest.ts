// The `ContentDigest` port — the one host capability this context's dedupe needs.
//
// `Memory.contentHash` is what makes re-extracting an unchanged transcript
// idempotent: the store's unique index is over `(environment, subject, source
// thread, content hash)`, so two sweeps that see the same sentence collide
// instead of appending twice. Producing that hash is a HOST capability — the
// running system reaches for `node:crypto` — and `domain/` may not, so the
// algorithm is named by this interface and `domain/content.ts` holds only the
// rule about when a row has one.
//
// IT IS DELIBERATELY NOT A PROMISE AND NOT A `Result`. Every other port in this
// package is asynchronous and fallible because it crosses a network or a
// process. Hashing a string does neither: it is a pure function of its input
// that an implementation computes locally, and giving it a failure channel would
// force every dedupe call site to handle an outcome that cannot occur.
//
// THE DIGEST IS OVER PLAINTEXT, BEFORE ANY ENVELOPE. The running system encrypts
// `content` at rest, and the hash is computed on the value BEFORE encryption —
// otherwise two adapters with different keys would produce different hashes for
// the same sentence and dedupe would stop working the moment a key rotated.

import type { ContentHash } from "../../domain/index.js";

export interface ContentDigest {
  /**
   * A stable, non-reversible digest of one memory's content.
   *
   * An implementation MUST be deterministic across processes and across
   * restarts: the value is a stored column and a unique-index component, so a
   * salted or per-instance digest would silently stop every existing row from
   * ever being matched again.
   */
  digest(content: string): ContentHash;
}
