import { describe, expect, it } from "vitest";
import { moneyToCentsString, zero } from "@platos/kernel";

import {
  centsToMoney,
  chargeableSpend,
  completedTasks,
  foldBuckets,
  hasCrossed,
  isAtLimit,
  limitToMoney,
  runsCrossed,
  settledSpend,
  spendFromCentsString,
  spendToCentsString,
  utilisationBasisPoints,
  utilisationPercent,
} from "./spend.js";

function micro(cents: number): bigint {
  const amount = centsToMoney(cents);
  if (!amount.ok) throw new Error(`unreachable: ${amount.error.code}`);
  return amount.value.microCents;
}

describe("a cent figure becomes an exact amount", () => {
  it("goes through the number's own decimal form, not through arithmetic", () => {
    // Scaling by 1e6 is not reliable. `8.29 * 1e6` is 8289999.999999999, so
    // truncating the product loses a micro-cent, and rounding it would only ever
    // be right by luck. Reading the decimal form the number prints is exact by
    // construction, for every value, with no rounding step.
    expect(Number.isInteger(8.29 * 1e6)).toBe(false);
    expect(Math.trunc(8.29 * 1e6)).toBe(8_289_999);
    expect(micro(8.29)).toBe(8_290_000n);

    expect(micro(0.6861)).toBe(686_100n);
    expect(micro(25.7)).toBe(25_700_000n);
    expect(micro(2.47)).toBe(2_470_000n);
  });

  it("rounds half-up onto the micro-cent grid rather than rejecting a finer value", () => {
    expect(micro(0.0000005)).toBe(1n);
    expect(micro(0.0000004)).toBe(0n);
    expect(micro(0.0000015)).toBe(2n);
  });

  it("carries a credit as a negative amount", () => {
    expect(micro(-1.5)).toBe(-1_500_000n);
  });

  it("refuses a non-finite figure rather than storing a placeholder", () => {
    for (const value of [Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY]) {
      const denied = centsToMoney(value);
      expect(denied.ok).toBe(false);
      if (denied.ok) throw new Error("unreachable");
      expect(denied.error.code).toBe("COST_SPEND_INVALID");
    }
  });

  it("refuses a figure past the Decimal(18, 6) domain rather than throwing", () => {
    // The kernel's `money` raises a RangeError past the ceiling. A domain
    // function that returns a Result must not also throw: a caller reading the
    // type would not know to catch, and this one sits on the hot path.
    expect(() => centsToMoney(1e13)).not.toThrow();
    expect(centsToMoney(1e13).ok).toBe(false);
  });

  it("round-trips through the canonical decimal string form", () => {
    for (const value of ["0.686100", "25.700000", "1234.000001"]) {
      const parsed = spendFromCentsString(value);
      if (!parsed.ok) throw new Error("unreachable");
      expect(spendToCentsString(parsed.value)).toBe(value);
    }
  });

  it("refuses a string that is not a canonical cent amount", () => {
    for (const value of ["", "abc", "1.2.3", "1,5", "0.0000001"]) {
      expect(spendFromCentsString(value).ok).toBe(false);
    }
  });
});

describe("the cache-aware preference", () => {
  it("reads the cache-aware figure when both are present", () => {
    // The measured failure: 25.70c cache-aware against 2.47c naive, on one
    // production day. A cap enforced on the naive number cannot trip.
    const amount = settledSpend({ costCents: 2.47, costWithCacheCents: 25.7 });
    if (!amount.ok) throw new Error("unreachable");
    expect(moneyToCentsString(amount.value)).toBe("25.700000");
  });

  it("falls back to the naive figure ONLY when the cache-aware one is absent", () => {
    for (const absent of [undefined, null, ""]) {
      const amount = settledSpend({ costCents: 2.47, costWithCacheCents: absent });
      if (!amount.ok) throw new Error("unreachable");
      expect(moneyToCentsString(amount.value)).toBe("2.470000");
    }
  });

  it("treats a cache-aware ZERO as genuinely zero and does not fall back", () => {
    // A real turn recorded cost_cents 0 against cost_with_cache 0.6861; falling
    // back on a falsy test resurrects the wrong number in the other direction.
    const amount = settledSpend({ costCents: 9.99, costWithCacheCents: 0 });
    if (!amount.ok) throw new Error("unreachable");
    expect(amount.value.microCents).toBe(0n);
  });

  it("reads a string-valued counter the same as a numeric one", () => {
    const fromString = settledSpend({ costWithCacheCents: "0.6861" });
    const fromNumber = settledSpend({ costWithCacheCents: 0.6861 });
    if (!fromString.ok || !fromNumber.ok) throw new Error("unreachable");
    expect(fromString.value.microCents).toBe(fromNumber.value.microCents);
  });

  it("treats an unparseable counter as zero rather than as NaN", () => {
    const amount = settledSpend({ costWithCacheCents: "not-a-number" });
    if (!amount.ok) throw new Error("unreachable");
    expect(amount.value.microCents).toBe(0n);
  });
});

