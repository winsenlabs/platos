// THE PRIMITIVE, JOINED TO THE STANDARD — AND TO A SECOND HMAC WRITTEN FROM RAW
// SHA-256.
//
// `hmac.ts` computes `X-Hub-Signature-256` with `node:crypto`'s `createHmac`. Two
// things could be wrong with that and a suite that only called `createHmac` twice
// would see neither: the algorithm could be keyed or padded differently from what
// Meta computes, and the hex/length/comparison grammar around it could accept
// something that is not a digest.
//
// SO THE JOIN IS DOUBLE, AND IT IS WHAT THIS DIRECTORY HAS INSTEAD OF THE
// PUBLISHED VENDOR VECTOR `channel-slack` GETS. Slack publishes a complete worked
// example — secret, timestamp, body, signature — and
// `channel-slack/src/published-vector.ts` transcribes it, so that adapter's
// agreement is between Slack's own arithmetic and Node's. META PUBLISHES NO SUCH
// EXAMPLE for `X-Hub-Signature-256`: the Webhooks "Payload validation" page gives
// the construction in prose and code samples and never a worked example with
// concrete bytes. What is joined here instead, and what each half claims, stated
// so the difference cannot later be mistaken for the same thing:
//
//   THE PRIMITIVE is joined to RFC 4231 §4's own published HMAC-SHA-256 vectors —
//   values nothing in this repository produced — AND to `rfc2104-oracle.ts`, an
//   HMAC built from `node:crypto`'s raw SHA-256 exactly as RFC 2104 §2 defines
//   it. Two implementations sharing nothing but SHA-256, agreeing with a
//   standard's published digests.
//
//   THE CONSTRUCTION — that the signed message is the RAW BODY and the header is
//   `sha256=` plus lower-case hex — is joined only to Meta's documented prose,
//   which `vendor.ts` transcribes with its source. That is weaker, it is the
//   weakest link in this adapter's inbound half, and it is written down rather
//   than dressed up: no vendor code and no vendor vector reads it back.

import { describe, expect, it } from "vitest";

import { digestsMatch, hmacSha256Hex, isSha256Hex } from "./hmac.js";
import { HMAC_BLOCK_SIZE, HMAC_IPAD, HMAC_OPAD, rfc2104HmacSha256 } from "./rfc2104-oracle.js";
import { RFC4231_HMAC_SHA256_VECTORS } from "./rfc4231-vectors.js";

describe("RFC 4231 §4 is transcribed, not invented", () => {
  // The tables below name each vector by INDEX, spelled as array literals because
  // the test-case census counts rows statically; this case pins that index i IS
  // the vector the table calls it, so a reordered file cannot mislabel a case.
  it("holds all seven cases the section publishes, in order", () => {
    expect(RFC4231_HMAC_SHA256_VECTORS.map((vector) => vector.name)).toEqual([
      "Test Case 1",
      "Test Case 2",
      "Test Case 3",
      "Test Case 4",
      "Test Case 5",
      "Test Case 6",
      "Test Case 7",
    ]);
  });

  it.each([
    ["Test Case 1", 0],
    ["Test Case 2", 1],
    ["Test Case 3", 2],
    ["Test Case 4", 3],
    ["Test Case 5", 4],
    ["Test Case 6", 5],
    ["Test Case 7", 6],
  ])("%s: the key and the data are the lengths the RFC states", (_name, index) => {
    const vector = RFC4231_HMAC_SHA256_VECTORS[index]!;
    // A transcription that dropped a byte is still self-consistent hex; the
    // stated length is the only thing that notices.
    expect(vector.key.length / 2).toBe(vector.keyLength);
    expect(vector.data.length / 2).toBe(vector.dataLength);
    expect(vector.key).toMatch(/^[0-9a-f]*$/u);
    expect(vector.data).toMatch(/^[0-9a-f]*$/u);
  });

  it("exercises both sides of the block-size boundary, which is where key schedules differ", () => {
    const lengths = RFC4231_HMAC_SHA256_VECTORS.map((vector) => vector.keyLength);
    // Shorter than the 64-byte block (a key that is padded) and longer than it
    // (a key that must be HASHED first). A suite with only one of those would
    // pass with the hash-the-long-key step missing entirely.
    expect(lengths.some((length) => length < HMAC_BLOCK_SIZE)).toBe(true);
    expect(lengths.some((length) => length > HMAC_BLOCK_SIZE)).toBe(true);
  });
});

