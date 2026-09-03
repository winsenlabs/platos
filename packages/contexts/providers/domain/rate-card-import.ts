// Reading a public rate-card catalogue into this context's own vocabulary.
//
// The system prices turns from a public, community-maintained model-price
// catalogue, corrected where an operator has read a provider's own published
// price and found the catalogue wrong. Both halves are here, both pure: the
// ingest use case supplies a parsed catalogue as DATA and this module turns it
// into model facts and rate books. Nothing below fetches anything.
//
// TWO PROPERTIES OF THE SOURCE ARE PRESERVED EXACTLY BECAUSE THEY ARE LOAD-BEARING.
//
//   1. AN OVERRIDE IS PER RATE, NOT PER CARD. A correction that names only
//      `input` corrects only `input`; the other three keep coming from the
//      catalogue. Replacing the whole card would silently discard three
//      catalogue rates in order to fix one.
//
//   2. A COUNT ARRIVING AS A STRING IS COERCED, NOT TRUSTED. The catalogue is
//      parsed JSON, so a field declared `number` may hold `"128000"`. The source
//      records that an uncoerced value crashed the ingest on boot and took the
//      whole process down. Anything that is not a safe integer — a float, an
//      empty string, a word — becomes absent rather than a guess.

import { unavailableRate, type RateBook, type RateEntry, type RateName } from "./price-card.js";
import { modelLookupKeys, CATALOGUE_PROVIDER_PREFIX } from "./model-key.js";
import { rateFromNumber } from "./rate.js";

/** Where the public catalogue is published. Recorded on every rate it supplies. */
export const RATE_CARD_CATALOGUE_URL =
  "https://raw.githubusercontent.com/BerriAI/litellm/main/model_prices_and_context_window.json";

/** One model's record in the public catalogue, as parsed. */
export interface RateCardEntry {
  readonly input_cost_per_token?: unknown;
  readonly output_cost_per_token?: unknown;
  readonly cache_read_input_token_cost?: unknown;
  readonly cache_creation_input_token_cost?: unknown;
  readonly litellm_provider?: string;
  readonly max_tokens?: unknown;
  readonly max_input_tokens?: unknown;
  readonly max_output_tokens?: unknown;
  readonly mode?: string;
  readonly supports_function_calling?: boolean;
  readonly supports_parallel_function_calling?: boolean;
  readonly supports_vision?: boolean;
  readonly supports_reasoning?: boolean;
  readonly supports_tool_choice?: boolean;
  readonly model_name?: string;
  readonly description?: string;
  readonly release_date?: string;
  readonly deprecation_date?: string;
}

export type RateCardCatalogue = Readonly<Record<string, RateCardEntry>>;

/**
 * A provider-published price committed alongside the evidence for it.
 *
 * `providerQuote` and `catalogueSaid` are not decoration. A correction that says
 * only "the catalogue is wrong" is unreviewable a year later; one that quotes
 * both numbers and dates the reading can be re-checked against the provider's
 * page by anyone.
 */
export interface VerifiedRateOverride {
  /** The `<provider>:<model>` string this correction applies to. */
  readonly model: string;
  readonly provider: string;
  /** USD per token. An omitted rate keeps coming from the catalogue. */
  readonly input?: number;
  readonly output?: number;
  readonly cacheRead?: number;
  readonly cacheWrite?: number;
  /** Where the provider published it. */
  readonly source: string;
  /** ISO date the reading was taken. Becomes the rate's `observedAt`. */
  readonly verifiedOn: string;
  readonly providerQuote: string;
  readonly catalogueSaid?: string;
  readonly notes?: string;
}

export const VERIFIED_RATE_OVERRIDES: readonly VerifiedRateOverride[] = Object.freeze([
  Object.freeze({
    model: "openai:gpt-5.6-luna",
    provider: "openai",
    input: 2e-7,
    cacheRead: 2e-8,
    cacheWrite: 5e-7,
    output: 1.2e-6,
    source: "https://developers.openai.com/api/docs/pricing",
    verifiedOn: "2026-07-31",
    providerQuote:
      'gpt-5.6-luna standard: Input "$0.20", Cached input "$0.02", Cache writes "$0.50", Output "$1.20" per 1M tokens',
    catalogueSaid:
      "input 1e-6, output 6e-6, cache_read 1e-7, cache_write 1.25e-6 — input/output/read all 5x high, cache_write 2x high even after correcting the 5x scale error",
    notes:
      "Sibling gpt-5.6-sol was checked at the same time and the catalogue has it exactly right ($5.00/$0.50/$30.00), so this is a per-row error rather than family-wide staleness.",
  }),
]);

const OVERRIDE_BY_QUALIFIED_MODEL = new Map(
  VERIFIED_RATE_OVERRIDES.map((entry) => [entry.model, entry] as const),
);

