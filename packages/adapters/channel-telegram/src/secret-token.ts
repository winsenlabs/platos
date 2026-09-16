// A constant-time comparison of two shared secrets, and the honest account of
// what it is and is not worth.
//
// WHAT THIS IS. `setWebhook` lets the integrator choose a `secret_token`;
// Telegram echoes it in `X-Telegram-Bot-Api-Secret-Token` on every delivery. The
// check is: does the header equal the value this install configured? There is no
// signature, no key pair, no digest over the body — so the body is NOT
// authenticated at all, only the CALLER is, and only by a bearer string.
//
// WHAT FOLLOWS, AND IT IS WRITTEN HERE RATHER THAN DISCOVERED LATER. A caller who
// learns the token can post any body it likes; there is nothing in the request
// tying the token to the bytes. The defences that remain are TLS (the token never
// crosses the wire in clear), a token long enough not to be guessed, and the
// inbox's idempotency on `update_id`. `adapter.ts` says what that means for the
// evidence this directory can offer.
//
// WHY IT IS CONSTANT-TIME ANYWAY. A byte-at-a-time `===` on a secret compared
// against attacker-supplied input is a remote timing oracle: the classic attack
// recovers the token one character per few thousand requests. The comparison is
// worth making constant-time precisely BECAUSE the token is the only thing
// standing between an anonymous caller and the inbox.
//
// `timingSafeEqual` THROWS ON A LENGTH MISMATCH, and that is the whole reason
// this wrapper exists. `node:crypto`'s comparison requires equal-length buffers
// and raises `RangeError` otherwise. On a PUBLIC endpoint the attacker chooses
// the header, so an unguarded call lets an anonymous request decide whether this
// process answers 500 — and a 500-versus-401 difference is a length oracle for
// the token. So both sides are DIGESTED FIRST and the fixed-width digests are
// what `timingSafeEqual` sees: the comparison is then constant-time in the
// token's length as well as its bytes.
//
// `secret-token.test.ts` joins this to `node:crypto`'s OWN semantics rather than
// to a second copy of the rule: for every equal-length pair it must agree with
// `timingSafeEqual` exactly, and where `timingSafeEqual` throws it must answer
// `false`.

import { createHash, timingSafeEqual } from "node:crypto";

/**
 * A fixed-width digest of a candidate secret.
 *
 * SHA-256 is used as a length-hiding equality test and NOT as a key derivation:
 * the tokens are compared with each other and never stored, so no stretching is
 * called for, and two distinct tokens colliding here is a SHA-256 collision.
 */
function digest(value: string): Buffer {
  return createHash("sha256").update(value, "utf8").digest();
}

/**
 * True when the two secrets are equal, decided in constant time.
 *
 * `false` — never a throw — for anything, including an empty configured secret,
 * a longer presented one, and a shorter one.
 */
export function secretsMatch(configured: string, presented: string): boolean {
  // An install with no token configured must not be satisfiable by a caller
  // presenting no token: that would authenticate everyone. `config/channels.ts`
  // refuses an empty value at boot; this is the second line, not the first.
  if (configured === "") return false;
  const expected = digest(configured);
  const offered = digest(presented);
  // Both are 32 bytes by construction; the guard is kept because it is the
  // precondition `timingSafeEqual` throws on, and a future change to `digest`
  // must not turn that into a 500 an anonymous caller can trigger.
  if (expected.length !== offered.length) return false;
  return timingSafeEqual(expected, offered);
}
