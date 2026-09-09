// TotpCodeVerifier — RFC 6238 over RFC 4226, and nothing else.
//
// WHAT IS PROVED AND WHERE. There is no differential to run against the
// extraction source for the ALGORITHM, because there is nothing to disagree
// about: HOTP is a published standard with published answers.
// `rfc4226-vectors.test.ts` and `rfc6238-vectors.test.ts` join this file to the
// IETF's own tables, which is an authority outside this repository entirely and
// the strongest join available anywhere in this tranche.
// `oracle-totp-differential.test.ts` then joins it to the extraction source's
// `generateTotp` as well, so a divergence from the running system is caught even
// if both this file and the RFCs were read the same wrong way — they were not,
// but "the RFC agrees" and "production agrees" are two different claims and both
// are made.
//
// SHA-1 IS CORRECT HERE AND IS NOT A LAPSE. RFC 6238 §1.2 fixes HMAC-SHA-1 as
// the default and every authenticator application implements it; a SHA-256
// variant exists in the RFC and no phone will produce it unless the provisioning
// URI says so, which this platform's `otpAuthUri` does not. The port's own header
// says the same thing and adds the sentence that matters: every OTHER hash in
// `identity-access` is SHA-256, and the two must not be confused.
//
// THE WINDOW IS NOT HERE. `candidateCounters` arrives from the caller, which
// means clock-skew tolerance is `domain/mfa.ts`'s `totpCounterWindow` and the
// replay rule is `acceptTotpCounter`. Adding a second window here would make the
// tolerated skew the product of two numbers, only one of which anybody would
// think to look at.

import { createHmac, timingSafeEqual } from "node:crypto";

import type { TotpCodeVerifier } from "@platos/context-identity-access/application/ports/index.js";
import { TOTP_DIGITS } from "@platos/context-identity-access/application/ports/index.js";

import { Base32SecretError, decodeBase32 } from "./base32.js";

/** RFC 4226 §5.3: the counter is an 8-byte big-endian value. */
const COUNTER_BYTES = 8;

/** RFC 4226 §5.3 step 2: the low four bits of the last digest byte. */
const OFFSET_MASK = 0x0f;

/** RFC 4226 §5.3 step 2: the high bit of the first selected byte is dropped. */
const SIGN_MASK = 0x7f;

/**
 * RFC 4226 §5.3 — dynamic truncation, then the modulus.
 *
 * Written against the RFC's own step numbering rather than against another
 * implementation, and checked against the RFC's own table. A counter is UNSIGNED
 * 64-bit on the wire, so `writeBigUInt64BE` refuses a negative one by throwing;
 * `domain/mfa.ts` already drops negative counters from the window, so this is a
 * second line rather than the only one.
 */
function codeAt(key: Uint8Array, counter: bigint): string {
  const message = Buffer.alloc(COUNTER_BYTES);
  message.writeBigUInt64BE(counter);
  const digest = createHmac("sha1", key).update(message).digest();
  const offset = (digest[digest.length - 1] as number) & OFFSET_MASK;
  const binary =
    (((digest[offset] as number) & SIGN_MASK) << 24) |
    ((digest[offset + 1] as number) << 16) |
    ((digest[offset + 2] as number) << 8) |
    (digest[offset + 3] as number);
  return String(binary % 10 ** TOTP_DIGITS).padStart(TOTP_DIGITS, "0");
}

/**
 * Constant-time string comparison that answers `false` instead of throwing.
 *
 * `timingSafeEqual` THROWS on operands of different lengths, and a thrown
 * exception out of `verify` would be a 500 where a refusal belongs. The length
 * check leaks only the length of a submitted code, which the attacker chose.
 */
function digitsEqual(left: string, right: string): boolean {
  const leftBytes = Buffer.from(left, "utf8");
  const rightBytes = Buffer.from(right, "utf8");
  if (leftBytes.length !== rightBytes.length) return false;
  return timingSafeEqual(leftBytes, rightBytes);
}

/**
 * The decoded shared secret, or a refusal.
 *
 * AN EMPTY SECRET IS REFUSED SEPARATELY FROM AN INVALID ONE, because it is not
 * invalid: `""` is legal base32 and RFC 4648 §10 publishes it as a vector, so
 * `decodeBase32` answers zero bytes rather than throwing and is right to. HMAC
 * over a zero-length key is equally well defined, which is the hazard — a
 * credential row that decrypted to an empty string would VERIFY codes, computed
 * under a key an attacker also has. There is no such thing as a legitimately
 * empty TOTP secret, so it is refused here where the key is used rather than
 * where it is parsed.
 */
function keyFor(secret: string): Uint8Array {
  const key = decodeBase32(secret);
  if (key.length === 0) throw new Base32SecretError("secret decodes to no key material");
  return key;
}

export function createTotpCodeVerifier(): TotpCodeVerifier {
  return {
    generate(secret: string, counter: bigint): string {
      return codeAt(keyFor(secret), counter);
    },

    verify(input: {
      readonly secret: string;
      readonly code: string;
      readonly candidateCounters: readonly bigint[];
    }): bigint | null {
      // The secret is `MfaSecretCipher.open`'s plaintext. A secret that is not
      // base32 is a CORRUPTED CREDENTIAL, not a wrong code, and `decodeBase32`
      // throws on it here exactly as the extraction source's decoder does — a
      // `null` would tell the operator their phone is out of sync when the row
      // is unreadable.
      const key = keyFor(input.secret);

      // NO EARLY EXIT, AND NO BRANCH ON THE RESULT INSIDE THE LOOP.
      //
      // `return counter` on the first match is the obvious shape and it leaks
      // which counter matched through how long the call took: a code accepted at
      // the window's first candidate returns after one HMAC, one accepted at its
      // last after three. That is an oracle for the clock offset between the
      // phone and the server, which narrows an offline search against a
      // recovered secret. Every candidate is therefore hashed and compared, and
      // the surviving index is selected by ARITHMETIC rather than by an `if`.
      let matches = 0;
      let matchedIndex = -1;
      for (let index = 0; index < input.candidateCounters.length; index += 1) {
        const counter = input.candidateCounters[index] as bigint;
        const equal = digitsEqual(input.code, codeAt(key, counter)) ? 1 : 0;
        matches += equal;
        matchedIndex = equal * index + (1 - equal) * matchedIndex;
      }

      if (matches === 0) return null;
      // THE LAST MATCH IN THE ORDER GIVEN, WHICH IS A DELIBERATE DIVERGENCE FROM
      // THE EXTRACTION SOURCE'S FIRST.
      //
      // Two candidates in one window can produce the same six digits — the
      // chance is about one in a million per pair, and `totp-collision.test.ts`
      // exhibits a real secret where it happens rather than arguing that it
      // could. The extraction source returns on the first match and therefore
      // reports the LOWER counter; `acceptTotpCounter` then refuses it whenever
      // the lower one has already been spent, and a human whose code was genuinely
      // valid is told it was not. Reporting the highest matching counter accepts
      // that login and burns MORE of the replay window, so it is the safer answer
      // as well as the kinder one. `totpCounterWindow` yields ascending counters,
      // so the last match is the highest.
      //
      // Nothing stored changes shape either way: what is written is a counter
      // that genuinely matches.
      return input.candidateCounters[matchedIndex] ?? null;
    },
  };
}
