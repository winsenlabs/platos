// Spend, exactly.
//
// A cap is an integer count of cents (`Budget.limitCents` is `Int`). Spend is
// not: one model step routinely costs a small fraction of one cent, and the
// canonical columns carry `Decimal(18, 6)`. The kernel's `Money` is exactly that
// domain, held as an integer count of micro-cents in a bigint, so this context
// adopts it rather than minting a second money type.
//
// WHY NOT A `number` FOR EITHER SIDE.
//
// The source holds spend as a JavaScript `number` and computes utilisation as
// `(spentCents / limitCents) * 100`, then rounds the RESULT to two decimals with
// `toFixed(2)` and compares THAT to the threshold. Two things follow, and both
// are fixed here:
//
//   1. Rounding before comparing fires a threshold EARLY. 49.996% of a cap
//      rounds to 50.00 and crosses the 50% line. It is a small error, but it is
//      an alert about a fact that has not happened yet, and the alert is durable
//      and unique per window — so the correct alert can never be sent.
//      `hasCrossed` below compares the EXACT ratio; `utilisation` produces the
//      rounded figure for display only, and nothing decides on it.
//
//   2. Summing floats is not associative. Thirty daily buckets summed in a
//      different order give a different total, and a cap sitting on the boundary
//      then trips or does not depending on read order. Every addition here is
//      bigint.
//
// THE CACHE-AWARE PREFERENCE IS THE OTHER HALF OF THE ARITHMETIC, and it lives
// in `settledSpend`. The measured failure it guards is in the extraction source's
// own note: for one production day the cache-aware figure was 25.70c against the
// naive 2.47c, so a cap enforced on the naive number could not trip, and the gap
// WIDENED as caching improved. Reading the wrong field is the difference between
// a cap and a decoration.

import {
  add,
  compare,
  money,
  moneyFromCentsString,
  moneyToCentsString,
  zero,
  type Money,
  type Result,
  err,
  ok,
} from "@platos/kernel";

import { spendInvalid } from "./errors.js";

/** Micro-cents in one cent — the `Decimal(18, 6)` scale, as an integer factor. */
const MICRO_CENTS_PER_CENT = 1_000_000n;

/** A cap, in whole cents. Zero and below mean "this dimension is not capped". */
export type LimitCents = number;

/**
 * The two figures a rollup bucket carries, as the counter store returns them.
 *
 * Both are optional because a bucket written before cache telemetry existed has
 * only the naive one, and those rows are still inside the ninety-day retention
 * window. `null` and `undefined` are distinct from `0`: a bucket that HAS a
 * cache-aware figure of zero genuinely cost nothing, and must not fall back.
 */
export interface SpendCounters {
  readonly costCents?: string | number | null;
  readonly costWithCacheCents?: string | number | null;
  readonly tasks?: string | number | null;
  /** The pre-`tasks` per-turn counter. The one legitimate fallback. */
  readonly legacyTasks?: string | number | null;
}

/** What one window read produced. */
export interface SpendReading {
  /** Settled spend — work that has completed and been priced. */
  readonly settled: Money;
  /**
   * In-flight spend: reserved for turns that have started and not yet settled.
   *
   * Clamped at zero PER BUCKET, not on the total. An over-settlement defect can
   * drive one bucket negative, and letting that negative cancel a sibling
   * bucket's real reservation would hide live spend from the cap.
   */
  readonly reserved: Money;
  /** Completed turns in the window. One turn, one task — never one model call. */
  readonly tasks: number;
}

export const EMPTY_READING: SpendReading = Object.freeze({
  settled: zero(),
  reserved: zero(),
  tasks: 0,
});

/** Settled plus reserved: what a cap is compared against. */
export function chargeableSpend(reading: SpendReading): Money {
  return add(reading.settled, reading.reserved);
}

