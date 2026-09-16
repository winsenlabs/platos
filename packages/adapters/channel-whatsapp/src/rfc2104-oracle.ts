// AN INDEPENDENT HMAC-SHA256, BUILT FROM RAW SHA-256 — THE ORACLE, NEVER THE
// IMPLEMENTATION.
//
// `hmac.ts` is what this adapter runs: `node:crypto`'s `createHmac("sha256", …)`.
// THIS module is a second implementation of the same function, written from
// `node:crypto`'s raw SHA-256 exactly as RFC 2104 §2 defines it, and it exists
// only so the suites have something to disagree with.
//
// WHY IT IS HERE AT ALL, AND WHAT IT STANDS IN FOR. `channel-slack` joins its
// signature suite to SLACK'S OWN PUBLISHED worked example — a secret, a body and
// the signature they produce — so agreement there is between the vendor's
// arithmetic and Node's. Meta publishes the `X-Hub-Signature-256` construction in
// prose and code samples and NO worked example with concrete bytes, so there is
// no vendor vector to transcribe. This module plus RFC 4231's published vectors
// is what takes its place: the primitive is checked against a standard's own
// digests by TWO implementations that share nothing but SHA-256.
//
// NOTHING IN THE ADAPTER MAY IMPORT IT. `index.ts` does not publish it and
// `adapter.ts`, `verify.ts` and `send.ts` do not reach for it. An oracle that the
// implementation called would be the implementation, and the agreement would be a
// tautology — which is exactly the failure `channel-runtime.ts`'s header warns
// about for Telegram's shared-token check.
//
//   K' = K when len(K) <= B, else H(K); then zero-padded to B bytes
//   HMAC(K, text) = H((K' XOR opad) || H((K' XOR ipad) || text))
//
// with B = 64, ipad = 0x36 repeated, opad = 0x5c repeated.

import { createHash } from "node:crypto";

/** SHA-256's block size in bytes, which is what the key schedule pads to. */
export const HMAC_BLOCK_SIZE = 64;

export const HMAC_IPAD = 0x36;
export const HMAC_OPAD = 0x5c;

function sha256(input: Buffer): Buffer {
  return createHash("sha256").update(input).digest();
}

/**
 * HMAC-SHA256 per RFC 2104 §2, lower-case hex.
 *
 * `ipad` and `opad` are parameters ONLY so the suite can build a deliberately
 * wrong construction from the same code and show that the agreement it asserts
 * is capable of failing. The adapter never calls this at all, let alone with
 * anything but the defaults.
 */
export function rfc2104HmacSha256(
  key: Buffer,
  message: Buffer,
  ipadByte: number = HMAC_IPAD,
  opadByte: number = HMAC_OPAD,
): string {
  const shortened = key.length > HMAC_BLOCK_SIZE ? sha256(key) : key;
  const padded = Buffer.alloc(HMAC_BLOCK_SIZE);
  shortened.copy(padded);
  const inner = Buffer.alloc(HMAC_BLOCK_SIZE);
  const outer = Buffer.alloc(HMAC_BLOCK_SIZE);
  for (let index = 0; index < HMAC_BLOCK_SIZE; index += 1) {
    inner[index] = padded[index]! ^ ipadByte;
    outer[index] = padded[index]! ^ opadByte;
  }
  return sha256(Buffer.concat([outer, sha256(Buffer.concat([inner, message]))])).toString("hex");
}
