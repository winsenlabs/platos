// Time windows and page requests — the two clamps every read in this context
// shares.
//
// THE SOURCE CLAMPS SILENTLY, AND SO DOES THIS, BUT IT SAYS SO. Every listing
// service in the extraction source writes `Math.max(1, Math.min(x ?? d, cap))`
// inline, five times, with three different caps. A caller asking for 10,000 rows
// gets 200 and is told nothing. That behaviour is kept — refusing a too-wide page
// would break every existing surface — but it is one function here, and the
// clamped values are RETURNED rather than applied invisibly, so a transport can
// render "showing 200 of 10,000 requested" if it chooses to.
//
// ONE THING IS REFUSED RATHER THAN CLAMPED. A negative offset is not a caller
// asking for too much; it is a caller whose arithmetic is wrong, and clamping it
// to zero silently serves page one to something that believes it is reading page
// minus-three. It is `GOVERNANCE_PAGE_REQUEST_INVALID`.
//
// A WINDOW IS DERIVED FROM AN INJECTED CLOCK. Nothing here reads the wall clock,
// which is what makes "the last 30 days" a value a test can pin to the
// millisecond instead of a range it has to tolerate.

import { err, ok, type Result } from "@platos/kernel";

import { pageRequestInvalid } from "./errors.js";

const MILLISECONDS_PER_DAY = 86_400_000;

export interface WindowBounds {
  readonly minWindowDays: number;
  readonly defaultWindowDays: number;
  readonly maxWindowDays: number;
}

export interface PageBounds {
  readonly maxPageSize: number;
  readonly defaultPageSize: number;
}

export interface DayWindow {
  /** The clamped day count, after the bounds were applied. */
  readonly days: number;
  /** The instant rows are read from, inclusive. */
  readonly since: Date;
  /** True when the caller's request did not survive the bounds unchanged. */
  readonly clamped: boolean;
}

export interface PageRequest {
  readonly limit: number;
  readonly offset: number;
  /** True when `limit` was cut down to the ceiling. */
  readonly clamped: boolean;
}

/**
 * Clamp a requested day count into the bounds.
 *
 * A non-integer or non-finite request takes the default rather than propagating
 * `NaN` into a date, which is the failure mode the source's
 * `Math.min(options.sinceDays ?? 30, 365)` has: `Math.min(NaN, 365)` is `NaN`,
 * `new Date(NaN)` is an Invalid Date, and every comparison against it is false —
 * a window that silently matches nothing.
 */
export function clampDays(requested: number | null | undefined, bounds: WindowBounds): number {
  if (requested === null || requested === undefined) return bounds.defaultWindowDays;
  if (!Number.isFinite(requested)) return bounds.defaultWindowDays;
  const floored = Math.floor(requested);
  if (floored < bounds.minWindowDays) return bounds.minWindowDays;
  if (floored > bounds.maxWindowDays) return bounds.maxWindowDays;
  return floored;
}

/** The window a read covers, measured back from `now`. */
export function windowFrom(now: Date, requested: number | null | undefined, bounds: WindowBounds): DayWindow {
  const days = clampDays(requested, bounds);
  return {
    days,
    since: new Date(now.getTime() - days * MILLISECONDS_PER_DAY),
    clamped: requested !== null && requested !== undefined && requested !== days,
  };
}

/** Admit a page request, clamping the width and refusing a negative offset. */
export function admitPage(
  requested: { readonly limit?: number | null; readonly offset?: number | null },
  bounds: PageBounds,
): Result<PageRequest> {
  const offset = requested.offset ?? 0;
  if (!Number.isFinite(offset) || !Number.isInteger(offset) || offset < 0) {
    return err(
      pageRequestInvalid("offset must be a whole number of rows, zero or more", [
        { field: "offset", code: "negative", message: "offset must be zero or more" },
      ]),
    );
  }
  const asked = requested.limit;
  if (asked === null || asked === undefined) {
    return ok({ limit: bounds.defaultPageSize, offset, clamped: false });
  }
  if (!Number.isFinite(asked) || !Number.isInteger(asked) || asked < 1) {
    return err(
      pageRequestInvalid("limit must be a whole number of rows, one or more", [
        { field: "limit", code: "not_positive", message: "limit must be one or more" },
      ]),
    );
  }
  if (asked > bounds.maxPageSize) return ok({ limit: bounds.maxPageSize, offset, clamped: true });
  return ok({ limit: asked, offset, clamped: false });
}
