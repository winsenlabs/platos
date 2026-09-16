// Ed25519 verification over RAW key and signature bytes, with `node:crypto` and
// nothing else.
//
// WHY THIS IS A MODULE OF ITS OWN. Two different things can be wrong about a
// Discord signature check, and a suite can only tell them apart if they are
// reachable separately:
//
//   THE PRIMITIVE — is this Ed25519 as RFC 8032 defines it, over a 32-byte raw
//   public key? `node:crypto` does not accept a raw key: it takes a DER
//   SubjectPublicKeyInfo, so a 12-byte prefix has to be put in front of the
//   32 bytes Discord publishes, and a wrong prefix is either a refusal of every
//   key or — worse — a key parsed as some other curve's. `rfc8032.test.ts`
//   drives THIS module with the RFC's own vectors, so the prefix is proven by the
//   standard and not by a second copy of itself.
//
//   THE CONSTRUCTION — is the signed message `timestamp + body`, in that order,
//   UTF-8, with a hex-encoded signature? That is Discord's rule, not the RFC's,
//   and `verify.ts` owns it. `discord-signature.test.ts` joins it to Discord's
//   own published helper library.
//
// STRICT HEX, BECAUSE `Buffer.from(value, "hex")` IS NOT A PARSER. It stops at
// the first character that is not a hex digit and returns what it had, so
// `"ab" + "zz" * 62` decodes to ONE byte and a length check after decoding is the
// only thing between that and a verify call on a truncated signature. The
// grammar is checked on the STRING, before any decoding, and a value that is not
// exactly 64 (key) or 128 (signature) hex digits is not a key or a signature.

import { createPublicKey, verify, type KeyObject } from "node:crypto";

/**
 * The DER SubjectPublicKeyInfo header for an Ed25519 key (RFC 8410 §4):
 * SEQUENCE { SEQUENCE { OID 1.3.101.112 } BIT STRING (33 bytes, 0 unused) }.
 * Thirty-two raw key bytes follow it.
 */
export const ED25519_SPKI_PREFIX_HEX = "302a300506032b6570032100";

const PUBLIC_KEY_HEX = /^[0-9a-fA-F]{64}$/u;
const SIGNATURE_HEX = /^[0-9a-fA-F]{128}$/u;

/** A raw 32-byte Ed25519 public key as `node:crypto` wants it, or null. */
export function importEd25519PublicKey(publicKeyHex: string): KeyObject | null {
  if (!PUBLIC_KEY_HEX.test(publicKeyHex)) return null;
  try {
    return createPublicKey({
      key: Buffer.concat([Buffer.from(ED25519_SPKI_PREFIX_HEX, "hex"), Buffer.from(publicKeyHex, "hex")]),
      format: "der",
      type: "spki",
    });
  } catch {
    // Thirty-two bytes that are not a point on the curve. Not a key.
    return null;
  }
}

/** True for a well-formed 128-hex-digit signature string. */
export function isSignatureHex(signatureHex: string): boolean {
  return SIGNATURE_HEX.test(signatureHex);
}

/**
 * Verify one signature. Never throws: a malformed signature is `false`, which
 * is the only answer a caller on a public endpoint can act on.
 */
export function verifyEd25519(publicKey: KeyObject, signatureHex: string, message: Buffer): boolean {
  if (!isSignatureHex(signatureHex)) return false;
  try {
    // `null` digest: Ed25519 hashes internally (SHA-512) and takes no digest
    // choice, and passing one is an error in Node rather than a no-op.
    return verify(null, message, publicKey, Buffer.from(signatureHex, "hex"));
  } catch {
    return false;
  }
}
