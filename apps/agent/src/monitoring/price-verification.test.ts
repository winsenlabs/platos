import { describe, it, expect } from "vitest";
import {
  reconcileReadings,
  assessReading,
  catalogDiscrepancy,
} from "./price-verification";

/**
 * The policy under test is FAIL CLOSED. These cases mostly assert that we
 * REFUSE to write a price, because the failure mode that matters is silently
 * accepting a bad reading — that is indistinguishable from the stale-catalog
 * bug this whole mechanism exists to fix.
 */

const LUNA = { input: 2e-7, output: 1.2e-6, cacheRead: 2e-8, cacheWrite: 5e-7 };

describe("reconcileReadings — two independent reads must agree", () => {
  it("accepts fields both reads agree on", () => {
    const { agreed, disagreements } = reconcileReadings(LUNA, { ...LUNA });
    expect(agreed).toEqual(LUNA);
    expect(disagreements).toHaveLength(0);
  });

  it("drops a field the two reads disagree on, keeping the rest", () => {
    const { agreed, disagreements } = reconcileReadings(LUNA, { ...LUNA, cacheRead: 9e-8 });
    expect(agreed!.input).toBe(LUNA.input);
    expect(agreed!.cacheRead).toBeUndefined(); // contested → dropped
    expect(disagreements.join()).toContain("cacheRead");
  });

  it("drops a field only ONE read produced — corroboration, not union", () => {
    // The tempting bug: treat a single reading as better than nothing. It is
    // not; an uncorroborated number is exactly what we are trying to avoid.
    const { agreed, disagreements } = reconcileReadings(
      { input: 2e-7, cacheWrite: 5e-7 },
      { input: 2e-7 },
    );
    expect(agreed!.cacheWrite).toBeUndefined();
    expect(disagreements.join()).toContain("only one reading");
  });

  it("returns nothing when a read is missing entirely", () => {
    expect(reconcileReadings(LUNA, null).agreed).toBeNull();
    expect(reconcileReadings(null, LUNA).agreed).toBeNull();
  });
});

describe("assessReading — envelopes and moves", () => {
  it("accepts a corroborated first reading when nothing is trusted yet", () => {
    const v = assessReading("gpt-5.6-luna", LUNA, undefined, undefined);
    expect(v.status).toBe("accepted");
  });

  it("accepts cache-write ABOVE input — that is real, not a misread", () => {
    // gpt-5.6-luna genuinely bills cache writes at 2.5x fresh input. An
    // envelope that assumed writes are always cheaper would reject the truth.
    const v = assessReading("gpt-5.6-luna", LUNA, undefined, undefined);
    expect(v.status).toBe("accepted");
    expect(LUNA.cacheWrite / LUNA.input).toBeCloseTo(2.5, 5);
  });

  it("holds a reading that picked up the wrong column", () => {
    // Batch column: cache read at ~0.0001x input is not a real standard price.
    const v = assessReading("x", { input: 2e-7, cacheRead: 2e-11 }, undefined, undefined);
    expect(v.status).toBe("held");
    expect(v.reason).toContain("cache-read");
  });

  it("holds an implausible output ratio", () => {
    const v = assessReading("x", { input: 2e-7, output: 1e-4 }, undefined, undefined);
    expect(v.status).toBe("held");
    expect(v.reason).toContain("output");
  });

  it("HOLDS the 5x luna-style jump rather than applying it", () => {
    // The exact shape of the LiteLLM error, arriving as a reading. Even though
    // a 5x move might be a genuine price change, it is not applied unreviewed.
    const trusted = { input: 2e-7 };
    const v = assessReading("gpt-5.6-luna", { input: 1e-6 }, trusted, undefined);
    expect(v.status).toBe("held");
    expect(v.moveFactor).toBeCloseTo(5, 5);
  });

  it("holds a large DROP too, not just a rise", () => {
    const v = assessReading("x", { input: 2e-8 }, { input: 2e-7 }, undefined);
    expect(v.status).toBe("held");
  });

  it("applies a modest, believable price change", () => {
    const v = assessReading("x", { input: 2.4e-7 }, { input: 2e-7 }, undefined);
    expect(v.status).toBe("accepted");
  });

  it("reports unchanged when it matches what we already trust", () => {
    const v = assessReading("gpt-5.6-luna", LUNA, LUNA, undefined);
    expect(v.status).toBe("unchanged");
  });

  it("refuses a reading with no input price", () => {
    expect(assessReading("x", { output: 1e-6 }, undefined, undefined).status).toBe("no-reading");
    expect(assessReading("x", { input: 0 }, undefined, undefined).status).toBe("no-reading");
  });

  it("surfaces WHY when the two reads failed to corroborate", () => {
    const v = assessReading("x", null, undefined, undefined, ["input: 1 vs 2"]);
    expect(v.status).toBe("no-reading");
    expect(v.reason).toContain("did not corroborate");
  });
});

describe("catalogDiscrepancy — make the gap visible", () => {
  it("reports the luna case the catalog got wrong", () => {
    const catalog = { input: 1e-6, output: 6e-6, cacheRead: 1e-7, cacheWrite: 1.25e-6 };
    const d = catalogDiscrepancy(LUNA, catalog);
    const byField = Object.fromEntries(d.map((x) => [x.field, x.factor]));
    expect(byField.input).toBeCloseTo(5, 3);
    expect(byField.output).toBeCloseTo(5, 3);
    expect(byField.cacheRead).toBeCloseTo(5, 3);
    expect(byField.cacheWrite).toBeCloseTo(2.5, 3);
  });

  it("stays silent when the catalog agrees (the gpt-5.6-sol case)", () => {
    const sol = { input: 5e-6, output: 3e-5, cacheRead: 5e-7 };
    expect(catalogDiscrepancy(sol, { ...sol })).toHaveLength(0);
  });

  it("tolerates trivial float noise rather than crying wolf daily", () => {
    expect(catalogDiscrepancy({ input: 2e-7 }, { input: 2.001e-7 })).toHaveLength(0);
  });
});
