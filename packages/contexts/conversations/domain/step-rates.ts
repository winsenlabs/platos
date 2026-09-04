// The rate provenance a `Step` row carries, and the rule that makes it useful.
//
// `Step` has TWELVE rate columns and four rate names: for each of `input`,
// `output`, `cacheRead` and `cacheWrite` it stores the rate itself
// (`Decimal(24, 12)` USD per token), where the rate came from
// (`ModelRateSource`), when it was observed, and a free-text reference. The
// schema comment says what they are for in one sentence — "immutable USD-per-token
// rates and provenance used to compute costCents" — and every one of the twelve
// is nullable.
//
// WHO PRICES, AND WHO CHECKS. `providers` prices: `priceModelUsage` resolves the
// card in force at the instant, applies the four rates, and answers an exact
// `Decimal(18, 6)` cent amount. This context does not re-derive that number and
// deliberately owns no copy of the arithmetic — one implementation of
// `tokens x rate` is the point of putting the card behind that contract.
//
// What this context owns is the ROW. A step written with five thousand cache
// reads and a null `cacheReadRate` is a row nobody can audit, re-price or
// explain: the cost column says what was charged and nothing in the row says
// why. So the rule here is about self-description, not about money:
//
//     A RATE MAY BE ABSENT ONLY WHERE ITS TOKEN COUNT IS ZERO.
//
// That is a different check from the one `providers` makes, at a different
// boundary, and both are real. `providers` refuses to PRICE an unpriceable
// usage; this refuses to STORE an unexplainable row. A step that was never
// priced at all — one that failed before the provider answered — carries four
// zero counts and four null rates and is admitted, which is why the rule is
// conditioned on the count rather than being "all four present".
//
// THE MEASURED REASON THIS IS ITS OWN CODE. A fixture that carried no rate card
// at all left every pricing branch in a whole package unexecuted while every
// case stayed green, because "no rate" and "no tokens" both produced a zero
// cost. `CONVERSATIONS_STEP_RATE_MISSING` exists so the two are distinguishable,
// and `step-rates.test.ts` asserts a non-zero count with a null rate is refused
// while a zero count with a null rate is not.

import { err, ok, type Result } from "@platos/kernel";

import { stepRateMissing } from "./errors.js";
import { billableStepTokens, type StepUsage } from "./step-usage.js";

/** `ModelRateSource` in the canonical schema, spelled as its owner spells it. */
export const RATE_SOURCES = ["LITELLM", "VERIFIED_PROVIDER", "UNAVAILABLE"] as const;

export type RateSource = (typeof RATE_SOURCES)[number];

/** The four names, in the order the columns are declared. */
export const STEP_RATE_NAMES = ["input", "output", "cacheRead", "cacheWrite"] as const;

export type StepRateName = (typeof STEP_RATE_NAMES)[number];

/**
 * One rate as the row stores it.
 *
 * `usdPerToken` is the canonical `Decimal(24, 12)` STRING, not a number. Twelve
 * fractional digits do not survive a binary float, and this value is written
 * back into a decimal column: parsing it into a float here and re-rendering it
 * on the way out is exactly how a rate drifts in its last digits.
 */
export interface StepRate {
  readonly usdPerToken: string;
  readonly source: RateSource;
  readonly observedAt: Date;
  readonly sourceRef: string | null;
}

/** All four, each absent-able. Absence is only legal at a zero token count. */
export type StepRateBook = { readonly [Name in StepRateName]: StepRate | null };

export const NO_STEP_RATES: StepRateBook = Object.freeze({
  input: null,
  output: null,
  cacheRead: null,
  cacheWrite: null,
});

/** The token count each rate name is applied to, from the billable split. */
export function chargedTokensByRate(usage: StepUsage): Readonly<Record<StepRateName, number>> {
  const billable = billableStepTokens(usage);
  return Object.freeze({
    input: billable.freshInputTokens,
    output: billable.outputTokens,
    cacheRead: billable.cacheReadInputTokens,
    cacheWrite: billable.cacheWriteInputTokens,
  });
}

/**
 * Refuse a rate book that cannot explain the usage beside it.
 *
 * Answers the book unchanged on success rather than `void`, so a caller cannot
 * check and then store a different one.
 */
export function requireExplainedRates(usage: StepUsage, rates: StepRateBook): Result<StepRateBook> {
  const charged = chargedTokensByRate(usage);
  for (const name of STEP_RATE_NAMES) {
    const tokens = charged[name];
    if (tokens > 0 && rates[name] === null) return err(stepRateMissing(`${name}Rate`, tokens));
  }
  return ok(rates);
}

/**
 * True when every rate present was observed from a live provider or a card.
 *
 * `UNAVAILABLE` is a real value of `ModelRateSource` and it means the price was
 * not known: a step carrying one has a cost that is a floor rather than a fact.
 * Callers rendering a bill need to be able to say so, and a boolean here is what
 * lets them without re-walking the twelve columns.
 */
export function ratesFullyObserved(rates: StepRateBook): boolean {
  return STEP_RATE_NAMES.every((name) => {
    const rate = rates[name];
    return rate === null || rate.source !== "UNAVAILABLE";
  });
}