describe("counting completed turns", () => {
  it("prefers the turn counter and falls back to its pre-rename spelling", () => {
    expect(completedTasks({ tasks: 3, legacyTasks: 99 })).toBe(3);
    expect(completedTasks({ legacyTasks: 7 })).toBe(7);
    expect(completedTasks({})).toBe(0);
  });

  it("truncates rather than rounding, so a partial turn is not a turn", () => {
    expect(completedTasks({ tasks: 2.9 })).toBe(2);
  });
});

describe("folding a window", () => {
  it("sums settled buckets exactly, in bigint", () => {
    const folded = foldBuckets(
      [{ costWithCacheCents: 0.1 }, { costWithCacheCents: 0.2 }, { costWithCacheCents: 0.3 }],
      [],
    );
    if (!folded.ok) throw new Error("unreachable");
    // 0.1 + 0.2 + 0.3 is 0.6000000000000001 as floats. Exactly 0.6 here, and
    // the order of the buckets cannot change the total.
    expect(moneyToCentsString(folded.value.settled)).toBe("0.600000");
  });

  it("adds the turn counts across the window", () => {
    const folded = foldBuckets([{ tasks: 2 }, { tasks: 5 }], []);
    if (!folded.ok) throw new Error("unreachable");
    expect(folded.value.tasks).toBe(7);
  });

  it("clamps a negative reservation PER BUCKET, not on the total", () => {
    // An over-settlement defect can drive one bucket negative. Letting it cancel
    // a sibling bucket's real reservation would hide live spend from the cap.
    const folded = foldBuckets([], [{ costWithCacheCents: -5 }, { costWithCacheCents: 3 }]);
    if (!folded.ok) throw new Error("unreachable");
    expect(moneyToCentsString(folded.value.reserved)).toBe("3.000000");
  });

  it("does NOT clamp the settled side, because a credit belongs in the total", () => {
    const folded = foldBuckets([{ costWithCacheCents: 10 }, { costWithCacheCents: -4 }], []);
    if (!folded.ok) throw new Error("unreachable");
    expect(moneyToCentsString(folded.value.settled)).toBe("6.000000");
  });

  it("adds settled and reserved for the figure a cap is compared against", () => {
    const folded = foldBuckets([{ costWithCacheCents: 40 }], [{ costWithCacheCents: 15 }]);
    if (!folded.ok) throw new Error("unreachable");
    expect(moneyToCentsString(chargeableSpend(folded.value))).toBe("55.000000");
  });
});

describe("utilisation", () => {
  it("is exact basis points, not a rounded float", () => {
    expect(utilisationBasisPoints(limitToMoney(50), 100)).toBe(5_000);
    expect(utilisationPercent(limitToMoney(50), 100)).toBe(50);
  });

  it("rounds half-up at the basis point", () => {
    // 49.995% is 4999.5 basis points.
    const spent = centsToMoney(49.995);
    if (!spent.ok) throw new Error("unreachable");
    expect(utilisationBasisPoints(spent.value, 100)).toBe(5_000);
  });

  it("is zero for an uncapped dimension rather than a division by zero", () => {
    expect(utilisationBasisPoints(limitToMoney(500), 0)).toBe(0);
    expect(Number.isFinite(utilisationBasisPoints(limitToMoney(500), -1))).toBe(true);
  });

  it("carries a credit as a negative figure", () => {
    const credit = centsToMoney(-25);
    if (!credit.ok) throw new Error("unreachable");
    expect(utilisationBasisPoints(credit.value, 100)).toBe(-2_500);
  });
});

describe("crossing a threshold", () => {
  it("crosses at the line and not before it", () => {
    expect(hasCrossed(limitToMoney(49), 100, 50)).toBe(false);
    expect(hasCrossed(limitToMoney(50), 100, 50)).toBe(true);
    expect(hasCrossed(limitToMoney(51), 100, 50)).toBe(true);
  });

  it("does NOT cross on a value that merely ROUNDS to the line", () => {
    // 49.996% of the cap. The source compares a figure it has already rounded to
    // two decimals, so this crossed the 50% line — an alert about a fact that had
    // not happened, and because the crossing is durable and unique the correct
    // one could then never be sent.
    const spent = centsToMoney(49.996);
    if (!spent.ok) throw new Error("unreachable");
    expect(utilisationBasisPoints(spent.value, 100)).toBe(5_000);
    expect(hasCrossed(spent.value, 100, 50)).toBe(false);
  });

  it("never crosses an uncapped dimension", () => {
    expect(hasCrossed(limitToMoney(1_000), 0, 1)).toBe(false);
    expect(runsCrossed(1_000, 0, 1)).toBe(false);
  });

  it("crosses a run threshold on the same at-or-past rule", () => {
    expect(runsCrossed(7, 10, 80)).toBe(false);
    expect(runsCrossed(8, 10, 80)).toBe(true);
  });

  it("reaches the hard stop at the cap, not above it", () => {
    expect(isAtLimit(limitToMoney(999), 1_000)).toBe(false);
    expect(isAtLimit(limitToMoney(1_000), 1_000)).toBe(true);
    expect(isAtLimit(zero(), 0)).toBe(false);
  });
});