/** The bare model name an override names, with its provider segment removed. */
export function overrideModelName(entry: VerifiedRateOverride): string {
  const separator = entry.model.indexOf(":");
  return separator > 0 ? entry.model.slice(separator + 1) : entry.model;
}

/**
 * Find the correction that applies to a catalogue entry, if any.
 *
 * The provider must match as well as the name. A correction to
 * `openai:gpt-5.6-luna` must not reach a same-named model published by someone
 * else, so every candidate key is re-qualified with the entry's own provider
 * before it is looked up.
 */
export function verifiedRateFor(
  lookupKeys: readonly string[],
  catalogueProvider: string,
): VerifiedRateOverride | null {
  const provider = catalogueProvider.trim().toLowerCase();
  if (provider === "") return null;
  for (const key of lookupKeys) {
    const separator = key.indexOf(":");
    if (separator > 0) {
      if (key.slice(0, separator).toLowerCase() !== provider) continue;
      const entry = OVERRIDE_BY_QUALIFIED_MODEL.get(`${provider}:${key.slice(separator + 1)}`);
      if (entry?.provider === provider) return entry;
      continue;
    }
    const prefix = `${CATALOGUE_PROVIDER_PREFIX[provider] ?? provider}/`;
    const bare = key.startsWith(prefix) ? key.slice(prefix.length) : key;
    const entry = OVERRIDE_BY_QUALIFIED_MODEL.get(`${provider}:${bare}`);
    if (entry?.provider === provider) return entry;
  }
  return null;
}

/** A token count from parsed JSON, or absent. Never a guess. */
export function coerceTokenCount(value: unknown): number | null {
  if (typeof value === "number") return Number.isSafeInteger(value) ? value : null;
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  if (trimmed === "") return null;
  const parsed = Number(trimmed);
  return Number.isSafeInteger(parsed) ? parsed : null;
}

export function coerceDate(value: string | undefined): Date | null {
  if (value === undefined || value === "") return null;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date;
}

/** An override's date, read as midnight UTC so it is stable across regions. */
export function verifiedObservedAt(verifiedOn: string): Date {
  return new Date(`${verifiedOn}T00:00:00.000Z`);
}

/** The catalogue's boolean flags, flattened into the open capability list. */
export function capabilitiesFor(entry: RateCardEntry): readonly string[] {
  return [
    entry.mode !== undefined && entry.mode !== "" ? `mode:${entry.mode}` : null,
    entry.supports_function_calling === true ? "function_calling" : null,
    entry.supports_parallel_function_calling === true ? "parallel_function_calling" : null,
    entry.supports_vision === true ? "vision" : null,
    entry.supports_reasoning === true ? "reasoning" : null,
    entry.supports_tool_choice === true ? "tool_choice" : null,
  ].filter((value): value is string => value !== null);
}

const CATALOGUE_RATE_FIELD: { readonly [Name in RateName]: keyof RateCardEntry } = {
  input: "input_cost_per_token",
  output: "output_cost_per_token",
  cacheRead: "cache_read_input_token_cost",
  cacheWrite: "cache_creation_input_token_cost",
};

/**
 * One rate: the override if the correction names it, else the catalogue's, else
 * unavailable.
 *
 * A catalogue value this module cannot read as a non-negative finite number is
 * treated as absent rather than as zero — the difference between "free" and
 * "nobody knows", which `price-card.ts` refuses to charge against.
 */
export function rateEntryFor(
  name: RateName,
  entry: RateCardEntry,
  observedAt: Date,
  override: VerifiedRateOverride | null,
): RateEntry {
  const corrected = override?.[name];
  if (override !== null && corrected !== undefined) {
    const exact = rateFromNumber(corrected);
    if (exact.ok) {
      return {
        rate: exact.value,
        source: "VERIFIED_PROVIDER",
        observedAt: verifiedObservedAt(override.verifiedOn),
        sourceRef: override.source,
      };
    }
  }
  const published = entry[CATALOGUE_RATE_FIELD[name]];
  if (typeof published === "number") {
    const exact = rateFromNumber(published);
    if (exact.ok) {
      return { rate: exact.value, source: "LITELLM", observedAt, sourceRef: RATE_CARD_CATALOGUE_URL };
    }
  }
  return unavailableRate(observedAt);
}

export function rateBookFor(
  entry: RateCardEntry,
  observedAt: Date,
  override: VerifiedRateOverride | null,
): RateBook {
  return {
    input: rateEntryFor("input", entry, observedAt, override),
    output: rateEntryFor("output", entry, observedAt, override),
    cacheRead: rateEntryFor("cacheRead", entry, observedAt, override),
    cacheWrite: rateEntryFor("cacheWrite", entry, observedAt, override),
  };
}

/** The correction that applies to a catalogue key, resolved through its aliases. */
export function overrideForCatalogueKey(key: string, provider: string): VerifiedRateOverride | null {
  return verifiedRateFor(modelLookupKeys(key), provider);
}
