import { describe, expect, it } from "vitest";

import {
  USD,
  add,
  compare,
  isZero,
  money,
  moneyFromCentsString,
  moneyToCentsString,
  moneyToMajorUnitString,
  subtract,
  sum,
  zero,
} from "./money.js";
import type { CurrencyCode } from "./money.js";

const EUR = "EUR" as CurrencyCode;

describe("Money preserves the canonical store's Decimal(18, 6) exactly", () => {
  it("round-trips a sub-cent step cost that a float would destroy", () => {
    // A real single-step cost. Six decimal places of a cent.
    const parsed = moneyFromCentsString("0.000001");
    expect(parsed.microCents).toBe(1n);
    expect(moneyToCentsString(parsed)).toBe("0.000001");
  });

  it("sums a million sub-cent steps with no drift", () => {
    // The float failure this type exists to prevent: 0.000001 summed 1e6 times
    // is 1 exactly in decimal, and is NOT 1 in binary floating point.
    const step = moneyFromCentsString("0.000001");
    let total = zero();
    for (let index = 0; index < 1_000_000; index += 1) total = add(total, step);
    expect(moneyToCentsString(total)).toBe("1.000000");

    let floatTotal = 0;
    for (let index = 0; index < 1_000_000; index += 1) floatTotal += 0.000001;
    expect(floatTotal).not.toBe(1);
  });

  it("round-trips the full 18-digit domain the column accepts", () => {
    const largest = "999999999999.999999";
    expect(moneyToCentsString(moneyFromCentsString(largest))).toBe(largest);
  });

  it("rejects an amount outside Decimal(18, 6) rather than storing a truncated one", () => {
    expect(() => money(10n ** 18n)).toThrow(/exceeds the Decimal\(18, 6\) domain/u);
    expect(() => money(-(10n ** 18n))).toThrow(/exceeds the Decimal\(18, 6\) domain/u);
  });

  it("rejects a seventh decimal place rather than silently rounding a cost", () => {
    expect(() => moneyFromCentsString("0.0000001")).toThrow(/not a Decimal\(18, 6\) cent amount/u);
  });

  it.each(["", "abc", "1.2.3", "1e5", "--1", " 1..0"])("rejects %o", (input) => {
    expect(() => moneyFromCentsString(input)).toThrow();
  });

  it("accepts surrounding whitespace, because a column read-back may carry it", () => {
    expect(moneyFromCentsString("  12.500000  ").microCents).toBe(12_500_000n);
  });
});

describe("Money arithmetic", () => {
  it("adds, subtracts and sums", () => {
    const a = moneyFromCentsString("1.500000");
    const b = moneyFromCentsString("2.250000");
    expect(moneyToCentsString(add(a, b))).toBe("3.750000");
    expect(moneyToCentsString(subtract(a, b))).toBe("-0.750000");
    expect(moneyToCentsString(sum([a, b, a]))).toBe("5.250000");
  });

  it("represents a credit as a negative amount and renders its sign", () => {
    const credit = moneyFromCentsString("-4.000000");
    expect(credit.microCents).toBeLessThan(0n);
    expect(moneyToCentsString(credit)).toBe("-4.000000");
    expect(moneyToMajorUnitString(credit)).toBe("-0.04000000");
  });

  it("sums an empty ledger to zero rather than throwing", () => {
    expect(isZero(sum([]))).toBe(true);
  });

  it("orders amounts", () => {
    const cheap = moneyFromCentsString("1.000000");
    const dear = moneyFromCentsString("2.000000");
    expect(compare(cheap, dear)).toBe(-1);
    expect(compare(dear, cheap)).toBe(1);
    expect(compare(cheap, cheap)).toBe(0);
  });

  it("refuses to combine two currencies instead of producing a wrong number", () => {
    const dollars = money(100n, USD);
    const euros = money(100n, EUR);
    expect(() => add(dollars, euros)).toThrow(/cannot combine USD with EUR/u);
    expect(() => subtract(dollars, euros)).toThrow();
    expect(() => compare(dollars, euros)).toThrow();
  });
});
