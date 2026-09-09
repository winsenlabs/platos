// The three things `verify` must do that `generate` cannot be asked about:
// test every candidate, not leak which one matched, and refuse everything else.
//
// THE COLLISION IS WHY THIS SUITE CAN PROVE "NO EARLY EXIT" AT ALL.
//
// "It does not return on the first match" is normally an unfalsifiable claim: on
// every ordinary input exactly one candidate matches, so an implementation that
// returns immediately and one that finishes the loop produce identical answers,
// and the only observable difference is TIMING — which is not a thing a unit
// suite can assert without flaking. So a real input where TWO candidates match
// was searched for and found:
//
//   HPBZPDHQSPZ2C25I4WNDVHL54G2MG5AU produces 609452 at counter 1000483 AND at
//   counter 1000484.
//
// It was found by drawing 20-byte secrets until adjacent counters agreed —
// 652,483 draws, which is what a one-in-a-million event costs — and CONFIRMED
// against the extraction source's own `generateTotp`, so it is not an artefact of
// this implementation:
//
//   pnpm --filter @platos/tenancy-database build
//   node --input-type=module -e '
//     import { generateTotp } from
//       "./internal-packages/tenancy-database/dist/auth.js";
//     const s = "HPBZPDHQSPZ2C25I4WNDVHL54G2MG5AU";
//     for (const c of [1000483, 1000484])
//       console.log(c, generateTotp(s, new Date(c * 30000)));'
//   // 1000483 609452
//   // 1000484 609452
//
// With that secret the two implementations DISAGREE ON THE RETURNED VALUE, not
// merely on how long they take, and the disagreement is a one-line assertion.

import { describe, expect, it } from "vitest";

import { Base32SecretError } from "./base32.js";
import { createTotpCodeVerifier } from "./totp-code-verifier.js";

const totp = createTotpCodeVerifier();

/** The searched-for secret whose codes collide at two adjacent counters. */
const COLLIDING = "HPBZPDHQSPZ2C25I4WNDVHL54G2MG5AU";
const COLLIDING_CODE = "609452";
const FIRST = 1000483n;
const SECOND = 1000484n;

/** RFC 4648's `foobar`, used wherever a second, unrelated secret is needed. */
const OTHER = "MZXW6YTBOI";

describe("the collision is real, and it is the extraction source's collision", () => {
  it("produces the same six digits at both counters", () => {
    expect(totp.generate(COLLIDING, FIRST)).toBe(COLLIDING_CODE);
    expect(totp.generate(COLLIDING, SECOND)).toBe(COLLIDING_CODE);
  });

  it("produces different digits at the counters either side of it", () => {
    // Without this, "the codes collide" could be true of an implementation that
    // returned a constant. These are the extraction source's recorded answers
    // for the two neighbouring counters.
    expect(totp.generate(COLLIDING, FIRST - 1n)).toBe("528151");
    expect(totp.generate(COLLIDING, SECOND + 1n)).toBe("463948");
  });
});

describe("verify tests every candidate rather than returning on the first match", () => {
  it("returns the LAST matching counter when two candidates match", () => {
    // AN EARLY-EXIT IMPLEMENTATION RETURNS `FIRST` HERE. That is the whole of
    // the case: the two behaviours are distinguishable by value, so the port's
    // "MUST test every candidate" is a checked property rather than a comment.
    expect(
      totp.verify({
        secret: COLLIDING,
        code: COLLIDING_CODE,
        candidateCounters: [FIRST, SECOND],
      }),
    ).toBe(SECOND);
  });

  it("still returns the last match when the window carries a non-matching tail", () => {
    // The domain's window is three counters wide, so this is the shape a real
    // `verifyMfaForSession` produces when the collision falls at its start.
    expect(
      totp.verify({
        secret: COLLIDING,
        code: COLLIDING_CODE,
        candidateCounters: [FIRST, SECOND, SECOND + 1n],
      }),
    ).toBe(SECOND);
  });

  it("returns the only match when there is only one, wherever it sits", () => {
    // THE POSITIVE CONTROL. "Last match wins" must not be "last candidate wins":
    // an implementation that ignored the comparison entirely and returned the
    // final counter would pass both cases above and fail this one.
    expect(
      totp.verify({
        secret: COLLIDING,
        code: "528151",
        candidateCounters: [FIRST - 1n, FIRST, SECOND],
      }),
    ).toBe(FIRST - 1n);
  });

  it("returns null when no candidate matches, however many there are", () => {
    expect(
      totp.verify({
        secret: COLLIDING,
        code: "000000",
        candidateCounters: [FIRST - 1n, FIRST, SECOND, SECOND + 1n],
      }),
    ).toBeNull();
  });

  it("returns null for an empty candidate list without touching the code", () => {
    expect(totp.verify({ secret: COLLIDING, code: COLLIDING_CODE, candidateCounters: [] })).toBeNull();
  });
});

describe("a code that is not a code is refused, and refused as a code", () => {
  it("refuses a five-digit code rather than throwing on the length", () => {
    // `timingSafeEqual` THROWS on operands of different lengths. A refusal here
    // is what says the length is checked BEFORE the constant-time primitive is
    // reached; an exception out of `verify` would be a 500 where a failed login
    // belongs.
    expect(totp.verify({ secret: COLLIDING, code: "60945", candidateCounters: [FIRST] })).toBeNull();
  });

  it("refuses a seven-digit code", () => {
    expect(totp.verify({ secret: COLLIDING, code: "6094520", candidateCounters: [FIRST] })).toBeNull();
  });

  it("refuses an empty code", () => {
    expect(totp.verify({ secret: COLLIDING, code: "", candidateCounters: [FIRST] })).toBeNull();
  });

  it("refuses a code of the right length that is not digits", () => {
    expect(totp.verify({ secret: COLLIDING, code: "abcdef", candidateCounters: [FIRST] })).toBeNull();
  });

  it("refuses a code that is right for another secret", () => {
    const code = totp.generate(OTHER, FIRST);
    expect(totp.verify({ secret: COLLIDING, code, candidateCounters: [FIRST] })).toBeNull();
    // The positive control: the same code under the secret it belongs to.
    expect(totp.verify({ secret: OTHER, code, candidateCounters: [FIRST] })).toBe(FIRST);
  });
});

describe("an unreadable secret is a broken credential, not a wrong code", () => {
  it("throws rather than answering null on a secret that is not base32", () => {
    // A `null` here would tell the operator their authenticator is out of sync
    // when what has actually happened is that the stored ciphertext decrypted to
    // something that is not a secret. The two need different responses, so they
    // get different outcomes.
    expect(() =>
      totp.verify({ secret: "not a secret", code: "000000", candidateCounters: [FIRST] }),
    ).toThrow(Base32SecretError);
  });

  it("throws on an empty secret rather than verifying against a zero-length key", () => {
    // An empty string IS valid base32 — it decodes to zero bytes — so this is not
    // caught by the alphabet check, and HMAC over a zero-length key is perfectly
    // well defined. It would produce a code that verifies, for a credential that
    // holds no secret at all.
    expect(() =>
      totp.verify({ secret: "", code: "000000", candidateCounters: [FIRST] }),
    ).toThrow(Base32SecretError);
  });

  it("throws on an empty secret in generate for the same reason", () => {
    expect(() => totp.generate("", 0n)).toThrow(Base32SecretError);
  });
});
