// RFC 4648 base32, and the one alphabet an authenticator app will accept.
//
// WHY IT IS ITS OWN MODULE AND NOT A PRIVATE HELPER IN EITHER NEIGHBOUR. The
// TOTP shared secret is ENCODED by `TokenMinter.mintTotpSecret` and DECODED by
// `TotpCodeVerifier.generate`, which are two different ports. Give each its own
// private copy and the day one alphabet moves the other keeps working against
// its own encoding and nothing fails until a real phone is asked to agree. One
// module, imported by both, is why that cannot happen inside this directory —
// and it is the reason the two ports share a directory at all (see `adapter.ts`).
//
// WHICH ALPHABET, AND WHY THAT ONE. RFC 4648 §6 — `A-Z` then `2-7`, upper case.
// It is the alphabet RFC 6238's `otpauth://` URI is read under by every
// authenticator implementation, it is the alphabet the extraction source's own
// `encodeBase32`/`decodeBase32` pair uses (`internal-packages/tenancy-database/
// src/auth.ts`), and it is NOT base32hex (RFC 4648 §7, `0-9A-V`), which shares
// the "base32" name and no code point ordering with it. `base32.test.ts` pins it
// against RFC 4648 §10's own published vectors rather than against this comment.
//
// NO PADDING ON THE WAY OUT, PADDING TOLERATED ON THE WAY IN. A 20-byte secret
// is 160 bits, which is 32 base32 characters exactly, so the padding question
// never arises for the one input this adapter mints. It arises for the RFC's
// shorter vectors, and it arises for a secret a human retyped out of another
// system, so `decodeBase32` strips a trailing `=` run and `encodeBase32` emits
// none — the same asymmetry the extraction source has.

const ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";

/** Where each accepted character sits in the alphabet, or -1. */
const VALUES: ReadonlyMap<string, number> = new Map(
  Array.from(ALPHABET, (character, index) => [character, index] as const),
);

/** The error a caller sees when a secret is not base32 at all. */
export class Base32SecretError extends TypeError {
  constructor(message: string) {
    super(message);
    this.name = "Base32SecretError";
  }
}

/**
 * Bytes to unpadded upper-case RFC 4648 base32.
 *
 * Five bits at a time out of a rolling accumulator, most significant first. The
 * trailing partial group is LEFT-shifted into place rather than dropped, which is
 * what makes `decodeBase32(encodeBase32(b))` recover `b` for every length and not
 * only for multiples of five.
 */
export function encodeBase32(input: Uint8Array): string {
  let bits = 0;
  let value = 0;
  let output = "";
  for (const byte of input) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      output += ALPHABET[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) output += ALPHABET[(value << (5 - bits)) & 31];
  return output;
}

/**
 * Unpadded or padded base32 to bytes.
 *
 * A CHARACTER THIS ALPHABET DOES NOT CONTAIN IS REFUSED RATHER THAN SKIPPED.
 * Skipping is the tempting reading of "be liberal in what you accept" and it is
 * wrong here: `JBSWY3DPEHPK3PX0` and `JBSWY3DPEHPK3PX` would decode to the same
 * key, so a typo would silently become a DIFFERENT secret that still verifies
 * some codes. The extraction source throws on the same input, and so does this.
 *
 * Case is folded because the `otpauth://` URI is routinely lower-cased in
 * transit; whitespace and the `-` groupings humans type are NOT stripped here,
 * because the only caller inside this adapter is handed a string it minted.
 */
export function decodeBase32(input: string): Uint8Array {
  let bits = 0;
  let value = 0;
  const output: number[] = [];
  for (const character of input.toUpperCase().replace(/=+$/u, "")) {
    const index = VALUES.get(character);
    if (index === undefined) {
      throw new Base32SecretError("secret is not RFC 4648 base32");
    }
    value = (value << 5) | index;
    bits += 5;
    if (bits >= 8) {
      output.push((value >>> (bits - 8)) & 0xff);
      bits -= 8;
    }
  }
  return Uint8Array.from(output);
}
