// The differential, and the two properties a digest suite usually forgets.
//
// EVERY EXPECTED VALUE IN THIS FILE COMES FROM `oracle-vectors.ts`, and every
// one of those came from FIPS 180-4, from RFC 7636 Appendix B, or from executing
// `internal-packages/tenancy-database/src/auth.ts`. Not one of them was produced
// by the code under test. That is the whole design of this suite: a hashing
// adapter is the easiest thing in a repository to test vacuously, because the
// "expected" digest is one call away from the implementation.
//
// `oracle-source-anchor.test.ts` beside this file closes the other half — that
// the extraction source still computes what these vectors were taken from.

import { describe, expect, it } from "vitest";

import { createNodeCryptoDigestAdapter } from "./adapter.js";
import {
  NIST_SHA256_VECTORS,
  ORACLE_DIGEST_VECTORS,
  RFC_7636_PKCE,
} from "./oracle-vectors.js";

const adapter = createNodeCryptoDigestAdapter();

/**
 * Hash the vector NAMED here, and fail if the table no longer carries it.
 *
 * THE CASES ARE NAMED `it()`s AND NOT A `for` LOOP, and that is this census's
 * rule rather than a style: `scripts/arch/test-case-census.mjs` REFUSES a file
 * that declares `it()` inside a loop, because a construct it cannot count is a
 * construct that can silently lose a case. The lookup is by name so the case
 * still cannot drift from the table — delete a vector and the case fails on the
 * missing row rather than passing on an empty iteration, which is exactly what
 * the loop form would have done.
 */
function expectVector(table: readonly { name: string; preimage: string; digest: string }[], name: string): void {
  const vector = table.find((candidate) => candidate.name === name);
  expect(vector, `no vector named ${name}`).toBeDefined();
  expect(adapter.hash(vector?.preimage as string)).toBe(vector?.digest);
}

describe("the digest, against published standards", () => {
  it("matches FIPS 180-4 for the empty message", () => {
    expectVector(NIST_SHA256_VECTORS, "the empty message");
  });

  it("matches FIPS 180-4 for the one-block message 'abc'", () => {
    expectVector(NIST_SHA256_VECTORS, "the one-block message 'abc'");
  });

  it("matches FIPS 180-4 for the two-block 448-bit message", () => {
    expectVector(NIST_SHA256_VECTORS, "the two-block 448-bit message");
  });

  it("has a case for every published vector, so adding one cannot go unchecked", () => {
    // The counterpart to naming the cases: three vectors, three cases. A fourth
    // added to the table with no case would otherwise be dead data.
    expect(NIST_SHA256_VECTORS).toHaveLength(3);
  });

  it("renders lower-case hex and nothing else", () => {
    // The unique indexes over every `*Hash` column are byte comparisons. An
    // upper-case digest is a digest that matches no row and collides with no
    // row either, so the failure is a silent authentication failure rather than
    // a duplicate-key error anyone would notice.
    for (const vector of NIST_SHA256_VECTORS) {
      expect(adapter.hash(vector.preimage)).toMatch(/^[0-9a-f]{64}$/u);
    }
  });
});

describe("the digest, against the extraction source", () => {
  it("matches what auth.ts wrote for an operator session token", () => {
    expectVector(ORACLE_DIGEST_VECTORS, "an operator session token");
  });

  it("matches what auth.ts wrote for a magic-link token", () => {
    expectVector(ORACLE_DIGEST_VECTORS, "a magic-link token");
  });

  it("matches what auth.ts wrote for a normalised operator email", () => {
    expectVector(
      ORACLE_DIGEST_VECTORS,
      "an operator email, normalised as consume-rate-limit normalises it",
    );
  });

  it("matches what auth.ts wrote for a normalised recovery code", () => {
    expectVector(ORACLE_DIGEST_VECTORS, "a recovery code, normalised as verify-mfa normalises it");
  });

  it("matches what auth.ts wrote for an address-shaped rate-limit identifier", () => {
    expectVector(
      ORACLE_DIGEST_VECTORS,
      "a rate-limit identifier that is an address rather than an email",
    );
  });

  it("matches what auth.ts wrote for the empty secret", () => {
    expectVector(
      ORACLE_DIGEST_VECTORS,
      "the empty secret, through the extraction source rather than the standard",
    );
  });

  it("matches what auth.ts wrote for a non-ASCII secret, fixing the text encoding", () => {
    expectVector(
      ORACLE_DIGEST_VECTORS,
      "a non-ASCII secret, which fixes the text encoding as UTF-8",
    );
  });

  it("has a case for every oracle vector, so adding one cannot go unchecked", () => {
    expect(ORACLE_DIGEST_VECTORS).toHaveLength(7);
  });

  it("agrees with the standard on the one preimage both tiers pin", () => {
    // The empty string appears in BOTH tables, taken from two different
    // authorities. If the two ever disagreed, one of the two sources would have
    // been transcribed wrongly and every other vector in that table would be
    // suspect. This is the cheapest possible check on the transcription itself.
    const standard = NIST_SHA256_VECTORS.find((vector) => vector.preimage === "");
    const oracle = ORACLE_DIGEST_VECTORS.find((vector) => vector.preimage === "");
    expect(standard?.digest).toBe(oracle?.digest);
    expect(standard?.source).not.toBe(oracle?.source);
  });
});

