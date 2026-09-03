// Exact monetary amounts.
//
// ADR M0.3 §4 sketches this as `Money(cents)`. Measured against the baseline
// schema that sketch loses money: every amount column is
// `Decimal(18, 6)` — cents carried to six decimal places —
// because a single LLM step routinely costs a small fraction of one cent.
// A JavaScript `number` is a binary float with ~15 safe significant digits; an
// 18-digit decimal neither round-trips through it nor sums associatively.
//
// So an amount is an exact integer count of MICRO-CENTS (10^-6 cents) held in a
// bigint, which represents Decimal(18, 6) with no loss and no rounding policy of
// its own. Conversion to a display string is explicit and lossless; conversion
// to `number` is deliberately not offered.
//
// Provider rate cards are a different and finer scale — `Decimal(24, 12)`, USD
// per token — and belong to the `providers` context that owns ModelPrice, not to
// the kernel.

import type { Branded } from "./identifier.js";

/** ISO-4217 alphabetic code. Open by design; the baseline prices in USD. */
export type CurrencyCode = Branded<string, "CurrencyCode">;

export const USD = "USD" as CurrencyCode;

/** Micro-cents per cent, and cents per major unit. */
const MICRO_CENTS_PER_CENT = 1_000_000n;
const CENTS_PER_UNIT = 100n;

/** The Decimal(18, 6) domain, as micro-cents: 18 digits total. */
const MAX_MICRO_CENTS = 10n ** 18n - 1n;

/**
 * An exact monetary amount.
 *
 * `microCents` is signed: a credit, refund or budget adjustment is negative.
 */
export interface Money {
  readonly microCents: bigint;
  readonly currency: CurrencyCode;
}

export function money(microCents: bigint, currency: CurrencyCode = USD): Money {
  if (microCents > MAX_MICRO_CENTS || microCents < -MAX_MICRO_CENTS) {
    throw new RangeError(
      `amount ${microCents} micro-cents exceeds the Decimal(18, 6) domain the canonical store accepts`,
    );
  }
  return { microCents, currency };
}

export function zero(currency: CurrencyCode = USD): Money {
  return { microCents: 0n, currency };
}

export function isZero(amount: Money): boolean {
  return amount.microCents === 0n;
}

/**
 * Parse a canonical decimal string — the form a Decimal(18, 6) column reads back
 * as — into an exact amount. Accepts up to six fractional digits and rejects
 * anything it would have to round, rather than silently truncating a cost.
 */
export function moneyFromCentsString(cents: string, currency: CurrencyCode = USD): Money {
  const match = /^(-?)(\d+)(?:\.(\d{1,6}))?$/u.exec(cents.trim());
  if (!match) {
    throw new RangeError(`"${cents}" is not a Decimal(18, 6) cent amount`);
  }
  const [, sign, whole, fraction = ""] = match;
  const scaled = BigInt(whole ?? "0") * MICRO_CENTS_PER_CENT + BigInt(fraction.padEnd(6, "0"));
  return money(sign === "-" ? -scaled : scaled, currency);
}

/** Render as the canonical decimal-cents string the store round-trips. */
export function moneyToCentsString(amount: Money): string {
  const negative = amount.microCents < 0n;
  const magnitude = negative ? -amount.microCents : amount.microCents;
  const whole = magnitude / MICRO_CENTS_PER_CENT;
  const fraction = (magnitude % MICRO_CENTS_PER_CENT).toString().padStart(6, "0");
  return `${negative ? "-" : ""}${whole}.${fraction}`;
}

/** Render as a major-unit string (dollars) for display. Never for storage. */
export function moneyToMajorUnitString(amount: Money): string {
  const negative = amount.microCents < 0n;
  const magnitude = negative ? -amount.microCents : amount.microCents;
  const perUnit = MICRO_CENTS_PER_CENT * CENTS_PER_UNIT;
  const whole = magnitude / perUnit;
  const fraction = (magnitude % perUnit).toString().padStart(8, "0");
  return `${negative ? "-" : ""}${whole}.${fraction}`;
}

function sameCurrency(left: Money, right: Money): void {
  if (left.currency !== right.currency) {
    throw new TypeError(`cannot combine ${left.currency} with ${right.currency}`);
  }
}

export function add(left: Money, right: Money): Money {
  sameCurrency(left, right);
  return money(left.microCents + right.microCents, left.currency);
}

export function subtract(left: Money, right: Money): Money {
  sameCurrency(left, right);
  return money(left.microCents - right.microCents, left.currency);
}

export function sum(amounts: readonly Money[], currency: CurrencyCode = USD): Money {
  return amounts.reduce((total, amount) => add(total, amount), zero(currency));
}

/** Negative when left is cheaper, zero when equal, positive when dearer. */
export function compare(left: Money, right: Money): number {
  sameCurrency(left, right);
  if (left.microCents === right.microCents) return 0;
  return left.microCents < right.microCents ? -1 : 1;
}
