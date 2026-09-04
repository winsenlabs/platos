import { describe, expect, it } from "vitest";

import {
  columnDateTime,
  DECIMAL_MAX,
  decimal12,
  durationMs,
  identityText,
  NIL_UUID,
  nullableDecimal12,
  redacted,
  text,
  tokenCount,
  usdFromCents,
  usdPerMillion,
  uuidOrNil,
  wholeCount,
} from "./column-values.js";

describe("decimal12", () => {
  it("renders fixed-point text with the column's own scale", () => {
    expect(decimal12(1.5)).toBe("1.500000000000");
    expect(decimal12(0)).toBe("0.000000000000");
  });

  it("never uses exponent notation, which the column's parser rejects", () => {
    expect(String(0.0000001)).toContain("e");
    expect(decimal12(0.0000001)).toBe("0.000000100000");
    expect(decimal12(0.0000001)).not.toContain("e");
  });

  it("treats an absent, null or non-finite value as zero rather than throwing", () => {
    expect(decimal12(null)).toBe("0.000000000000");
    expect(decimal12(undefined)).toBe("0.000000000000");
    expect(decimal12(Number.NaN)).toBe("0.000000000000");
    // Infinity is not a magnitude the column can hold, so it is not clamped to
    // the maximum — it is treated as no measurement at all.
    expect(decimal12(Number.POSITIVE_INFINITY)).toBe("0.000000000000");
    expect(decimal12(DECIMAL_MAX)).toBe("999999999999.999877929688");
  });

  it("clamps to a value that still RENDERS in twelve integer digits", () => {
    // The off-by-one that defeats the clamp: 1e12 renders with thirteen.
    expect((1e12).toFixed(12).split(".")[0]).toHaveLength(13);
    expect(decimal12(1e18).split(".")[0]).toHaveLength(12);
    expect(decimal12(-1e18).split(".")[0]).toHaveLength(13); // the sign
    expect(decimal12(-1e18).replace("-", "").split(".")[0]).toHaveLength(12);
  });
});

describe("nullableDecimal12", () => {
  it("keeps an absent value absent rather than making it a confident zero", () => {
    expect(nullableDecimal12(null)).toBeNull();
    expect(nullableDecimal12(undefined)).toBeNull();
    expect(nullableDecimal12(Number.NaN)).toBeNull();
  });

  it("renders a present value exactly as decimal12 does", () => {
    expect(nullableDecimal12(2.25)).toBe("2.250000000000");
  });
});

describe("usdPerMillion and usdFromCents", () => {
  it("scales a per-token rate to a per-million rate", () => {
    expect(usdPerMillion(0.000_003)).toBe("3.000000000000");
  });

  it("reports an unknown rate as zero, not as absent", () => {
    expect(usdPerMillion(null)).toBe("0.000000000000");
  });

  it("converts integer cents to dollars", () => {
    expect(usdFromCents(125)).toBe("1.250000000000");
    expect(usdFromCents(1)).toBe("0.010000000000");
    expect(usdFromCents(null)).toBe("0.000000000000");
  });
});

describe("tokenCount and wholeCount", () => {
  it("floors a float a provider reported", () => {
    expect(tokenCount(10.9)).toBe(10);
  });

  it("refuses a negative quantity", () => {
    expect(tokenCount(-5)).toBe(0);
    expect(wholeCount(-1)).toBe(0);
  });

  it("treats absent and non-finite as zero", () => {
    expect(tokenCount(undefined)).toBe(0);
    expect(tokenCount(Number.NaN)).toBe(0);
    expect(wholeCount(null)).toBe(0);
  });
});

describe("columnDateTime", () => {
  it("renders space-separated UTC with microsecond room and no zone suffix", () => {
    const rendered = columnDateTime(new Date("2026-01-02T03:04:05.678Z"));
    expect(rendered).toBe("2026-01-02 03:04:05.678000");
    expect(rendered).not.toContain("T");
    expect(rendered).not.toContain("Z");
  });

  it("renders the epoch for an absent or invalid instant rather than throwing", () => {
    expect(columnDateTime(null)).toBe("1970-01-01 00:00:00.000000");
    expect(columnDateTime(new Date("not a date"))).toBe("1970-01-01 00:00:00.000000");
  });
});

describe("durationMs", () => {
  it("measures the gap between two instants", () => {
    expect(durationMs(new Date(1_000), new Date(3_500))).toBe(2_500);
  });

  it("never reports a negative duration when the clocks disagree", () => {
    expect(durationMs(new Date(3_500), new Date(1_000))).toBe(0);
  });

  it("reports zero when either instant is missing", () => {
    expect(durationMs(null, new Date(1_000))).toBe(0);
    expect(durationMs(new Date(1_000), undefined)).toBe(0);
  });
});

describe("uuidOrNil", () => {
  it("passes a well-formed uuid through unchanged", () => {
    const uuid = "11111111-1111-4111-8111-111111111111";
    expect(uuidOrNil(uuid)).toBe(uuid);
  });

  it("substitutes the nil uuid for anything the parser would reject", () => {
    expect(uuidOrNil("agent-1")).toBe(NIL_UUID);
    expect(uuidOrNil("")).toBe(NIL_UUID);
    expect(uuidOrNil(null)).toBe(NIL_UUID);
    expect(uuidOrNil("11111111-1111-4111-8111-11111111111")).toBe(NIL_UUID);
  });
});

describe("text and identityText", () => {
  it("renders an absent string column as empty, never null", () => {
    expect(text(null)).toBe("");
    expect(text(undefined)).toBe("");
    expect(text("a")).toBe("a");
  });

  it("collapses a blank identity to null so the residue check asks about identity", () => {
    expect(identityText("   ")).toBeNull();
    expect(identityText("")).toBeNull();
    expect(identityText(null)).toBeNull();
  });

  it("trims a present identity rather than storing its whitespace", () => {
    expect(identityText("  ada@example.test ")).toBe("ada@example.test");
  });
});

describe("redacted", () => {
  it("truncates to the diagnostic limit", () => {
    expect(redacted("x".repeat(900))).toHaveLength(500);
  });

  it("renders a non-string as empty", () => {
    expect(redacted(null)).toBe("");
    expect(redacted(undefined)).toBe("");
  });
});