describe("the PKCE challenge", () => {
  it("reproduces RFC 7636 Appendix B", () => {
    expect(adapter.deriveCodeChallenge(RFC_7636_PKCE.codeVerifier)).toBe(
      RFC_7636_PKCE.codeChallenge,
    );
  });

  it("uses the base64url alphabet and no padding", () => {
    // Three properties in one assertion, and each has its own way of being
    // wrong: `+`/`/` is the base64 alphabet (a challenge no client computes),
    // and `=` is padding RFC 7636 §4.2 removes. Node's `base64url` does all
    // three; an implementation that reached for `base64` and post-processed
    // would get two of them right and forget one.
    for (const vector of [...NIST_SHA256_VECTORS, ...ORACLE_DIGEST_VECTORS]) {
      expect(adapter.deriveCodeChallenge(vector.preimage)).toMatch(/^[A-Za-z0-9_-]{43}$/u);
    }
  });

  it("is the same digest as `hash`, in a different alphabet", () => {
    // Not a tautology: it is the claim the port makes ("Same digest, different
    // encoding"), and it is checked by re-encoding the HEX — which the vectors
    // pin against FIPS 180-4 — rather than by hashing again here.
    for (const vector of NIST_SHA256_VECTORS) {
      const fromHex = Buffer.from(vector.digest, "hex").toString("base64url");
      expect(adapter.deriveCodeChallenge(vector.preimage)).toBe(fromHex);
    }
  });
});

describe("constant-time equality", () => {
  it("answers false rather than throwing when the lengths differ", () => {
    // THE ONE FAILURE THE PORT NAMES. `crypto.timingSafeEqual` throws
    // `ERR_CRYPTO_TIMING_SAFE_EQUAL_LENGTH` on unequal-length buffers, so an
    // implementation that let it through turns a mismatch into an exception —
    // and an exception unwinding out of `verify-mfa` is both a 500 and a timing
    // signal. Deleting the length check makes every case below throw.
    expect(adapter.equals("", "a")).toBe(false);
    expect(adapter.equals("a", "")).toBe(false);
    expect(adapter.equals("abc", "abcd")).toBe(false);
    expect(adapter.equals("abcd", "abc")).toBe(false);
    expect(adapter.equals("0".repeat(64), "0".repeat(63))).toBe(false);
  });

  it("compares UTF-8 BYTES, not JavaScript code units", () => {
    // The case that kills `left === right`.
    //
    // A lone high surrogate has no UTF-8 encoding, so `Buffer.from` replaces it
    // with U+FFFD: `"\uD800"` and `"\uD801"` are DIFFERENT strings whose UTF-8
    // bytes are the SAME three (ef bf bd). `safeEqual` in
    // `internal-packages/tenancy-database/src/auth.ts` compares
    // `Buffer.from(left)` to `Buffer.from(right)` and therefore calls them
    // equal; `===` calls them different. This adapter must answer what the
    // extraction source answers, so the expectation is `true`.
    //
    // It is a strange input and that is the point: it is the only observation
    // that distinguishes a byte comparison from a string comparison, and
    // without it the port's whole constant-time clause could be satisfied by an
    // operator that leaks on the first differing character.
    // Held in `string`-typed bindings rather than compared as literals, because
    // `tsc` narrows two different string literals to non-overlapping types and
    // refuses the `===` outright — which is a compile-time proof of the same
    // fact, and not one this suite can assert at runtime without the widening.
    const highSurrogate: string = "\uD800";
    const otherHighSurrogate: string = "\uD801";
    expect(Buffer.from(highSurrogate, "utf8").equals(Buffer.from(otherHighSurrogate, "utf8"))).toBe(true);
    expect(highSurrogate === otherHighSurrogate).toBe(false);
    expect(adapter.equals(highSurrogate, otherHighSurrogate)).toBe(true);
  });

  it("does not decode its arguments as hex", () => {
    // The case that pins WHICH oracle this port follows.
    //
    // There are two constant-time comparisons in the extraction source.
    // `apps/agent/src/oauth/oauth.service.ts:127` is `timingSafeEqualHex`, which
    // decodes both sides from hex — so it calls "AB" and "ab" EQUAL, because
    // they decode to the same byte. `internal-packages/tenancy-database/src/auth.ts`'s
    // `safeEqual` decodes neither and calls them different.
    //
    // `SecretHasher.equals` is a general string comparison used for recovery
    // codes and TOTP codes as well as digests, so `safeEqual` is the one it
    // matches; a hex-decoding `equals` would additionally accept an upper-case
    // rendering of a digest that no column ever stores.
    expect(adapter.equals("AB", "ab")).toBe(false);
    expect(adapter.equals("ff00", "FF00")).toBe(false);
  });

  it("is true only for identical strings", () => {
    const digest = adapter.hash("plt_os_7Q2mR8xKpL0aVzN4cJhTdWfYbG3sE6uX1oIkPnAr");
    expect(adapter.equals(digest, digest)).toBe(true);
    // Differing in the FIRST byte and in the LAST byte are separate cases: an
    // implementation that compared a prefix would pass one and fail the other.
    expect(adapter.equals(digest, `f${digest.slice(1)}`)).toBe(false);
    expect(adapter.equals(digest, `${digest.slice(0, -1)}f`)).toBe(false);
    expect(adapter.equals("", "")).toBe(true);
  });
});

describe("the adapter surface", () => {
  it("names itself by its directory", () => {
    expect(adapter.adapterName).toBe("node-crypto-digest");
  });

  it("is a value the composition root can hold for the process lifetime", () => {
    // No configuration, no handle, no close. Two independently constructed
    // adapters must therefore agree on every digest — which is what makes
    // constructing one per process, or one per call, an equivalent choice.
    const second = createNodeCryptoDigestAdapter();
    for (const vector of ORACLE_DIGEST_VECTORS) {
      expect(second.hash(vector.preimage)).toBe(adapter.hash(vector.preimage));
    }
  });
});
