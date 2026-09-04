// An in-memory `ContentDigest`.
//
// NOT A CRYPTOGRAPHIC HASH, AND IT MUST NOT BE MISTAKEN FOR ONE. The production
// adapter uses SHA-256; this is a 32-bit FNV-1a fold, which is deterministic
// across processes — the one property `ContentDigest` actually demands of an
// implementation — and is otherwise trivially reversible.
//
// It is here because dedupe is a rule this context OWNS: two writes of the same
// sentence under one thread collide, and two writes of different sentences do
// not. Testing that against a real SHA-256 would prove something about
// `node:crypto`; testing it against a function whose only guarantee is
// determinism proves the rule.
//
// The digest is also COUNTED, so a test can assert that a revision which did not
// change the content did not recompute a hash — which is the difference between
// "the code is correct" and "the code is correct and does not do pointless work".

import { asMemoryIdentifier, type ContentHash } from "../../domain/index.js";
import type { ContentDigest } from "../ports/index.js";

const FNV_OFFSET_BASIS = 0x811c9dc5;
const FNV_PRIME = 0x01000193;

export interface CountingDigest extends ContentDigest {
  /** How many times a digest was computed. */
  readonly calls: () => number;
}

export function countingDigest(): CountingDigest {
  let calls = 0;
  return {
    calls: () => calls,
    digest: (content: string): ContentHash => {
      calls += 1;
      let hash = FNV_OFFSET_BASIS;
      for (let index = 0; index < content.length; index += 1) {
        hash ^= content.charCodeAt(index);
        hash = Math.imul(hash, FNV_PRIME) >>> 0;
      }
      return asMemoryIdentifier<ContentHash>(`fnv-${hash.toString(16).padStart(8, "0")}`);
    },
  };
}
