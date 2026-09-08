// What the minter actually emits.
//
// THE WIDTHS ARE NOT PINNED HERE, and that is deliberate rather than an omission.
// `oracle-mint-widths.test.ts` pins `MINTED_TOKEN_BYTES` against the five
// extraction-source files; this suite pins the OUTPUT against those widths. The
// chain is oracle -> table -> token, and each link is a separate case in a
// separate file, so no case in this repository compares this module with itself.
//
// One case below does break that chain on purpose. `emits the character length
// base64url gives each width` writes 43, 22 and 64 as LITERALS — they are
// `ceil(bytes * 4 / 3)`, derived from RFC 4648 §5's encoding and from neither the
// oracle nor the table — so a table and an implementation that moved together
// would still be caught by a third statement neither of them can move.

import { describe, expect, it } from "vitest";

import { prefixOf, TOKEN_KINDS } from "@platos/context-identity-access/application/ports/index.js";

import { decodeBase32 } from "./base32.js";
import { createTokenMinter, MINTED_TOKEN_BYTES, RecoveryCodeCountError } from "./token-minter.js";

const minter = createTokenMinter();

const BASE64URL = /^[A-Za-z0-9_-]+$/u;

function randomPart(kind: Parameters<typeof prefixOf>[0]): string {
  return minter.mint(kind).slice(prefixOf(kind).length);
}

describe("every kind mints under its registered prefix", () => {
  it("carries the domain registry's prefix for every one of the eleven kinds", () => {
    for (const kind of TOKEN_KINDS) {
      expect(minter.mint(kind).startsWith(prefixOf(kind)), kind).toBe(true);
    }
  });

  it("carries no other kind's prefix, so classification cannot be ambiguous", () => {
    // THE NEGATIVE CONTROL THE CASE ABOVE NEEDS. `plt_oa_` is a prefix of
    // nothing else, but `plt_o...` is a shared stem across five kinds, and a
    // minted token that happened to start with another registered prefix would
    // route to the wrong store. The registry's own `noPrefixIsAmbiguous` proves
    // the PREFIXES are disjoint; this proves a minted token's RANDOM part cannot
    // reintroduce the ambiguity by accident.
    for (const kind of TOKEN_KINDS) {
      const token = minter.mint(kind);
      const matches = TOKEN_KINDS.filter((other) => token.startsWith(prefixOf(other)));
      expect(matches, `${kind} matched ${matches.join(", ")}`).toEqual([kind]);
    }
  });
});

describe("the random part is the width the table declares", () => {
  it("decodes to exactly the declared number of bytes, for every kind", () => {
    for (const kind of TOKEN_KINDS) {
      const bytes = Buffer.from(randomPart(kind), "base64url");
      expect(bytes, kind).toHaveLength(MINTED_TOKEN_BYTES[kind]);
    }
  });

  it("emits the character length base64url gives each width", () => {
    // 32 bytes -> 43 characters, 16 -> 22, 48 -> 64. Unpadded base64url is
    // `ceil(bytes * 4 / 3)`, and these three literals come from that arithmetic
    // rather than from `MINTED_TOKEN_BYTES`.
    expect(randomPart("operatorSession")).toHaveLength(43);
    expect(randomPart("oauthClientId")).toHaveLength(22);
    expect(randomPart("entityBearerToken")).toHaveLength(64);
  });

  it("emits base64url and never base64, so a token is URL- and cookie-safe", () => {
    // `+`, `/` and `=` are the three characters base64 has and base64url does
    // not. An operator session token travels in a `Set-Cookie` value and an
    // access token in an `Authorization` header; either would survive `+` and
    // neither survives it reliably through every proxy and form encoder.
    for (const kind of TOKEN_KINDS) {
      expect(randomPart(kind), kind).toMatch(BASE64URL);
    }
  });
});

describe("the randomness is randomness", () => {
  it("never repeats a token across a thousand mints", () => {
    const minted = new Set(Array.from({ length: 1000 }, () => minter.mint("operatorSession")));
    expect(minted.size).toBe(1000);
  });

  it("never repeats a TOTP secret across a thousand mints", () => {
    const minted = new Set(Array.from({ length: 1000 }, () => minter.mintTotpSecret()));
    expect(minted.size).toBe(1000);
  });

  it("never repeats a recovery code across a thousand mints", () => {
    const minted = new Set(minter.mintRecoveryCodes(1000));
    expect(minted.size).toBe(1000);
  });
});

describe("the TOTP secret is what an authenticator application reads", () => {
  it("is thirty-two upper-case base32 characters with no padding", () => {
    expect(minter.mintTotpSecret()).toMatch(/^[A-Z2-7]{32}$/u);
  });

  it("decodes to the twenty bytes RFC 4226 §4 R6 asks for", () => {
    expect(decodeBase32(minter.mintTotpSecret())).toHaveLength(20);
  });

  it("uses every character of the alphabet across enough secrets to see them", () => {
    // A SECRET THAT NEVER PRODUCED A `7` WOULD MEAN THE ALPHABET WAS TRUNCATED,
    // and every other case here would still pass: a 31-character alphabet
    // encodes, decodes and round-trips perfectly and simply loses entropy. Two
    // hundred secrets is 6400 characters over 32 symbols, so a missing one is
    // not chance.
    const seen = new Set(Array.from({ length: 200 }, () => minter.mintTotpSecret()).join(""));
    expect(seen.size).toBe(32);
  });
});

describe("recovery codes are the display form the extraction source shows", () => {
  it("emits four groups of five upper-case hexadecimal characters", () => {
    for (const code of minter.mintRecoveryCodes(9)) {
      expect(code).toMatch(/^[0-9A-F]{5}-[0-9A-F]{5}-[0-9A-F]{5}-[0-9A-F]{5}$/u);
    }
  });

  it("normalises to the twenty hexadecimal characters ten bytes produce", () => {
    // `normalizeRecoveryCode` is the domain's, and it is what the STORED verifier
    // is computed over. Its output length is the property that has to hold: the
    // grouping is cosmetic and can change, twenty hex characters cannot.
    for (const code of minter.mintRecoveryCodes(9)) {
      expect(code.replace(/[^0-9A-F]/gu, "")).toHaveLength(20);
    }
  });

  it("emits as many as it was asked for", () => {
    expect(minter.mintRecoveryCodes(9)).toHaveLength(9);
    expect(minter.mintRecoveryCodes(1)).toHaveLength(1);
  });

  it("hands back a frozen array, so a caller cannot lengthen the batch it showed", () => {
    expect(Object.isFrozen(minter.mintRecoveryCodes(9))).toBe(true);
  });
});

describe("a count that is not a count is refused rather than rounded", () => {
  it("refuses zero", () => {
    expect(() => minter.mintRecoveryCodes(0)).toThrow(RecoveryCodeCountError);
  });

  it("refuses a negative count, which Array.from would silently make empty", () => {
    expect(() => minter.mintRecoveryCodes(-1)).toThrow(RecoveryCodeCountError);
  });

  it("refuses a fraction, which Array.from would silently truncate", () => {
    expect(() => minter.mintRecoveryCodes(2.5)).toThrow(RecoveryCodeCountError);
  });

  it("refuses NaN", () => {
    expect(() => minter.mintRecoveryCodes(Number.NaN)).toThrow(RecoveryCodeCountError);
  });

  it("refuses a count past the safe integer range", () => {
    expect(() => minter.mintRecoveryCodes(2 ** 53)).toThrow(RecoveryCodeCountError);
  });
});
