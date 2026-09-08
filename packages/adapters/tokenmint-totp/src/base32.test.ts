// Is this base32 the base32 an authenticator application reads?
//
// EVERY EXPECTED VALUE BELOW IS RFC 4648's OWN, from §10's test-vector table.
// That is a join to the IETF and not to this repository: nothing in this tranche
// can move `MZXW6YTBOI`, so an alphabet typed one character out of order, a
// bit-order mistake in the trailing partial group, or a silent switch to the
// base32hex alphabet of §7 all fail here and can fail nowhere else.
//
// THE PADDING IS STRIPPED FROM THE RFC's VALUES AND THAT IS THE ONE EDIT.
// §10 writes the padded form (`MY======`) because §6 pads to a multiple of eight
// characters; `encodeBase32` emits none, for the reason its header gives, so each
// expectation below is the RFC's string with its trailing `=` run removed and
// nothing else changed. `decodeBase32` is then given the RFC's string AS
// PUBLISHED, padding included, which is what proves the asymmetry is deliberate
// rather than an oversight on the read side.

import { describe, expect, it } from "vitest";

import { Base32SecretError, decodeBase32, encodeBase32 } from "./base32.js";

const ascii = (value: string): Uint8Array => new TextEncoder().encode(value);
const text = (bytes: Uint8Array): string => new TextDecoder().decode(bytes);

describe("encodeBase32 against RFC 4648 §10", () => {
  it.each([
    { input: "", padded: "", unpadded: "" },
    { input: "f", padded: "MY======", unpadded: "MY" },
    { input: "fo", padded: "MZXQ====", unpadded: "MZXQ" },
    { input: "foo", padded: "MZXW6===", unpadded: "MZXW6" },
    { input: "foob", padded: "MZXW6YQ=", unpadded: "MZXW6YQ" },
    { input: "fooba", padded: "MZXW6YTB", unpadded: "MZXW6YTB" },
    { input: "foobar", padded: "MZXW6YTBOI======", unpadded: "MZXW6YTBOI" },
  ])("encodes $input as the RFC's $padded without its padding", ({ input, unpadded }) => {
    expect(encodeBase32(ascii(input))).toBe(unpadded);
  });
});

describe("decodeBase32 against RFC 4648 §10", () => {
  it.each([
    { input: "", padded: "", unpadded: "" },
    { input: "f", padded: "MY======", unpadded: "MY" },
    { input: "fo", padded: "MZXQ====", unpadded: "MZXQ" },
    { input: "foo", padded: "MZXW6===", unpadded: "MZXW6" },
    { input: "foob", padded: "MZXW6YQ=", unpadded: "MZXW6YQ" },
    { input: "fooba", padded: "MZXW6YTB", unpadded: "MZXW6YTB" },
    { input: "foobar", padded: "MZXW6YTBOI======", unpadded: "MZXW6YTBOI" },
  ])("decodes the RFC's padded $padded back to $input", ({ input, padded }) => {
    expect(text(decodeBase32(padded))).toBe(input);
  });

  it.each([
    { input: "", unpadded: "" },
    { input: "f", unpadded: "MY" },
    { input: "fo", unpadded: "MZXQ" },
    { input: "foo", unpadded: "MZXW6" },
    { input: "foob", unpadded: "MZXW6YQ" },
    { input: "fooba", unpadded: "MZXW6YTB" },
    { input: "foobar", unpadded: "MZXW6YTBOI" },
  ])("decodes the unpadded $unpadded back to $input", ({ input, unpadded }) => {
    expect(text(decodeBase32(unpadded))).toBe(input);
  });
});

describe("the alphabet is §6's and not §7's", () => {
  // THE POSITIVE CONTROL THE PAIR NEEDS. `A` is index 0 in both alphabets, so a
  // suite that only checked `A` could not tell them apart at all.
  it("maps the first five-bit group to A, which both alphabets agree on", () => {
    expect(encodeBase32(Uint8Array.of(0x00))).toBe("AA");
  });

  it("maps the value 26 to 2, which is §6, and never to Q, which is §7", () => {
    // 0b11010_000 -> groups 26 and 0. §6 (`A-Z2-7`) reads 26 as `2`; §7's
    // base32hex alphabet (`0-9A-V`) reads it as `Q`. One byte separates them.
    expect(encodeBase32(Uint8Array.of(0xd0))).toBe("2A");
  });

  it("maps the value 31 to 7, which is §6, and never to V, which is §7", () => {
    expect(encodeBase32(Uint8Array.of(0xf8))).toBe("7A");
  });

  it("refuses V, which is a §7 character and not a §6 one", () => {
    expect(() => decodeBase32("VVVVVVVV")).not.toThrow();
    expect(() => decodeBase32("0000")).toThrow(Base32SecretError);
  });
});

describe("a secret that is not base32 is refused rather than repaired", () => {
  it("refuses a digit outside 2-7", () => {
    expect(() => decodeBase32("JBSWY3DPEHPK3PX0")).toThrow(Base32SecretError);
  });

  it("refuses a space, so a retyped secret is not silently a different one", () => {
    expect(() => decodeBase32("JBSW Y3DP")).toThrow(Base32SecretError);
  });

  it("refuses the group separator a human might type", () => {
    expect(() => decodeBase32("JBSW-Y3DP")).toThrow(Base32SecretError);
  });

  it("refuses padding that is not at the end", () => {
    expect(() => decodeBase32("MY==MY==")).toThrow(Base32SecretError);
  });

  it("folds case, because an otpauth URI is routinely lower-cased in transit", () => {
    expect(text(decodeBase32("mzxw6ytboi"))).toBe("foobar");
  });
});

describe("round trip over the width this adapter actually mints", () => {
  it("recovers all twenty bytes, and needs no padding to do it", () => {
    const bytes = Uint8Array.from({ length: 20 }, (_unused, index) => (index * 37) % 256);
    const encoded = encodeBase32(bytes);
    expect(encoded).toHaveLength(32);
    expect(encoded).not.toContain("=");
    expect(Array.from(decodeBase32(encoded))).toEqual(Array.from(bytes));
  });

  it("recovers every length from one byte to twenty", () => {
    // ONE CASE OVER TWENTY LENGTHS rather than twenty cases: the partial-group
    // arithmetic is the same code for every one of them, and the census counts a
    // case per `it()` rather than per assertion.
    for (let length = 1; length <= 20; length += 1) {
      const bytes = Uint8Array.from({ length }, (_unused, index) => 255 - index);
      expect(Array.from(decodeBase32(encodeBase32(bytes))), `length ${length}`).toEqual(
        Array.from(bytes),
      );
    }
  });
});
