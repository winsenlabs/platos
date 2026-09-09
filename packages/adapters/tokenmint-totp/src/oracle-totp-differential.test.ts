// Does this verifier agree with the code that is running in production TODAY?
//
// WHY THIS EXISTS BESIDE `rfc-vectors.test.ts`. Those vectors prove this adapter
// implements the STANDARD. They cannot prove it implements what the extraction
// source implements, and the two are different claims: a live installation's
// enrolled operators have secrets that `internal-packages/tenancy-database/src/
// auth.ts` minted and codes that its `generateTotp` accepts, and if this adapter
// disagreed with that file by one bit, every one of those operators would be
// locked out on the day V1 took over — with "invalid authentication code" as the
// only symptom, which reads as a broken phone rather than as a broken deploy.
//
// WHY THE VALUES ARE FROZEN HERE RATHER THAN IMPORTED. ADR M0.3 §5.1's
// `tenancy-prisma-only` names `packages/adapters/postgres-tenancy` as the ONLY
// directory that may import `@platos/tenancy-database`, and that rule is not
// negotiable for a convenience in a test. So the oracle is run OFFLINE and its
// answers are recorded, exactly as `packages/adapters/keyring-envelope/src/
// wire-vectors.ts` records ciphertexts produced by the same package. Unlike a
// ciphertext, a TOTP code is DETERMINISTIC, so anyone can re-derive every row
// below and get the same bytes:
//
//   pnpm --filter @platos/tenancy-database build
//   node --input-type=module -e '
//     import { generateTotp } from
//       "./internal-packages/tenancy-database/dist/auth.js";
//     console.log(generateTotp(SECRET_BASE32, new Date(COUNTER * 30000)));'
//
// `generateTotp(secret, at)` derives its counter as `floor(at/1000/30)`, so
// `new Date(counter * 30000)` is the instant that names a counter exactly. That
// is the whole of the adaptation between the two shapes, and it is stated rather
// than hidden inside a helper.
//
// WHAT MAKES THESE ROWS EVIDENCE AND NOT DECORATION. `755224` at counter 0 is
// simultaneously RFC 4226 Appendix D's first published value AND what the
// extraction source returned when it was run to produce this file. The two
// authorities agree on that row, which is what says the recording procedure was
// sound; the rows the RFC does not cover are then the ones doing new work.

import { describe, expect, it } from "vitest";

import { createTotpCodeVerifier } from "./totp-code-verifier.js";

const totp = createTotpCodeVerifier();

/** The RFC 4226 seed, base32. Shared with `rfc-vectors.test.ts` by value only. */
const ASCII_SEED = "GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ";

/** Twenty bytes of 0xA5 — a secret with no structure the RFC ever exercises. */
const REPEATING = "UWS2LJNFUWS2LJNFUWS2LJNFUWS2LJNF";

/** Twenty ascending bytes, 0x00 to 0x13 — the low-entropy end of the space. */
const ASCENDING = "AAAQEAYEAUDAOCAJBIFQYDIOB4IBCEQT";

describe("this adapter reproduces the extraction source's generateTotp", () => {
  it.each([
    { secret: ASCII_SEED, counter: 0n, code: "755224", alsoRfc: true },
    { secret: ASCII_SEED, counter: 1n, code: "287082", alsoRfc: true },
    { secret: ASCII_SEED, counter: 59n, code: "083773", alsoRfc: false },
    { secret: ASCII_SEED, counter: 37037036n, code: "081804", alsoRfc: true },
    { secret: ASCII_SEED, counter: 1234567890n, code: "965462", alsoRfc: false },
    { secret: ASCII_SEED, counter: 59999999999n, code: "873652", alsoRfc: false },
    { secret: REPEATING, counter: 0n, code: "249715", alsoRfc: false },
    { secret: REPEATING, counter: 1n, code: "269518", alsoRfc: false },
    { secret: REPEATING, counter: 59n, code: "050071", alsoRfc: false },
    { secret: REPEATING, counter: 37037036n, code: "219645", alsoRfc: false },
    { secret: REPEATING, counter: 1234567890n, code: "493723", alsoRfc: false },
    { secret: REPEATING, counter: 59999999999n, code: "070117", alsoRfc: false },
    { secret: ASCENDING, counter: 0n, code: "858575", alsoRfc: false },
    { secret: ASCENDING, counter: 1n, code: "524447", alsoRfc: false },
    { secret: ASCENDING, counter: 59n, code: "356862", alsoRfc: false },
    { secret: ASCENDING, counter: 37037036n, code: "626036", alsoRfc: false },
    { secret: ASCENDING, counter: 1234567890n, code: "388714", alsoRfc: false },
    { secret: ASCENDING, counter: 59999999999n, code: "381585", alsoRfc: false },
  ])("returns $code for $secret at counter $counter", ({ secret, counter, code }) => {
    expect(totp.generate(secret, counter)).toBe(code);
  });
});

describe("a secret THIS adapter minted opens under the extraction source's decoder", () => {
  // THE ONE PROPERTY A FROZEN CODE CANNOT SHOW ON ITS OWN. Every row above is
  // read under a base32 string that already existed; what an enrolment does is
  // MINT one and hand it to a phone, and the extraction source would be the
  // thing verifying it during a cutover. `REPEATING` and `ASCENDING` above were
  // produced by encoding twenty known bytes with THIS adapter's `encodeBase32`
  // and were then fed to the oracle's `generateTotp`, which decoded them with
  // ITS decoder and returned the recorded answers. A one-character alphabet
  // difference between the two would have made every one of those twelve rows
  // wrong, so their agreement IS the encoder differential.
  it("is exactly the width the oracle's randomBytes(20) produces", () => {
    expect(REPEATING).toHaveLength(32);
    expect(ASCENDING).toHaveLength(32);
  });
});

describe("the two agree on the counter width, not only on short counters", () => {
  it("agrees past 2^32, where a 32-bit counter buffer would diverge", () => {
    // 59999999999 is above `2^32` (4294967295). An implementation that wrote the
    // counter into four bytes rather than eight — a common mistake, and one every
    // small-counter vector in this file would miss — returns a different code
    // here. The recorded value is the extraction source's.
    expect(59999999999n > 4294967295n).toBe(true);
    expect(totp.generate(ASCII_SEED, 59999999999n)).toBe("873652");
  });

  it("refuses a negative counter rather than wrapping it", () => {
    // `writeBigUInt64BE` throws on a negative value. `domain/mfa.ts` already
    // drops negative counters from the window, so this is the second line — and
    // wrapping would be the dangerous alternative, because `-1` would become
    // `2^64-1` and produce a code that verifies for a counter no clock reaches.
    expect(() => totp.generate(ASCII_SEED, -1n)).toThrow();
  });
});