describe("the HMAC this adapter uses agrees with RFC 4231, and with a second implementation", () => {
  it.each([
    ["Test Case 1", 0],
    ["Test Case 2", 1],
    ["Test Case 3", 2],
    ["Test Case 4", 3],
    ["Test Case 5", 4],
    ["Test Case 6", 5],
    ["Test Case 7", 6],
  ])("%s: hmacSha256Hex reproduces the published digest", (_name, index) => {
    const vector = RFC4231_HMAC_SHA256_VECTORS[index]!;
    const produced = hmacSha256Hex(Buffer.from(vector.key, "hex"), Buffer.from(vector.data, "hex"));
    expect(isSha256Hex(produced)).toBe(true);
    // Case 5 publishes only the first 128 bits (HMAC-SHA-256-128), so the
    // comparison is over as many digits as the RFC prints.
    expect(produced.slice(0, vector.hmacSha256.length)).toBe(vector.hmacSha256);
  });

  it.each([
    ["Test Case 1", 0],
    ["Test Case 2", 1],
    ["Test Case 3", 2],
    ["Test Case 4", 3],
    ["Test Case 5", 4],
    ["Test Case 6", 5],
    ["Test Case 7", 6],
  ])("%s: the RFC 2104 construction reproduces it too, and the two agree in full", (_name, index) => {
    const vector = RFC4231_HMAC_SHA256_VECTORS[index]!;
    const key = Buffer.from(vector.key, "hex");
    const data = Buffer.from(vector.data, "hex");
    const independent = rfc2104HmacSha256(key, data);
    expect(independent.slice(0, vector.hmacSha256.length)).toBe(vector.hmacSha256);
    // AND IN FULL, not only on the published prefix — which is the half of the
    // agreement Test Case 5's truncated digest cannot give.
    expect(independent).toBe(hmacSha256Hex(key, data));
  });

  it("the two implementations still agree on inputs the RFC does not publish", () => {
    // The vectors prove the standard cases; this proves the agreement is not a
    // coincidence of seven inputs. Keys either side of the block boundary, and
    // an EMPTY message, which the RFC has no case for.
    for (const keyLength of [0, 1, 63, 64, 65, 200]) {
      const key = Buffer.alloc(keyLength, 0x5a);
      for (const message of [Buffer.alloc(0), Buffer.from("the assistant's answer", "utf8")]) {
        expect(rfc2104HmacSha256(key, message)).toBe(hmacSha256Hex(key, message));
      }
    }
  });

  it("the independent construction CAN disagree, so its agreement means something", () => {
    // A negative control. Swapping ipad and opad is the most plausible way to get
    // RFC 2104 wrong, and the result must NOT reproduce the published digest —
    // otherwise the cases above would pass for a construction that is not HMAC.
    const vector = RFC4231_HMAC_SHA256_VECTORS[1]!;
    const key = Buffer.from(vector.key, "hex");
    const data = Buffer.from(vector.data, "hex");
    const swapped = rfc2104HmacSha256(key, data, HMAC_OPAD, HMAC_IPAD);
    expect(swapped).not.toBe(vector.hmacSha256);
    expect(swapped).not.toBe(hmacSha256Hex(key, data));
  });
});

describe("hex is parsed as a grammar, and the comparison never throws", () => {
  const vector = RFC4231_HMAC_SHA256_VECTORS[0]!;
  const digest = hmacSha256Hex(Buffer.from(vector.key, "hex"), Buffer.from(vector.data, "hex"));

  it("refuses a digest that is not exactly 64 hex digits", () => {
    expect(isSha256Hex(digest)).toBe(true);
    expect(isSha256Hex(digest.slice(0, -2))).toBe(false);
    expect(isSha256Hex(`${digest}00`)).toBe(false);
    // `Buffer.from(x, "hex")` would silently stop at the "z" and decode exactly
    // the 32 genuine bytes, so this value would COMPARE EQUAL to the real digest.
    // The grammar check on the string is the only thing that refuses it.
    expect(isSha256Hex(`${digest}zz`)).toBe(false);
    expect(digestsMatch(digest, `${digest}zz`)).toBe(false);
  });

  it("refuses a truncated digest rather than throwing a RangeError", () => {
    // `timingSafeEqual` raises on unequal lengths, and on a public endpoint the
    // caller chooses the header — so an unguarded comparison lets an anonymous
    // request choose whether this process answers 500.
    expect(() => digestsMatch(digest, digest.slice(0, 32))).not.toThrow();
    expect(digestsMatch(digest, digest.slice(0, 32))).toBe(false);
    expect(digestsMatch(digest, "")).toBe(false);
  });

  it("accepts upper-case hex, because the grammar is hex and not lower-case hex", () => {
    expect(digestsMatch(digest, digest.toUpperCase())).toBe(true);
    expect(digestsMatch(digest.toUpperCase(), digest)).toBe(true);
  });

  it("refuses a digest that differs in ONE bit", () => {
    const last = Number.parseInt(digest.slice(-1), 16);
    expect(digestsMatch(digest, `${digest.slice(0, -1)}${(last ^ 1).toString(16)}`)).toBe(false);
  });
});
