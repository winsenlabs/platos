// The four-rate price card — the `ModelPrice` row, as a value.
//
// A card is APPEND-ONLY and EFFECTIVE-DATED. Nothing here updates a rate: a new
// price is a new row with a later `effectiveFrom`, and the price of a turn that
// ran last month is still the card that was in force last month. That is what
// makes a spend ledger reproducible rather than a snapshot of today's rate card
// applied to yesterday's usage.
//
// EACH OF THE FOUR RATES CARRIES ITS OWN PROVENANCE, and this is the part most
// worth preserving carefully. `source`, `observedAt` and `sourceRef` are per
// RATE, not per card, because a card is routinely assembled from two origins: a
// public catalogue supplies three rates and an operator, having read the
// provider's own published price and found the catalogue wrong, overrides the
// fourth. Collapsing provenance to the card would erase which rate was verified.
//
// `UNAVAILABLE` IS NOT ZERO. A rate nobody knows is recorded as unavailable with
// a zero value, and pricing any non-zero token count against it FAILS rather
// than billing nothing. Silently charging zero for a rate the system could not
// find is the failure mode this distinction exists to prevent.

import { err, ok, type Result } from "@platos/kernel";

import { modelPricingUnavailable } from "./errors.js";
import type { ModelId, ModelKey, ModelPriceId, ProviderId } from "./identifiers.js";
import { sameRate, ZERO_RATE, type TokenRate } from "./rate.js";

/** The canonical store's `ModelRateSource` enum, unchanged. */
export const RATE_SOURCES = ["LITELLM", "VERIFIED_PROVIDER", "UNAVAILABLE"] as const;

export type RateSource = (typeof RATE_SOURCES)[number];

export function isRateSource(value: string): value is RateSource {
  return (RATE_SOURCES as readonly string[]).includes(value);
}

/** The four rates a card quotes. Order is the card's declaration order. */
export const RATE_NAMES = ["input", "output", "cacheRead", "cacheWrite"] as const;

export type RateName = (typeof RATE_NAMES)[number];

export interface RateEntry {
  readonly rate: TokenRate;
  readonly source: RateSource;
  /** When this rate was read from its source. */
  readonly observedAt: Date;
  /** Where it was read from. Null when the source is `UNAVAILABLE`. */
  readonly sourceRef: string | null;
}

export type RateBook = { readonly [Name in RateName]: RateEntry };

/** A card before it has been written, and therefore before it has a row id. */
export interface PriceCard {
  readonly effectiveFrom: Date;
  readonly rates: RateBook;
}

/** A card as stored, with the model it prices. */
export interface ModelPrice extends PriceCard {
  readonly modelPriceId: ModelPriceId;
  readonly modelId: ModelId;
}

/** A card joined to the model identity a caller needs to read it. */
export interface ModelPriceSnapshot extends ModelPrice {
  readonly modelKey: ModelKey;
  readonly provider: ProviderId;
  readonly modelName: string;
}

export function unavailableRate(observedAt: Date): RateEntry {
  return { rate: ZERO_RATE, source: "UNAVAILABLE", observedAt, sourceRef: null };
}

export function isRateKnown(entry: RateEntry): boolean {
  return entry.source !== "UNAVAILABLE";
}

/**
 * Are two rate entries the same PRICE FACT?
 *
 * `observedAt` is compared only for a verified rate, and that asymmetry is
 * deliberate and transcribed exactly from the source. A catalogue is re-read on
 * a schedule, so its `observedAt` moves on every pass while the price does not;
 * comparing it would append an identical card every time the ingest ran. A
 * verified rate's `observedAt` is the date a human checked the provider's own
 * published price, so a change in it IS a new fact even at an unchanged number.
 */
export function sameRateEntry(left: RateEntry, right: RateEntry): boolean {
  return (
    sameRate(left.rate, right.rate) &&
    left.source === right.source &&
    left.sourceRef === right.sourceRef &&
    (right.source !== "VERIFIED_PROVIDER" || left.observedAt.getTime() === right.observedAt.getTime())
  );
}

/** True when a stored card already records the candidate's four price facts. */
export function sameCard(stored: RateBook, candidate: RateBook): boolean {
  return RATE_NAMES.every((name) => sameRateEntry(stored[name], candidate[name]));
}

/**
 * The rate to charge, or a refusal.
 *
 * A zero token count against an unknown rate is fine — nothing is being charged
 * for — so the check is on the count, not on the rate alone. A non-zero count
 * against an unknown rate is the case that must not silently become free.
 */
export function chargeableRate(
  model: string,
  name: RateName,
  tokens: number,
  entry: RateEntry,
): Result<TokenRate> {
  if (tokens > 0 && !isRateKnown(entry)) return err(modelPricingUnavailable(model, name));
  return ok(entry.rate);
}

/** Newest first. The ordering the price history is read in. */
export function byEffectiveFromDescending(left: PriceCard, right: PriceCard): number {
  return right.effectiveFrom.getTime() - left.effectiveFrom.getTime();
}

export function isInForceAt(card: PriceCard, at: Date): boolean {
  return card.effectiveFrom.getTime() <= at.getTime();
}

/**
 * The card in force at an instant: the latest `effectiveFrom` at or before it.
 *
 * A card dated in the future is invisible until its date arrives, which is what
 * lets an announced price change be loaded ahead of time without repricing
 * everything that runs before it.
 */
export function cardInForceAt<Card extends PriceCard>(
  history: readonly Card[],
  at: Date,
): Card | null {
  return [...history].filter((card) => isInForceAt(card, at)).sort(byEffectiveFromDescending)[0] ?? null;
}

/**
 * Choose one snapshot from several candidate lookup keys.
 *
 * KEY ORDER WINS, NOT RECENCY, and this is the subtle rule the source encodes by
 * building a newest-per-key map and then walking the key list. The keys arrive
 * from `domain/model-key.ts` in most-specific-first order, so an exact
 * `<provider>:<model>` match beats a bare model name that some other provider
 * also publishes — even when the bare name's card is newer. Sorting by date
 * across keys instead would let an unrelated provider's fresher card price
 * another provider's turn.
 */
export function selectByKeyPrecedence(
  keys: readonly string[],
  candidates: readonly ModelPriceSnapshot[],
  at: Date,
): ModelPriceSnapshot | null {
  const newestByKey = new Map<string, ModelPriceSnapshot>();
  for (const candidate of candidates) {
    if (!isInForceAt(candidate, at)) continue;
    const held = newestByKey.get(candidate.modelKey);
    if (held === undefined || byEffectiveFromDescending(candidate, held) < 0) {
      newestByKey.set(candidate.modelKey, candidate);
    }
  }
  for (const key of keys) {
    const found = newestByKey.get(key);
    if (found !== undefined) return found;
  }
  return null;
}
