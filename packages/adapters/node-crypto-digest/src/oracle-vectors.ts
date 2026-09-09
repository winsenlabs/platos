// KNOWN-ANSWER VECTORS FROM TWO SOURCES, NEITHER OF WHICH IS THIS PACKAGE.
//
// WHY THEY EXIST. A suite that hashed a string with this adapter and compared it
// to a digest this adapter produced would be comparing two things one tranche
// controls: change `hex` to `base64`, or drop the `"utf8"`, or add a salt, and
// BOTH halves move together and the assertion still passes. That is the failure
// mode this repository has already paid for — a gate that wrote `count: 18` and
// asserted against the same constant — and it is the exact shape a hashing
// adapter is most likely to take, because the "expected" value is so easy to
// generate from the code under test.
//
// So every expected value below comes from somewhere this package cannot edit.
//
// TIER 1 — PUBLISHED STANDARDS. `NIST_SHA256_VECTORS` are FIPS 180-4's own
// SHA-256 examples and `RFC_7636_PKCE` is RFC 7636 Appendix B's verifier and
// challenge, printed in the specification. Nothing in this repository, in the
// extraction source or in the database can make a wrong implementation agree
// with them: they are the same bytes for every SHA-256 on earth. They are the
// stronger tier, and they are stronger than an oracle comparison would be,
// because the ORACLE also has to match them — a PKCE challenge that agreed with
// `apps/agent` and disagreed with RFC 7636 would be a server no compliant client
// could talk to.
//
// TIER 2 — THE EXTRACTION SOURCE'S OWN OUTPUT. `ORACLE_DIGEST_VECTORS` were
// produced by EXECUTING `hashSecret` from
// `internal-packages/tenancy-database/src/auth.ts` — the function that wrote
// every `tokenHash`, `keyHash`, `codeHash` and `identifierHash` row in every
// live database — over preimages shaped like the ones this context actually
// digests. They pin the same property the standards do, over the inputs that
// matter: a prefixed opaque token, an email normalised the way
// `consume-rate-limit` normalises it, a recovery code normalised the way
// `verify-mfa` normalises it, the empty string, and a non-ASCII string whose
// digest differs under any encoding but UTF-8.
//
// HOW TO RE-DERIVE TIER 2. From the repository root:
//
//   pnpm --filter @platos/tenancy-database build
//   node --input-type=module -e '
//     const { hashSecret } = await import(
//       "./internal-packages/tenancy-database/dist/auth.js");
//     console.log(hashSecret(PREIMAGE));'
//
// A re-run produces the SAME bytes — unlike an envelope's, a digest has no
// nonce — so a mismatch is never flakiness and is always a real divergence.
//
// THE VECTORS CARRY NO REAL SECRET. Every preimage is a literal invented for
// this file, and a digest is one-way in any case.

/** One frozen digest, its preimage, and where the expected value came from. */
export interface DigestVector {
  /** What the case is for, in the failure message when it stops matching. */
  readonly name: string;
  /** The exact string handed to `hash`. */
  readonly preimage: string;
  /** Lower-case hex, 64 characters. */
  readonly digest: string;
  /** The authority for `digest`. Never this package. */
  readonly source: string;
}

const FIPS_180_4 = "FIPS 180-4 (NIST), SHA-256 examples";

/**
 * The published SHA-256 examples.
 *
 * The one-block and two-block messages are the specification's own worked
 * examples; the empty string is the algorithm's fixed point and is quoted in
 * every SHA-256 reference there is. `""` is not decoration here: it is the case
 * that separates "hashes the bytes" from "hashes some framing around the bytes",
 * because a prefix, a suffix or a length header would change it and nothing
 * else about a normal-looking implementation would.
 */
export const NIST_SHA256_VECTORS: readonly DigestVector[] = Object.freeze([
  Object.freeze({
    name: "the empty message",
    preimage: "",
    digest: "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
    source: FIPS_180_4,
  }),
  Object.freeze({
    name: "the one-block message 'abc'",
    preimage: "abc",
    digest: "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad",
    source: FIPS_180_4,
  }),
  Object.freeze({
    name: "the two-block 448-bit message",
    preimage: "abcdbcdecdefdefgefghfghighijhijkijkljklmklmnlmnomnopnopq",
    digest: "248d6a61d20638b8e5c026930c3e6039a33ce45964ff2167f6ecedd419db06c1",
    source: FIPS_180_4,
  }),
]);

