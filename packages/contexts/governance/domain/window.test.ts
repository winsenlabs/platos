import { describe, expect, it } from "vitest";

import { admitPage, clampDays, windowFrom } from "./window.js";

// Bounds are written as LITERALS here, never read from DEFAULT_GOVERNANCE_POLICY.
// A cap test whose input is derived from the constant it tests stays green when
// the constant moves, which is exactly the vacuity this suite must not have.
const BOUNDS = { minWindowDays: 1, defaultWindowDays: 30, maxWindowDays: 365 } as const;
const PAGE = { maxPageSize: 200, defaultPageSize: 50 } as const;
const NOON = new Date("2026-03-01T12:00:00.000Z");
const DAY = 86_400_000;

describe("clampDays", () => {
  it("takes the default when nothing was asked for", () => {
    expect(clampDays(null, BOUNDS)).toBe(30);
    expect(clampDays(undefined, BOUNDS)).toBe(30);
  });

  it("passes an in-range request through unchanged", () => {
    expect(clampDays(7, BOUNDS)).toBe(7);
  });

  it("clamps UP to the floor, exactly", () => {
    expect(clampDays(0, BOUNDS)).toBe(1);
    expect(clampDays(-9_000, BOUNDS)).toBe(1);
  });

  it("clamps DOWN to the ceiling, exactly", () => {
    expect(clampDays(10_000, BOUNDS)).toBe(365);
  });

  it("holds at both boundaries rather than one either side of them", () => {
    expect(clampDays(1, BOUNDS)).toBe(1);
    expect(clampDays(365, BOUNDS)).toBe(365);
    expect(clampDays(366, BOUNDS)).toBe(365);
  });

  it("floors a fraction rather than carrying it into a date", () => {
    expect(clampDays(7.9, BOUNDS)).toBe(7);
  });

  it("answers the DEFAULT for NaN — the source's own clamp answers NaN", () => {
    // `Math.min(NaN, 365)` is NaN, `new Date(NaN)` is an Invalid Date, and every
    // comparison against it is false: a window that silently matches nothing.
    expect(clampDays(Number.NaN, BOUNDS)).toBe(30);
    expect(clampDays(Number.POSITIVE_INFINITY, BOUNDS)).toBe(30);
  });

  it("respects a DIFFERENT set of bounds, so the numbers are not baked in", () => {
    expect(clampDays(99, { minWindowDays: 2, defaultWindowDays: 3, maxWindowDays: 4 })).toBe(4);
    expect(clampDays(1, { minWindowDays: 2, defaultWindowDays: 3, maxWindowDays: 4 })).toBe(2);
  });
});

describe("windowFrom", () => {
  it("measures back from the supplied instant, to the millisecond", () => {
    const window = windowFrom(NOON, 7, BOUNDS);
    expect(window.days).toBe(7);
    expect(window.since.toISOString()).toBe("2026-02-22T12:00:00.000Z");
    expect(NOON.getTime() - window.since.getTime()).toBe(7 * DAY);
  });

  it("does not report a clamp when the request survived", () => {
    expect(windowFrom(NOON, 7, BOUNDS).clamped).toBe(false);
  });

  it("reports a clamp when it did not", () => {
    expect(windowFrom(NOON, 10_000, BOUNDS).clamped).toBe(true);
  });

  it("does not call the default a clamp — nothing was asked for", () => {
    expect(windowFrom(NOON, null, BOUNDS).clamped).toBe(false);
  });
});

describe("admitPage", () => {
  it("takes the default width when none was asked for", () => {
    const page = admitPage({}, PAGE);
    expect(page.ok && page.value.limit).toBe(50);
    expect(page.ok && page.value.offset).toBe(0);
  });

  it("passes an in-range width through", () => {
    const page = admitPage({ limit: 25, offset: 10 }, PAGE);
    expect(page.ok && page.value).toEqual({ limit: 25, offset: 10, clamped: false });
  });

  it("clamps a too-wide page to EXACTLY the ceiling and says so", () => {
    const page = admitPage({ limit: 10_000 }, PAGE);
    expect(page.ok && page.value.limit).toBe(200);
    expect(page.ok && page.value.clamped).toBe(true);
  });

  it("leaves the ceiling itself alone and cuts the next one down", () => {
    expect(admitPage({ limit: 200 }, PAGE)).toEqual({ ok: true, value: { limit: 200, offset: 0, clamped: false } });
    expect(admitPage({ limit: 201 }, PAGE)).toEqual({ ok: true, value: { limit: 200, offset: 0, clamped: true } });
  });

  it("clamps against the bounds it is GIVEN, not against a module constant", () => {
    const narrow = admitPage({ limit: 10 }, { maxPageSize: 3, defaultPageSize: 2 });
    expect(narrow.ok && narrow.value.limit).toBe(3);
  });

  it("REFUSES a negative offset rather than clamping it to page one", () => {
    const page = admitPage({ offset: -3 }, PAGE);
    expect(page.ok).toBe(false);
    expect(!page.ok && page.error.code).toBe("GOVERNANCE_PAGE_REQUEST_INVALID");
    expect(!page.ok && page.error.fields[0]?.field).toBe("offset");
  });

  it("REFUSES a fractional offset — a half-row is not a position", () => {
    expect(admitPage({ offset: 1.5 }, PAGE).ok).toBe(false);
  });

  it("REFUSES a zero or negative limit rather than serving the default", () => {
    const zero = admitPage({ limit: 0 }, PAGE);
    expect(zero.ok).toBe(false);
    expect(!zero.ok && zero.error.fields[0]?.code).toBe("not_positive");
    expect(admitPage({ limit: -5 }, PAGE).ok).toBe(false);
  });

  it("REFUSES a non-finite limit", () => {
    expect(admitPage({ limit: Number.NaN }, PAGE).ok).toBe(false);
    expect(admitPage({ offset: Number.POSITIVE_INFINITY }, PAGE).ok).toBe(false);
  });

  it("tells the two refusals apart by field, so both are separately provable", () => {
    const badOffset = admitPage({ offset: -1 }, PAGE);
    const badLimit = admitPage({ limit: 0 }, PAGE);
    expect(!badOffset.ok && badOffset.error.fields[0]?.code).toBe("negative");
    expect(!badLimit.ok && badLimit.error.fields[0]?.code).toBe("not_positive");
  });
});
