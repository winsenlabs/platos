// HMAC-SHA256 over raw bytes, a strict hex grammar, and a comparison that does
// not leak the digest one byte at a time — with `node:crypto` and nothing else.
//
// WHY THIS IS A MODULE OF ITS OWN. Three different things can be wrong about a
// `X-Hub-Signature-256` check, and a suite can only tell them apart if they are
// reachable separately:
//
//   THE PRIMITIVE — is this HMAC-SHA256 as RFC 2104 defines it, keyed by the raw
//   bytes of the app secret? `rfc4231.test.ts` drives THIS module with RFC 4231's
//   own published vectors and, for every one of them, with a second HMAC built
//   from `node:crypto`'s raw SHA-256 exactly as RFC 2104 §2 writes it. So the
//   primitive is proven by a standard and by an independent construction, and not
//   by a second copy of itself.
//
//   THE CONSTRUCTION — is the signed message the RAW REQUEST BODY, with the
//   result rendered as `sha256=` plus lower-case hex? That is Meta's rule, not
//   the RFC's, and `verify.ts` owns it.
//
//   THE COMPARISON — is the check constant-time, and does it refuse a length
//   mismatch rather than throwing? That is here, because it is the only part an
//   attacker interacts with directly.
//
// `timingSafeEqual` THROWS ON A LENGTH MISMATCH, and that is the whole reason
// this wrapper exists. `node:crypto`'s comparison requires equal-length buffers
// and raises `RangeError` otherwise. On a PUBLIC endpoint the attacker chooses
// the header, so the attacker chooses whether this process throws — and an
// unhandled throw out of a verifier is a 500 that distinguishes "wrong length"
// from "wrong digest" by response code alone. The length is checked first and a
// mismatch is `false`.
//
// STRICT HEX, BECAUSE `Buffer.from(value, "hex")` IS NOT A PARSER. It stops at
// the first character that is not a hex digit and returns what it had, so
// `<64 genuine digits> + "zz"` decodes to exactly the genuine 32 bytes and would
// COMPARE EQUAL to them. The grammar is checked on the STRING, before any
// decoding, and a value that is not exactly 64 hex digits is not a digest.

import { createHmac, timingSafeEqual } from "node:crypto";

/** Exactly 64 hexadecimal digits — a SHA-256 digest and nothing else. */
const SHA256_HEX = /^[0-9a-fA-F]{64}$/u;

/** True for a well-formed 64-hex-digit digest string. */
export function isSha256Hex(value: string): boolean {
  return SHA256_HEX.test(value);
}

/**
 * HMAC-SHA256 of `message` under `key`, lower-case hex.
 *
 * Both arguments are BYTES and not strings. Meta keys the digest with the app
 * secret's octets and computes it over the request body's octets; taking a
 * `string` here would put an encoding choice between this function and the wire,
 * and the wrong choice is invisible until a customer's name has an accent in it.
 */
export function hmacSha256Hex(key: Buffer, message: Buffer): string {
  return createHmac("sha256", key).update(message).digest("hex");
}

/**
 * Compare two hex digests in constant time.
 *
 * `false` — never a throw — for anything that is not a pair of well-formed
 * digests of equal length. Case-insensitive, because the grammar is hex: Meta
 * writes lower case and a proxy that upper-cased the header would otherwise turn
 * every genuine delivery into a forgery.
 */
export function digestsMatch(expectedHex: string, presentedHex: string): boolean {
  if (!isSha256Hex(expectedHex) || !isSha256Hex(presentedHex)) return false;
  const expected = Buffer.from(expectedHex.toLowerCase(), "hex");
  const presented = Buffer.from(presentedHex.toLowerCase(), "hex");
  // Both are 32 bytes by the grammar above; the guard is kept because it is the
  // precondition `timingSafeEqual` throws on, and a future grammar change must
  // not turn that into a 500.
  if (expected.length !== presented.length) return false;
  return timingSafeEqual(expected, presented);
}