/**
 * RFC 7636 Appendix B, verbatim.
 *
 * The RFC prints the verifier as an ASCII string and the challenge as the
 * base64url of the SHA-256 of its ASCII bytes. It is the ONE external statement
 * of what `deriveCodeChallenge` must return, and it pins three things at once:
 * the digest, the base64url alphabet (`-` and `_`, not `+` and `/`), and the
 * absence of `=` padding. An implementation that got any of the three wrong
 * would still round-trip against itself.
 */
export const RFC_7636_PKCE = Object.freeze({
  source: "RFC 7636 Appendix B",
  codeVerifier: "dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk",
  codeChallenge: "E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM",
});

const AUTH_ORACLE = "internal-packages/tenancy-database/src/auth.ts hashSecret";

/**
 * Digests the extraction source produced, over identity-access-shaped inputs.
 *
 * `plt_os_` and `plt_ml_` are two of the eleven prefixes
 * `identity-access/domain/token.ts` registers, and the header of that file says
 * why the prefixes themselves are not negotiable: "rows already exist under that
 * prefix, so `plt_mcp_` is what is recorded here. Changing it is a data
 * migration, not an edit." The same sentence applies to the digest of one.
 */
export const ORACLE_DIGEST_VECTORS: readonly DigestVector[] = Object.freeze([
  Object.freeze({
    name: "an operator session token",
    preimage: "plt_os_7Q2mR8xKpL0aVzN4cJhTdWfYbG3sE6uX1oIkPnAr",
    digest: "93fb7f9797f17bff9015b70672c9d9255dc2c3cd16a77dbe2f9e4aa5eb221a7a",
    source: AUTH_ORACLE,
  }),
  Object.freeze({
    name: "a magic-link token",
    preimage: "plt_ml_ZtC5vB9wQeR2yU7iO1pA3sD8fG6hJ4kL0nMxV5bN",
    digest: "99422777f8806b78735130f5ed0578152fb1c29752fa56cd714359d7a7e76098",
    source: AUTH_ORACLE,
  }),
  Object.freeze({
    name: "an operator email, normalised as consume-rate-limit normalises it",
    preimage: "operator@example.test",
    digest: "8a39ca2160d1a170b9be8e655af29232c678302815eb6f3ec98fbc7ef97f3e12",
    source: AUTH_ORACLE,
  }),
  Object.freeze({
    name: "a recovery code, normalised as verify-mfa normalises it",
    preimage: "A1B2CA1B2CA1B2CA1B2C",
    digest: "10a788728e3a336429a710f3599821e7b4832528ae25a88a4fce05307f6231ac",
    source: AUTH_ORACLE,
  }),
  Object.freeze({
    name: "a rate-limit identifier that is an address rather than an email",
    preimage: "203.0.113.7",
    digest: "fec52565aa0cf18f57d7cf5b3ac728503b8992d2d6f7d46da1d1201090902b02",
    source: AUTH_ORACLE,
  }),
  Object.freeze({
    name: "the empty secret, through the extraction source rather than the standard",
    preimage: "",
    digest: "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
    source: AUTH_ORACLE,
  }),
  Object.freeze({
    // The one vector whose digest depends on the TEXT ENCODING. Every other
    // preimage here is ASCII, where utf8, latin1 and ascii agree byte for byte;
    // this one is not, so an adapter that decoded latin1 — which is what
    // `Buffer.from(value)` does NOT do, but what a `binary` slip would — returns
    // a different digest for it and the same digest for all the others.
    name: "a non-ASCII secret, which fixes the text encoding as UTF-8",
    preimage: "pässwörd-✓-éè",
    digest: "7f790fc989cbaabd5112f07aa2df2f0e78fe341a357b246fff7d263491d2a9a9",
    source: AUTH_ORACLE,
  }),
]);
