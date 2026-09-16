// THE PRIMITIVE, JOINED TO THE STANDARD.
//
// `ed25519.ts` turns a raw 32-byte public key into something `node:crypto` will
// verify with, by putting a DER header in front of it. That header is the one
// thing in the verification path this repository wrote, and if it were wrong
// every Discord delivery would be refused — or, worse, accepted against a key
// parsed as something else. So it is driven here by RFC 8032 §7.1's own vectors,
// which nothing in this repository produced.
//
// AND THE TRANSCRIPTION IS CHECKED, NOT TRUSTED. A vector file with one wrong
// digit is still self-consistent enough to fool a suite that only verifies it.
// Every vector is re-derived from its own secret key here: the public key must
// come back out of the seed, the signature must be reproduced byte for byte
// (Ed25519 is deterministic), the message must be the length the RFC states, and
// SHA(abc)'s message must be SHA-512 of "abc".

import { createHash, createPublicKey, sign } from "node:crypto";

import { describe, expect, it } from "vitest";

import { ED25519_SPKI_PREFIX_HEX, importEd25519PublicKey, isSignatureHex, verifyEd25519 } from "./ed25519.js";
import { privateKeyFromSeed } from "./fixtures.js";
import { RFC8032_ED25519_VECTORS } from "./rfc8032-vectors.js";

function flipLastBit(hex: string): string {
  const last = Number.parseInt(hex.slice(-1), 16);
  return `${hex.slice(0, -1)}${(last ^ 1).toString(16)}`;
}

describe("RFC 8032 §7.1 is transcribed, not invented", () => {
  // The tables below name each vector by INDEX, spelled as array literals because
  // the test-case census counts rows statically; this case pins that index i IS
  // the vector the table calls it, so a reordered file cannot mislabel a case.
  it("holds all five Ed25519 vectors the section publishes, in order", () => {
    expect(RFC8032_ED25519_VECTORS.map((vector) => vector.name)).toEqual([
      "TEST 1",
      "TEST 2",
      "TEST 3",
      "TEST 1024",
      "TEST SHA(abc)",
    ]);
  });

  it.each([
    ["TEST 1", 0],
    ["TEST 2", 1],
    ["TEST 3", 2],
    ["TEST 1024", 3],
    ["TEST SHA(abc)", 4],
  ])(
    "%s: the public key is the one its secret key derives, and the message is the stated length",
    (_name, index) => {
      const vector = RFC8032_ED25519_VECTORS[index]!;
      const derived = createPublicKey(privateKeyFromSeed(vector.secretKey))
        .export({ format: "der", type: "spki" })
        .toString("hex");
      // The derived SPKI must be OUR prefix followed by the RFC's key: this is the
      // assertion that proves the prefix, from the other direction.
      expect(derived).toBe(`${ED25519_SPKI_PREFIX_HEX}${vector.publicKey}`);
      expect(vector.message.length / 2).toBe(vector.messageLength);
    },
  );

  it.each([
    ["TEST 1", 0],
    ["TEST 2", 1],
    ["TEST 3", 2],
    ["TEST 1024", 3],
    ["TEST SHA(abc)", 4],
  ])(
    "%s: the signature is reproduced byte for byte from the secret key",
    (_name, index) => {
      const vector = RFC8032_ED25519_VECTORS[index]!;
      const produced = sign(null, Buffer.from(vector.message, "hex"), privateKeyFromSeed(vector.secretKey));
      expect(produced.toString("hex")).toBe(vector.signature);
    },
  );

  it("TEST SHA(abc)'s message is SHA-512 of the three bytes it is named after", () => {
    const vector = RFC8032_ED25519_VECTORS[4]!;
    expect(createHash("sha512").update("abc", "utf8").digest("hex")).toBe(vector.message);
  });
});

