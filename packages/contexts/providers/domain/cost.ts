// From a price card and a usage report to an amount of money.
//
// This is the one place in the system where a rate card and a token count meet,
// and it is the seam the kernel's `Money` note describes from the other side:
// rates are `Decimal(24, 12)` USD per token, amounts are `Decimal(18, 6)` cents,
// and this function is the conversion between the two scales.
//
// THE ARITHMETIC, WRITTEN OUT ONCE.
//
//     amount_usd    = tokens x rate_pico x 10^-12
//     amount_cents  = amount_usd x 100
//     microCents    = amount_cents x 10^6
//                   = tokens x rate_pico x 10^-4
//
// So the whole calculation is an integer sum divided by ten thousand, rounded
// once. Every intermediate is a bigint, so the sum is associative and the result
// does not depend on the order the four rates were added in — which the float
// form it replaces does not guarantee.
//
// ROUNDING IS HALF-UP, ONCE, AT THE END, on the micro-cent grid. That is exactly
// the grid and the direction the source's `Math.round(cents * 1e6) / 1e6`
// produces for a non-negative amount, so a step priced by either form lands on
// the same value wherever the float form was accurate.

import { money, USD, type CurrencyCode, type Money, err, ok, type Result } from "@platos/kernel";

import {
  chargeableRate,
  RATE_NAMES,
  type ModelPriceSnapshot,
  type RateBook,
  type RateName,
} from "./price-card.js";
import { billableTokens, type TokenUsage } from "./token-usage.js";

/** Pico-USD per token, times one token, divided by this, is one micro-cent. */
const PICO_USD_PER_MICRO_CENT = 10_000n;

/** What each rate charged for, so a caller can show the split. */
export type ChargedTokens = { readonly [Name in RateName]: number };

export interface PricedUsage {
  readonly amount: Money;
  readonly charged: ChargedTokens;
}

function chargedTokens(usage: TokenUsage): ChargedTokens {
  const billable = billableTokens(usage);
  return {
    input: billable.freshInputTokens,
    output: billable.outputTokens,
    cacheRead: billable.cacheReadInputTokens,
    cacheWrite: billable.cacheWriteInputTokens,
  };
}

/**
 * Price a usage report against a rate book.
 *
 * Fails, rather than charging zero, when any rate the report actually consumed
 * is unknown. `model` is carried only so the refusal can name what could not be
 * priced.
 */
export function priceUsageAgainst(
  model: string,
  rates: RateBook,
  usage: TokenUsage,
  currency: CurrencyCode = USD,
): Result<PricedUsage> {
  const charged = chargedTokens(usage);
  let picoUsd = 0n;

  for (const name of RATE_NAMES) {
    const tokens = charged[name];
    const rate = chargeableRate(model, name, tokens, rates[name]);
    if (!rate.ok) return err(rate.error);
    picoUsd += BigInt(tokens) * rate.value.picoUsdPerToken;
  }

  // Half-up on a non-negative value: add half a unit, then truncate. bigint
  // division truncates toward zero, which is floor here because the sum of
  // non-negative token counts and non-negative rates cannot be negative.
  const microCents = (picoUsd + PICO_USD_PER_MICRO_CENT / 2n) / PICO_USD_PER_MICRO_CENT;
  return ok({ amount: money(microCents, currency), charged });
}

/** Price against a stored snapshot, naming the model it was resolved for. */
export function priceUsage(
  snapshot: ModelPriceSnapshot,
  usage: TokenUsage,
  currency: CurrencyCode = USD,
): Result<PricedUsage> {
  return priceUsageAgainst(snapshot.modelKey, snapshot.rates, usage, currency);
}
