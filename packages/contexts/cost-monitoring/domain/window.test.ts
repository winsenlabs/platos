import { describe, expect, it } from "vitest";

import { admitPeriod, dayStamp, windowDays, windowKeyFor } from "./window.js";

const NOON = new Date("2026-01-15T12:00:00.000Z");

describe("the daily buckets a period covers", () => {
  it("covers today alone for a daily cap", () => {
    expect(windowDays("day", NOON)).toEqual(["2026-01-15"]);
  });

  it("covers a rolling seven days for a weekly cap, newest first", () => {
    expect(windowDays("week", NOON)).toEqual([
      "2026-01-15",
      "2026-01-14",
      "2026-01-13",
      "2026-01-12",
      "2026-01-11",
      "2026-01-10",
      "2026-01-09",
    ]);
  });

  it("covers the elapsed calendar month for a monthly cap, and never a future day", () => {
    const days = windowDays("month", NOON);
    expect(days).toHaveLength(15);
    expect(days[0]).toBe("2026-01-15");
    expect(days[days.length - 1]).toBe("2026-01-01");
  });

  it("includes the current day at the very start of it", () => {
    // Midnight of today is never AFTER now, so today is always in the window.
    // A comparison that dropped it would leave the first minutes of every month
    // uncounted against a monthly cap.
    expect(windowDays("month", new Date("2026-03-01T00:00:00.000Z"))).toEqual(["2026-03-01"]);
  });

  it("stops at the end of a short month rather than spilling into the next", () => {
    const days = windowDays("month", new Date("2026-02-28T23:59:59.999Z"));
    expect(days).toHaveLength(28);
    expect(days.every((day) => day.startsWith("2026-02"))).toBe(true);
  });

  it("rolls a weekly window across a month boundary", () => {
    expect(windowDays("week", new Date("2026-03-02T06:00:00.000Z"))).toEqual([
      "2026-03-02",
      "2026-03-01",
      "2026-02-28",
      "2026-02-27",
      "2026-02-26",
      "2026-02-25",
      "2026-02-24",
    ]);
  });

  it("uses UTC boundaries, so a late-evening instant is still today", () => {
    expect(dayStamp(new Date("2026-01-15T23:59:59.999Z"))).toBe("2026-01-15");
    expect(dayStamp(new Date("2026-01-16T00:00:00.000Z"))).toBe("2026-01-16");
  });
});

describe("the deduplication key a period mints", () => {
  it("is the day for a daily cap", () => {
    expect(windowKeyFor("day", NOON)).toBe("2026-01-15");
  });

  it("is the calendar month for a monthly cap", () => {
    expect(windowKeyFor("month", NOON)).toBe("2026-01");
    expect(windowKeyFor("month", new Date("2026-09-03T00:00:00.000Z"))).toBe("2026-09");
  });

  it("is the Sunday that opens the calendar week, prefixed", () => {
    // 2026-01-15 is a Thursday; its week opens on Sunday 2026-01-11.
    expect(windowKeyFor("week", NOON)).toBe("W2026-01-11");
  });

  it("holds the weekly key steady across the whole week", () => {
    const keys = windowDays("week", new Date("2026-01-17T12:00:00.000Z")).map((day) =>
      windowKeyFor("week", new Date(`${day}T12:00:00.000Z`)),
    );
    // Sunday 11th through Saturday 17th all key to the 11th; the day before it
    // belongs to the previous week.
    expect(keys.slice(0, 7)).toEqual([
      "W2026-01-11",
      "W2026-01-11",
      "W2026-01-11",
      "W2026-01-11",
      "W2026-01-11",
      "W2026-01-11",
      "W2026-01-11",
    ]);
    expect(windowKeyFor("week", new Date("2026-01-10T12:00:00.000Z"))).toBe("W2026-01-04");
  });

  it("keeps the weekly key distinguishable from a daily one on a Sunday", () => {
    // Without the `W` prefix these would be the same string, and one alert would
    // suppress the other under `@@unique([budgetId, windowKey, threshold])`.
    const sunday = new Date("2026-01-11T09:00:00.000Z");
    expect(windowKeyFor("week", sunday)).not.toBe(windowKeyFor("day", sunday));
  });

  it("is deliberately NOT the same seven days the weekly window covers", () => {
    // The key is a dedup bucket that must stay stable for as long as the answer
    // "already alerted" should stay yes; the window is a rolling measurement.
    // Reconciling them would break one of the two.
    const at = new Date("2026-01-15T12:00:00.000Z");
    expect(windowDays("week", at)).toContain("2026-01-09");
    expect(windowKeyFor("week", at)).toBe("W2026-01-11");
  });
});

describe("admitting a period", () => {
  it("accepts the three the store holds", () => {
    for (const period of ["day", "week", "month"]) {
      expect(admitPeriod(period).ok).toBe(true);
    }
  });

  it("refuses anything else, as a value rather than a throw", () => {
    const denied = admitPeriod("fortnight");
    expect(denied.ok).toBe(false);
    if (denied.ok) throw new Error("unreachable");
    expect(denied.error.code).toBe("COST_WINDOW_INVALID");
    expect(denied.error.details["period"]).toBe("fortnight");
  });
});
