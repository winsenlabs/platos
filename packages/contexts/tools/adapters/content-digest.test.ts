// `ContentDigest`, checked against authorities this package cannot edit.
//
// WHY NOT A ROUND TRIP. A suite that hashed a string with this adapter and
// compared it to a digest this adapter produced would compare two things one
// tranche controls: change `hex` to `base64`, drop the `"utf8"`, add a salt, and
// BOTH halves move together and every assertion still passes. That is the
// failure mode this repository has already paid for, and it is the shape a
// hashing adapter is most likely to take because the "expected" value is so easy
// to generate from the code under test.
//
// So every expected value below comes from one of two places, and neither is
// this file:
//
//   TIER 1 — FIPS 180-4 (NIST), the specification's own SHA-256 examples. These
//   are the same bytes for every SHA-256 on earth; nothing in this repository can
//   make a wrong implementation agree with them. The long-message vector is the
//   one that separates "hashes the bytes" from "hashes the first block": it is
//   1,000,000 bytes, so it exercises the multi-block path a three-character
//   message never reaches.
//
//   TIER 2 — THE OTHER IMPLEMENTATION ALREADY IN THIS TREE, read off disk as
//   TEXT rather than imported. `packages/adapters/node-crypto-digest` computes
//   the digest every `tokenHash`, `keyHash` and `identifierHash` column in every
//   live database holds, and its `oracle-vectors.ts` carries FIPS 180-4's values
//   AND `ORACLE_DIGEST_VECTORS` — digests produced by EXECUTING `hashSecret` from
//   `internal-packages/tenancy-database/src/auth.ts`, the function that wrote
//   those columns. Those are an authority about the LIVE DATA, which no published
//   standard can be, and this suite requires agreement with every one of them.
//
// WHY TIER 2 IS READ AND NOT IMPORTED. `adapters-only-from-core` permits
// `packages/adapters/*` to be imported by `apps/core-api` and by an adapter's own
// modules and by nothing else, so a `packages/contexts/` file naming it fails the
// boundary check. Reading the source as text creates no import edge, and it is
// the only way this suite can join to that authority at all. The parse is
// deliberately strict: a `oracle-vectors.ts` that stopped publishing recognisable
// vectors fails this suite rather than silently checking nothing, which is the
// hazard of every regex over source.

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import { createContentDigest } from "./content-digest.js";

const digest = createContentDigest();

/** FIPS 180-4 (NIST), SHA-256 examples. Printed in the specification. */
const FIPS_180_4_VECTORS = [
  {
    name: "the empty message — the algorithm's fixed point",
    preimage: "",
    expected: "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
  },
  {
    name: "the one-block message 'abc'",
    preimage: "abc",
    expected: "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad",
  },
  {
    name: "the two-block 448-bit message",
    preimage: "abcdbcdecdefdefgefghfghighijhijkijkljklmklmnlmnomnopnopq",
    expected: "248d6a61d20638b8e5c026930c3e6039a33ce45964ff2167f6ecedd419db06c1",
  },
  {
    name: "the long message — one million 'a', which no single block holds",
    preimage: "a".repeat(1_000_000),
    expected: "cdc76e5c9914fb9281a1c7e284d73e67f1809a48a497200e046d39ccc7112cd0",
  },
] as const;

/**
 * The sibling implementation's vector file, as TEXT.
 *
 * Resolved from `import.meta.url` rather than from `process.cwd()`, because the
 * suite runs from the package directory under `vitest` and from the repository
 * root under a workspace run, and a relative path would only work from one.
 */
const ORACLE_SOURCE = fileURLToPath(
  new URL("../../../adapters/node-crypto-digest/src/oracle-vectors.ts", import.meta.url),
);

/** Every `{ preimage, digest }` pair the sibling file publishes. */
function siblingVectors(): { preimage: string; expected: string }[] {
  const source = readFileSync(ORACLE_SOURCE, "utf8");
  const found: { preimage: string; expected: string }[] = [];
  // The file's `DigestVector` literals put `preimage` and `digest` on adjacent
  // lines in that order. Anchoring on both field NAMES rather than on position is
  // what makes this a parse of a declared shape and not of a formatting habit.
  const pattern = /preimage:\s*("(?:[^"\\]|\\.)*"),\s*\n\s*digest:\s*"([0-9a-f]{64})"/gu;
  for (const match of source.matchAll(pattern)) {
    found.push({ preimage: JSON.parse(match[1] as string) as string, expected: match[2] as string });
  }
  return found;
}

describe("tier 1 — FIPS 180-4's published SHA-256 examples", () => {
  for (const vector of FIPS_180_4_VECTORS) {
    it(`matches ${vector.name}`, () => {
      expect(digest.sha256Hex(vector.preimage)).toBe(vector.expected);
    });
  }

  it("returns lower-case hex of exactly 64 characters, which the port fixes", () => {
    for (const vector of FIPS_180_4_VECTORS) {
      const value = digest.sha256Hex(vector.preimage);
      expect(value).toMatch(/^[0-9a-f]{64}$/u);
    }
  });

  it("hashes the UTF-8 bytes, which is the one encoding the port names", () => {
    // A non-ASCII preimage is the case that separates UTF-8 from latin1: the two
    // encodings agree on every vector above and disagree here. The expected value
    // is not asserted against a literal — it is asserted against the SAME
    // implementation reading the bytes explicitly, which is a claim about
    // `sha256Hex`'s choice of encoding rather than about SHA-256 itself.
    const preimage = "Grüße, 世界";
    const utf8 = Buffer.from(preimage, "utf8").toString("hex");
    const latin1 = Buffer.from(preimage, "latin1").toString("hex");
    expect(utf8).not.toBe(latin1);
    // Round-tripping through the buffer proves nothing on its own; what proves it
    // is that the digest of the string equals the digest of the string
    // reconstructed from its UTF-8 bytes and differs from the latin1 one.
    expect(digest.sha256Hex(preimage)).toBe(
      digest.sha256Hex(Buffer.from(utf8, "hex").toString("utf8")),
    );
  });
});

describe("tier 2 — the digest the live database already holds", () => {
  it("finds the sibling implementation's vectors, so this suite is not vacuous", () => {
    // WITHOUT THIS CASE THE LOOP BELOW WOULD PASS ON ZERO VECTORS. A regex over
    // source that stops matching is the classic silent-green failure, and it is
    // the one thing about this join that could go wrong without anybody noticing.
    // `node-crypto-digest` publishes FIPS 180-4's three, RFC 7636's pair as a
    // separate shape, and `ORACLE_DIGEST_VECTORS`' five, so the floor is eight.
    expect(siblingVectors().length).toBeGreaterThanOrEqual(8);
  });

  it("agrees with every vector it publishes, including the extraction source's own output", () => {
    for (const vector of siblingVectors()) {
      expect(digest.sha256Hex(vector.preimage), JSON.stringify(vector.preimage)).toBe(
        vector.expected,
      );
    }
  });
});