function finite(value: string | number | null | undefined): number | null {
  if (value === null || value === undefined || value === "") return null;
  const parsed = typeof value === "number" ? value : Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

/**
 * A cent figure as an exact amount.
 *
 * Goes through the number's own decimal form rather than through
 * `Math.round(value * 1e6)`: the multiplication is a float operation and loses a
 * micro-cent on values that print exactly. Anything finer than a micro-cent is
 * rounded half-up onto the grid, which is the only rounding this context does
 * and the only place it is allowed to happen.
 */
export function centsToMoney(cents: number): Result<Money> {
  if (!Number.isFinite(cents)) {
    return err(spendInvalid("cost must be a finite number of cents", { cents: String(cents) }));
  }
  // The `Decimal(18, 6)` ceiling, checked BEFORE the conversion. The kernel's
  // `money` throws a `RangeError` past it, and a domain function that returns a
  // `Result` must not also throw: a caller reading the type would not know to
  // catch, and a counter corrupted upstream would take down the hot path.
  if (Math.abs(cents) >= 1e12) {
    return err(spendInvalid("cost exceeds the Decimal(18, 6) domain", { cents: String(cents) }));
  }
  const text = cents.toFixed(20);
  const negative = text.startsWith("-");
  const [whole = "0", fraction = ""] = (negative ? text.slice(1) : text).split(".");
  const micro = BigInt(fraction.slice(0, 6).padEnd(6, "0"));
  const roundUp = (fraction[6] ?? "0") >= "5" ? 1n : 0n;
  const magnitude = BigInt(whole) * MICRO_CENTS_PER_CENT + micro + roundUp;
  return ok(money(negative ? -magnitude : magnitude));
}

/**
 * The billable cost of one rollup bucket.
 *
 * Prefers the cache-aware figure. Falls back to the naive one ONLY when the
 * cache-aware field is absent entirely — never when it is present and zero.
 */
export function settledSpend(counters: SpendCounters): Result<Money> {
  const withCache = finite(counters.costWithCacheCents);
  if (withCache !== null) return centsToMoney(withCache);
  const naive = finite(counters.costCents);
  return naive === null ? ok(zero()) : centsToMoney(naive);
}

/**
 * Completed turns in one bucket.
 *
 * `tasks` is written once per turn and by nothing else. `runs` is the pre-`tasks`
 * spelling of the same counter and is the one legitimate fallback. The model-call
 * counter is NOT read here at any point: embedding, compaction and thread naming
 * all bump it, so reading it as a turn count made a runs cap fire on work the
 * operator never asked for.
 */
export function completedTasks(counters: SpendCounters): number {
  const tasks = finite(counters.tasks);
  if (tasks !== null) return Math.trunc(tasks);
  const legacy = finite(counters.legacyTasks);
  return legacy === null ? 0 : Math.trunc(legacy);
}

/**
 * Fold buckets into one reading.
 *
 * The reserved side is clamped bucket by bucket; the settled side is not,
 * because a genuine credit belongs in the total.
 */
export function foldBuckets(
  settled: readonly SpendCounters[],
  reserved: readonly SpendCounters[],
): Result<SpendReading> {
  let settledTotal = zero();
  let tasks = 0;
  for (const bucket of settled) {
    const amount = settledSpend(bucket);
    if (!amount.ok) return err(amount.error);
    settledTotal = add(settledTotal, amount.value);
    tasks += completedTasks(bucket);
  }
  let reservedTotal = zero();
  for (const bucket of reserved) {
    const amount = settledSpend(bucket);
    if (!amount.ok) return err(amount.error);
    if (amount.value.microCents > 0n) reservedTotal = add(reservedTotal, amount.value);
  }
  return ok({ settled: settledTotal, reserved: reservedTotal, tasks });
}

/** The cap as an exact amount, for comparison against spend. */
export function limitToMoney(limitCents: LimitCents): Money {
  return money(BigInt(Math.trunc(limitCents)) * MICRO_CENTS_PER_CENT);
}

/**
 * Utilisation in BASIS POINTS — hundredths of one percent, as an integer.
 *
 * This is the two-decimal figure the source renders, computed exactly instead of
 * through a float division and a `toFixed`. It is a DISPLAY value: nothing in
 * this context decides anything by comparing it, because rounding a ratio before
 * comparing it is what fires a threshold early.
 *
 * An uncapped dimension is 0, not infinity: the source returns 0 for a zero
 * limit and every consumer renders it as "no cap", which a division by zero
 * could not.
 */
export function utilisationBasisPoints(spent: Money, limitCents: LimitCents): number {
  if (limitCents <= 0) return 0;
  const denominator = 100n * BigInt(Math.trunc(limitCents));
  const negative = spent.microCents < 0n;
  const magnitude = negative ? -spent.microCents : spent.microCents;
  const scaled = (2n * magnitude + denominator) / (2n * denominator);
  return negative ? -Number(scaled) : Number(scaled);
}

/** The same figure as a percentage with two decimals, for rendering only. */
export function utilisationPercent(spent: Money, limitCents: LimitCents): number {
  return utilisationBasisPoints(spent, limitCents) / 100;
}

/**
 * Has `spent` reached `threshold` percent of `limitCents`?
 *
 * The comparison is `spent * 100 >= threshold * limit`, entirely in bigint, so
 * nothing is rounded before the decision. An uncapped dimension never crosses.
 */
export function hasCrossed(spent: Money, limitCents: LimitCents, threshold: number): boolean {
  if (limitCents <= 0) return false;
  const left = spent.microCents * 100n;
  const right = BigInt(Math.trunc(threshold)) * BigInt(Math.trunc(limitCents)) * MICRO_CENTS_PER_CENT;
  return left >= right;
}

/** Has a run counter reached `threshold` percent of its limit? */
export function runsCrossed(tasks: number, runsLimit: number, threshold: number): boolean {
  if (runsLimit <= 0) return false;
  return tasks * 100 >= threshold * runsLimit;
}

/** At or past the cap. The hard stop, on the exact figures. */
export function isAtLimit(spent: Money, limitCents: LimitCents): boolean {
  if (limitCents <= 0) return false;
  return compare(spent, limitToMoney(limitCents)) >= 0;
}

/** The canonical `Decimal(18, 6)` cents string a surface renders or stores. */
export function spendToCentsString(spent: Money): string {
  return moneyToCentsString(spent);
}

/**
 * Read a canonical `Decimal(18, 6)` cents string exactly.
 *
 * The form `providers` publishes an amount in — a STRING, because a JSON number
 * cannot carry eighteen digits. The kernel's parser throws on a malformed value;
 * this wraps it, because an amount arriving across a contract boundary is data
 * and a domain function that returns a `Result` must not also throw.
 */
export function spendFromCentsString(cents: string): Result<Money> {
  try {
    return ok(moneyFromCentsString(cents));
  } catch {
    return err(spendInvalid("not a canonical Decimal(18, 6) cent amount", { cents }));
  }
}