describe("the verifier this adapter uses agrees with RFC 8032", () => {
  it.each([
    ["TEST 1", 0],
    ["TEST 2", 1],
    ["TEST 3", 2],
    ["TEST 1024", 3],
    ["TEST SHA(abc)", 4],
  ])(
    "%s is ACCEPTED over the raw published key",
    (_name, index) => {
      const vector = RFC8032_ED25519_VECTORS[index]!;
      const key = importEd25519PublicKey(vector.publicKey);
      expect(key).not.toBeNull();
      expect(verifyEd25519(key!, vector.signature, Buffer.from(vector.message, "hex"))).toBe(true);
    },
  );

  it.each([
    ["TEST 1", 0],
    ["TEST 2", 1],
    ["TEST 3", 2],
    ["TEST 1024", 3],
    ["TEST SHA(abc)", 4],
  ])(
    "%s is REFUSED with one bit of the signature flipped, and with one bit of the message flipped",
    (_name, index) => {
      const vector = RFC8032_ED25519_VECTORS[index]!;
      const key = importEd25519PublicKey(vector.publicKey)!;
      const message = Buffer.from(vector.message, "hex");
      expect(verifyEd25519(key, flipLastBit(vector.signature), message)).toBe(false);
      // TEST 1's message is EMPTY, so there is no bit to flip; one byte appended
      // is the smallest change to it.
      const changed = message.length === 0 ? Buffer.from([0]) : Buffer.from(message);
      if (message.length > 0) changed[0] = changed[0]! ^ 1;
      expect(verifyEd25519(key, vector.signature, changed)).toBe(false);
    },
  );

  it("refuses every vector's signature under every OTHER vector's key", () => {
    // A verifier that ignored the key — or parsed every key as the same point —
    // would pass both cases above. Twenty cross-pairs, all refused.
    for (const signer of RFC8032_ED25519_VECTORS) {
      for (const holder of RFC8032_ED25519_VECTORS) {
        if (signer === holder) continue;
        const key = importEd25519PublicKey(holder.publicKey)!;
        expect(verifyEd25519(key, signer.signature, Buffer.from(signer.message, "hex"))).toBe(false);
      }
    }
  });
});

describe("hex is parsed as a grammar, never truncated", () => {
  it("refuses a key that is not exactly 64 hex digits", () => {
    const good = RFC8032_ED25519_VECTORS[0]!.publicKey;
    expect(importEd25519PublicKey(good.slice(0, -2))).toBeNull();
    expect(importEd25519PublicKey(`${good}00`)).toBeNull();
    // Decodes to exactly the genuine 32 bytes if parsed by `Buffer.from` alone.
    expect(importEd25519PublicKey(`${good}zz`)).toBeNull();
    // `Buffer.from(x, "hex")` would silently stop at the "z" and decode a
    // one-byte key. The grammar check is what stops that reaching `node:crypto`.
    expect(importEd25519PublicKey(`${good.slice(0, 2)}${"z".repeat(62)}`)).toBeNull();
  });

  it("refuses a signature that is not exactly 128 hex digits, without throwing", () => {
    const vector = RFC8032_ED25519_VECTORS[1]!;
    const key = importEd25519PublicKey(vector.publicKey)!;
    const message = Buffer.from(vector.message, "hex");
    expect(isSignatureHex(vector.signature)).toBe(true);
    expect(verifyEd25519(key, vector.signature.slice(0, -2), message)).toBe(false);
    expect(verifyEd25519(key, `${vector.signature.slice(0, -1)}g`, message)).toBe(false);
    expect(verifyEd25519(key, "", message)).toBe(false);
    // Trailing garbage after a GENUINE signature: `Buffer.from` would decode the
    // 64 real bytes and this would verify.
    expect(verifyEd25519(key, `${vector.signature}zz`, message)).toBe(false);
  });

  it("accepts upper-case hex, because the grammar is hex and not lower-case hex", () => {
    const vector = RFC8032_ED25519_VECTORS[2]!;
    const key = importEd25519PublicKey(vector.publicKey.toUpperCase())!;
    expect(verifyEd25519(key, vector.signature.toUpperCase(), Buffer.from(vector.message, "hex"))).toBe(true);
  });
});
