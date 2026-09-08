// The IETF's own answers, and the reason this tranche can claim RFC 6238 at all.
//
// THE EXTRACTION SOURCE HAS NO TOTP CODE THIS ADAPTER COULD BE COMPARED AGAINST
// FOR THE ALGORITHM ITSELF — it has an implementation, and
// `oracle-totp-differential.test.ts` twin-runs against it — but an
// implementation is not an authority. Two implementations that made the same
// mistake would agree with each other perfectly. RFC 4226 Appendix D and RFC
// 6238 Appendix B publish the ANSWERS, computed by the people who defined the
// algorithm, and nothing in this repository can move them. That is the strongest
// join available anywhere in this tranche and it costs nothing to make.
//
// THE SEED IS THE RFCs' SEED. Both appendices use the twenty ASCII bytes
// `12345678901234567890`. Base32 of those bytes is
// `GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ`, which `the RFC's seed encodes to the
// published base32` below derives rather than asserts — so the constant this
// file feeds the verifier is produced by the encoder under test from the RFC's
// own bytes, and a wrong alphabet would break every case here rather than
// quietly re-deriving a wrong constant on both sides.
//
// SIX DIGITS FROM AN EIGHT-DIGIT TABLE. RFC 6238's table publishes `TOTP` at
// eight digits. HOTP is `binary mod 10^Digit`, so the six-digit code is the
// eight-digit one's last six characters, and the `digits8` column below is
// carried beside `code` so a reader can check that reduction against the RFC by
// eye instead of taking this comment's word for it.

import { describe, expect, it } from "vitest";

import { encodeBase32 } from "./base32.js";
import { createTotpCodeVerifier } from "./totp-code-verifier.js";

/** The twenty ASCII bytes both appendices use as the shared secret. */
const RFC_SEED_ASCII = "12345678901234567890";

const SEED = encodeBase32(new TextEncoder().encode(RFC_SEED_ASCII));

const totp = createTotpCodeVerifier();

describe("the seed both RFCs use", () => {
  it("encodes to the base32 every published vector below is read under", () => {
    expect(SEED).toBe("GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ");
  });

  it("is twenty bytes, which is what mintTotpSecret emits", () => {
    expect(RFC_SEED_ASCII).toHaveLength(20);
  });
});

describe("RFC 4226 Appendix D — the HOTP values for counts 0 to 9", () => {
  it.each([
    { count: 0n, code: "755224" },
    { count: 1n, code: "287082" },
    { count: 2n, code: "359152" },
    { count: 3n, code: "969429" },
    { count: 4n, code: "338314" },
    { count: 5n, code: "254676" },
    { count: 6n, code: "287922" },
    { count: 7n, code: "162583" },
    { count: 8n, code: "399871" },
    { count: 9n, code: "520489" },
  ])("generates $code at count $count", ({ count, code }) => {
    expect(totp.generate(SEED, count)).toBe(code);
  });
});

describe("RFC 6238 Appendix B — the SHA-1 rows, at the counter the RFC prints", () => {
  // The RFC's `T` column is the counter in hexadecimal and its `Time` column is
  // the Unix seconds it came from. BOTH are carried: `counter` is the RFC's own
  // `T` in decimal, and `time`/`step` are here so a reader can confirm
  // `floor(time / 30)` reproduces it without trusting this file's arithmetic.
  // The window that turns a time into a set of candidate counters is
  // `domain/mfa.ts`'s and not this adapter's, which is why `verify` is not what
  // these rows drive.
  it.each([
    { time: 59, step: 30, counter: 0x0000000000000001n, digits8: "94287082", code: "287082" },
    { time: 1111111109, step: 30, counter: 0x00000000023523ecn, digits8: "07081804", code: "081804" },
    { time: 1111111111, step: 30, counter: 0x00000000023523edn, digits8: "14050471", code: "050471" },
    { time: 1234567890, step: 30, counter: 0x000000000273ef07n, digits8: "89005924", code: "005924" },
    { time: 2000000000, step: 30, counter: 0x0000000003f940aan, digits8: "69279037", code: "279037" },
    { time: 20000000000, step: 30, counter: 0x0000000027bc86aan, digits8: "65353130", code: "353130" },
  ])("generates $code at the RFC's time $time", ({ time, step, counter, digits8, code }) => {
    // The RFC's own two columns must agree before the vector is used at all.
    expect(BigInt(Math.floor(time / step))).toBe(counter);
    expect(digits8.slice(-6)).toBe(code);
    expect(totp.generate(SEED, counter)).toBe(code);
  });
});

describe("the published vectors are reachable through verify, not only generate", () => {
  it("accepts RFC 4226 count 3 when it is one of three candidates", () => {
    expect(totp.verify({ secret: SEED, code: "969429", candidateCounters: [2n, 3n, 4n] })).toBe(3n);
  });

  it("refuses RFC 4226 count 3's code when count 3 is not a candidate", () => {
    expect(totp.verify({ secret: SEED, code: "969429", candidateCounters: [5n, 6n, 7n] })).toBeNull();
  });

  it("refuses a code that is right for a different secret", () => {
    // The negative control the case above needs: a refusal that came from the
    // SECRET rather than from the counter. `MZXW6YTBOI` is RFC 4648's `foobar`.
    expect(
      totp.verify({ secret: "MZXW6YTBOI", code: "755224", candidateCounters: [0n, 1n, 2n] }),
    ).toBeNull();
  });
});
