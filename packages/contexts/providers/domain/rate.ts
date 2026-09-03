// Exact provider rate cards.
//
// The kernel's `Money` note hands this scale here by name: "Provider rate cards
// are a different and finer scale — `Decimal(24, 12)`, USD per token — and
// belong to the `providers` context that owns ModelPrice, not to the kernel."
// This is that type.
//
// A rate is an exact integer count of PICO-USD (10^-12 USD) per token, held in a
// bigint. That is `Decimal(24, 12)` with no loss: 24 significant digits, twelve
// of them fractional, which a JavaScript `number` cannot represent — a binary
// float carries about 15 safe significant digits and neither round-trips a
// 24-digit decimal nor sums associatively over one.
//
// WHY THIS MATTERS AND IS NOT PEDANTRY. The extraction source carries rates as
// `number` and computes a turn's cost as
//
//     tokens * usdPerToken * 100          // cents, as a float
//     Math.round(cents * 1e6) / 1e6       // six decimal places of a cent
//
// which rounds once, at the end, after the float sum has already drifted. On
// most inputs the drift is smaller than the grid and invisible. It stops being
// invisible when the true value lands exactly on a half — then the accumulated
// representation error, not the price, decides which way the rounding goes.
// `cost.test.ts` pins one such step at rates of about eleven cents per million
// tokens: the exact value is 53792.5 micro-cents and the float form rounds it
// DOWN while the true half rounds up.
//
// The exact form below computes the same grid — six decimal places of a cent,
// which is precisely the kernel's micro-cent — from an integer sum, so it is
// associative and its rounding is decided by the price rather than by the order
// the four rates were added in.
//
// The grid is the same, so this is a refactor and not a repricing: wherever the
// float form was accurate the two agree exactly, and `cost.test.ts` asserts that
// agreement across a range of live rate cards.

import { err, ok, type Result } from "@platos/kernel";

import { modelRateInvalid } from "./errors.js";

/** Pico-USD per pico-USD... i.e. the scale factor of one whole USD. */
const PICO_PER_USD = 10n ** 12n;

/** The Decimal(24, 12) domain: 24 digits total, expressed in pico-USD. */
const MAX_PICO_USD = 10n ** 24n - 1n;

/**
 * An exact per-token price.
 *
 * Non-negative by construction. The source's `validRate` admits only finite
 * numbers at or above zero, and a negative rate has no meaning: a provider
 * credit is a ledger entry, not a price.
 */
export interface TokenRate {
  readonly picoUsdPerToken: bigint;
}

export const ZERO_RATE: TokenRate = Object.freeze({ picoUsdPerToken: 0n });

export function tokenRate(picoUsdPerToken: bigint): Result<TokenRate> {
  if (picoUsdPerToken < 0n) {
    return err(modelRateInvalid("a per-token rate may not be negative", { value: `${picoUsdPerToken}` }));
  }
  if (picoUsdPerToken > MAX_PICO_USD) {
    return err(
      modelRateInvalid("rate exceeds the Decimal(24, 12) domain the canonical store accepts", {
        value: `${picoUsdPerToken}`,
      }),
    );
  }
  return ok({ picoUsdPerToken });
}

export function isZeroRate(rate: TokenRate): boolean {
  return rate.picoUsdPerToken === 0n;
}

const DECIMAL = /^(-?)(\d+)(?:\.(\d+))?(?:[eE]([+-]?\d+))?$/u;

/**
 * Parse a decimal string into an exact rate.
 *
 * Accepts the canonical form a `Decimal(24, 12)` column reads back as, and also
 * exponent notation, because that is how a small rate arrives from a parsed JSON
 * catalogue: `2e-7` and `0.000000200000` are the same price and must produce the
 * same integer.
 *
 * A value finer than 10^-12 is ROUNDED HALF-UP to the grid rather than rejected.
 * That is not leniency — it is what the column itself does on assignment, so
 * rejecting here would make this type refuse values the store would have
 * accepted, and the two would disagree about what is representable.
 */
export function rateFromDecimalString(value: string): Result<TokenRate> {
  const match = DECIMAL.exec(value.trim());
  if (match === null) {
    return err(modelRateInvalid("not a decimal number", { value }));
  }
  const [, sign, whole = "0", fraction = "", exponent = "0"] = match;
  if (sign === "-") {
    return err(modelRateInvalid("a per-token rate may not be negative", { value }));
  }

  // Shift the decimal point by the exponent, then onto the pico grid. Doing both
  // as one integer shift means no intermediate value is ever a float.
  const digits = `${whole}${fraction}`;
  const shift = 12 + Number(exponent) - fraction.length;
  if (shift >= 0) {
    return tokenRate(BigInt(digits) * 10n ** BigInt(shift));
  }
  const divisor = 10n ** BigInt(-shift);
  const scaled = BigInt(digits);
  // Half-up, matching the store's rounding on assignment.
  return tokenRate((scaled + divisor / 2n) / divisor);
}

/**
 * Convert a JavaScript number into an exact rate.
 *
 * It goes through the number's own shortest round-trip decimal form rather than
 * through arithmetic. `2e-7 * 1e12` is not `200000` in binary floating point;
 * `(2e-7).toString()` is `"2e-7"`, and reading THAT exactly gives the integer
 * the operator meant. This is the boundary where a catalogue's `number` becomes
 * a price, and it is the only place a float is allowed to appear.
 */
export function rateFromNumber(value: number): Result<TokenRate> {
  if (!Number.isFinite(value)) {
    return err(modelRateInvalid("rate must be a finite number", { value: `${value}` }));
  }
  return rateFromDecimalString(value.toString());
}

/** Render on the canonical `Decimal(24, 12)` grid the store round-trips. */
export function rateToDecimalString(rate: TokenRate): string {
  const whole = rate.picoUsdPerToken / PICO_PER_USD;
  const fraction = (rate.picoUsdPerToken % PICO_PER_USD).toString().padStart(12, "0");
  return `${whole}.${fraction}`;
}

export function sameRate(left: TokenRate, right: TokenRate): boolean {
  return left.picoUsdPerToken === right.picoUsdPerToken;
}
