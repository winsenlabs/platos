// Budget periods, and the two DIFFERENT things a period produces.
//
// A period produces a WINDOW — the set of daily buckets whose spend counts —
// and a KEY — the deduplication label a threshold event is unique within. The
// source computes them in two adjacent private methods, and for `week` THE TWO
// DO NOT DESCRIBE THE SAME SEVEN DAYS:
//
//   `windowDates("week")` returns today and the six days before it — a ROLLING
//   window that moves every midnight.
//   `windowKey("week")`   returns `W<Sunday of the current calendar week>` — a
//   FIXED label that changes once a week.
//
// That is transcribed exactly rather than reconciled, and it is not a bug. The
// key's job is to answer "have we already alerted about this?", and it must be
// STABLE for as long as the answer should stay yes. A rolling key would change
// every midnight and re-fire the same 80%-of-weekly-budget alert seven times.
// The window's job is to answer "how much has been spent lately?", and a rolling
// answer is the useful one. Making them agree would break one of the two.
//
// The monthly pair does agree: a calendar month for both, so an override lines
// up with a billing expectation.
//
// EVERY FUNCTION HERE TAKES `at`. Nothing reads the wall clock, which is what
// makes "the window rolls over at midnight UTC" a test rather than a belief.
// Every boundary is UTC, matching the store: a local-time boundary would move an
// installation's budget windows when a server changed region.

import { err, ok, type Result } from "@platos/kernel";

import { windowInvalid } from "./errors.js";
import { asCostIdentifier, type WindowKey } from "./identifiers.js";

/** The three periods a cap can be written against. */
export const BUDGET_PERIODS = ["day", "week", "month"] as const;

export type BudgetPeriod = (typeof BUDGET_PERIODS)[number];

export function isBudgetPeriod(value: string): value is BudgetPeriod {
  return (BUDGET_PERIODS as readonly string[]).includes(value);
}

export function admitPeriod(value: string): Result<BudgetPeriod> {
  if (!isBudgetPeriod(value)) {
    return err(windowInvalid(`invalid period: ${value}`, { period: value }));
  }
  return ok(value);
}

/** One daily bucket, `YYYY-MM-DD` in UTC. The unit both counters are keyed by. */
export type DayStamp = string;

const MILLISECONDS_PER_DAY = 86_400_000;

/** `YYYY-MM-DD` of an instant, in UTC. */
export function dayStamp(at: Date): DayStamp {
  return at.toISOString().slice(0, 10);
}

/**
 * The daily buckets whose spend counts toward a cap at `at`.
 *
 * Newest first, which is the order the source builds and the order a partial
 * read degrades best in: a truncated read loses the OLDEST days, understating
 * spend by the least.
 */
export function windowDays(period: BudgetPeriod, at: Date): readonly DayStamp[] {
  if (period === "day") return [dayStamp(at)];
  if (period === "week") {
    const days: DayStamp[] = [];
    for (let back = 0; back < 7; back += 1) {
      days.push(dayStamp(new Date(at.getTime() - back * MILLISECONDS_PER_DAY)));
    }
    return days;
  }
  return monthDays(at);
}

/**
 * Every elapsed day of the calendar month containing `at`, newest first.
 *
 * The source walks day 1 upward and stops at the first day past `at`. That loop
 * has one property worth keeping deliberately rather than by accident: it
 * compares MIDNIGHT of each candidate day against the exact instant `at`, so the
 * current day is always included — midnight today is never after now.
 */
function monthDays(at: Date): readonly DayStamp[] {
  const year = at.getUTCFullYear();
  const month = at.getUTCMonth();
  const days: DayStamp[] = [];
  for (let day = 1; day <= 31; day += 1) {
    const candidate = new Date(Date.UTC(year, month, day));
    if (candidate.getUTCMonth() !== month) break;
    if (candidate.getTime() > at.getTime()) break;
    days.push(dayStamp(candidate));
  }
  return days.reverse();
}

/**
 * The deduplication label for a period at an instant.
 *
 *   day    `2026-09-03`
 *   week   `W2026-08-30`  — the Sunday that opens the calendar week
 *   month  `2026-09`
 *
 * The `W` prefix is load-bearing. Without it a weekly key and a daily key would
 * be the same string on any Sunday, and `@@unique([budgetId, windowKey,
 * threshold])` would let a weekly alert suppress that Sunday's daily one.
 */
export function windowKeyFor(period: BudgetPeriod, at: Date): WindowKey {
  if (period === "day") return asCostIdentifier<WindowKey>(dayStamp(at));
  if (period === "week") {
    const sunday = new Date(at.getTime() - at.getUTCDay() * MILLISECONDS_PER_DAY);
    return asCostIdentifier<WindowKey>(`W${dayStamp(sunday)}`);
  }
  const month = String(at.getUTCMonth() + 1).padStart(2, "0");
  return asCostIdentifier<WindowKey>(`${at.getUTCFullYear()}-${month}`);
}
