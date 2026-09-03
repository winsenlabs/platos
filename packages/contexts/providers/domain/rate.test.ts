import { describe, expect, it } from "vitest";

import {
  isZeroRate,
  rateFromDecimalString,
  rateFromNumber,
  rateToDecimalString,
  sameRate,
  tokenRate,
  ZERO_RATE,
} from "./rate.js";

function pico(value: string): bigint {
  const parsed = rateFromDecimalString(value);
  if (!parsed.ok) throw new Error(`unreachable: ${parsed.error.code}`);
  return parsed.value.picoUsdPerToken;
}

describe("the pico-USD grid", () => {
  it("reads a canonical Decimal(24, 12) string exactly", () => {
    expect(pico("0.000000200000")).toBe(200_000n);
    expect(pico("1.000000000000")).toBe(1_000_000_000_000n);
    expect(pico("0.000000000001")).toBe(1n);
  });

  it("reads exponent notation to the same integer as its expanded form", () => {
    expect(pico("2e-7")).toBe(pico("0.0000002"));
    expect(pico("1.2e-6")).toBe(pico("0.0000012"));
    expect(pico("2E-8")).toBe(20_000n);
  });

  it("round-trips through the canonical string form", () => {
    for (const value of ["0.000000200000", "12.500000000000", "0.000000000001"]) {
      const parsed = rateFromDecimalString(value);
      if (!parsed.ok) throw new Error("unreachable");
      expect(rateToDecimalString(parsed.value)).toBe(value);
    }
  });

  it("rounds half-up onto the grid rather than rejecting a finer value", () => {
    // 10^-13 is half of the grid unit: it rounds up to one.
    expect(pico("0.0000000000005")).toBe(1n);
    expect(pico("0.0000000000004")).toBe(0n);
    expect(pico("0.0000000000015")).toBe(2n);
  });
});

describe("a JavaScript number becomes an exact rate", () => {
  it("goes through the number's own decimal form, not through arithmetic", () => {
    // Scaling by 1e12 is not reliable, in EITHER direction. `1e-9 * 1e12` is
    // 1000.0000000000001, and `3e-8 * 1e12` is 29999.999999999996 — so
    // truncating the product loses a whole unit on the second, and rounding it
    // would only ever be right by luck. Reading the decimal form the number
    // prints is exact by construction, for every value, with no rounding step.
    expect(Number.isInteger(1e-9 * 1e12)).toBe(false);
    expect(Math.trunc(3e-8 * 1e12)).toBe(29_999);

    for (const [value, expected] of [
      [1e-9, 1_000n],
      [3e-8, 30_000n],
      [1.2e-7, 120_000n],
      [4.9e-10, 490n],
    ] as const) {
      const exact = rateFromNumber(value);
      if (!exact.ok) throw new Error("unreachable");
      expect(exact.value.picoUsdPerToken).toBe(expected);
    }
  });

  it("agrees with the same value written as a string", () => {
    for (const value of [2e-7, 2e-8, 5e-7, 1.2e-6, 1e-6, 6e-6, 1.25e-6, 3e-5]) {
      const fromNumber = rateFromNumber(value);
      if (!fromNumber.ok) throw new Error("unreachable");
      expect(fromNumber.value.picoUsdPerToken).toBe(pico(value.toString()));
    }
  });

  it("refuses a non-finite value rather than storing a placeholder", () => {
    for (const value of [Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY]) {
      const denied = rateFromNumber(value);
      expect(denied.ok).toBe(false);
      if (denied.ok) throw new Error("unreachable");
      expect(denied.error.code).toBe("PROVIDERS_MODEL_RATE_INVALID");
    }
  });
});

describe("refusals", () => {
  it("refuses a negative rate in either input form", () => {
    expect(rateFromDecimalString("-0.000001").ok).toBe(false);
    expect(rateFromNumber(-1e-6).ok).toBe(false);
    expect(tokenRate(-1n).ok).toBe(false);
  });

  it("refuses a value outside the Decimal(24, 12) domain", () => {
    expect(tokenRate(10n ** 24n).ok).toBe(false);
    expect(tokenRate(10n ** 24n - 1n).ok).toBe(true);
  });

  it("refuses text that is not a number", () => {
    for (const value of ["", "abc", "1.2.3", "1,5", "0x10"]) {
      expect(rateFromDecimalString(value).ok).toBe(false);
    }
  });
});

describe("comparison", () => {
  it("treats two spellings of one price as the same rate", () => {
    const left = rateFromDecimalString("2e-7");
    const right = rateFromDecimalString("0.000000200000");
    if (!left.ok || !right.ok) throw new Error("unreachable");
    expect(sameRate(left.value, right.value)).toBe(true);
  });

  it("knows zero", () => {
    expect(isZeroRate(ZERO_RATE)).toBe(true);
    expect(isZeroRate({ picoUsdPerToken: 1n })).toBe(false);
  });
});
