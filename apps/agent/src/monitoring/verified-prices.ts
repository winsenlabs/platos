/**
 * Provider-verified price overrides for the runtime cost catalog.
 *
 * WHY THIS EXISTS
 *
 * The runtime catalog is LiteLLM's `model_prices_and_context_window.json`, which
 * covers ~3,000 models and is the only practical source for the long tail (the
 * ~200 Together models, Groq, Fireworks, etc.). It is also, demonstrably, wrong
 * on individual rows — and wrong in a way that cannot be detected by age, which
 * is the dangerous kind.
 *
 * Measured 2026-07-31 against OpenAI's own pricing page:
 *   gpt-5.6-sol   LiteLLM $5.00 / $0.50 / $30.00   provider $5.00 / $0.50 / $30.00   exact
 *   gpt-5.6-luna  LiteLLM $1.00 / $0.10 / $6.00    provider $0.20 / $0.02 / $1.20    5x HIGH
 *
 * Same family, same fetch, one row right and one row 5x out. So "is the catalog
 * fresh?" is not a sufficient question — a specific row can be wrong while its
 * neighbours are perfect. Hence: LiteLLM for breadth, verified provider figures
 * on top for the models actually in use.
 *
 * RULES FOR ADDING AN ENTRY
 *   - Verify against the PROVIDER's own pricing page. Not LiteLLM, not a blog,
 *     not a summary — the vendor's published table.
 *   - Quote the figures verbatim in `providerQuote` and record `source` +
 *     `verifiedOn`, so the next person can re-check rather than re-trust.
 *   - Record what the catalog said in `catalogSaid`. That is what makes the
 *     discrepancy auditable instead of invisible.
 *   - Prices are USD per TOKEN, matching LiteLLM's own units, so entries merge
 *     into the catalog without a unit conversion at the merge site.
 *   - Only override what you verified. Leave a field undefined rather than
 *     inferring it from a ratio — see the cacheWrite note below for why.
 *
 * Standard tier only. Batch / Flex / Priority are separate rate cards and Platos
 * does not currently model tiering; if that changes, this needs a tier key
 * rather than more rows.
 */

/** USD per token, matching the LiteLLM catalog's units. */
export interface VerifiedPrice {
  input?: number;
  output?: number;
  cacheRead?: number;
  cacheWrite?: number;
}

export interface VerifiedPriceEntry extends VerifiedPrice {
  /** Model key as the provider names it (matched against `modelLookupKeys`). */
  model: string;
  source: string;
  verifiedOn: string;
  providerQuote: string;
  /** What the upstream catalog claimed at verification time. */
  catalogSaid?: string;
  notes?: string;
}

export const VERIFIED_PRICES: VerifiedPriceEntry[] = [
  {
    model: "gpt-5.6-luna",
    // $0.20 / 1M  →  0.20 / 1e6
    input: 2e-7,
    // $0.02 / 1M  →  0.1x input. NOT the 0.5x that CACHE_RATES.openai assumed.
    cacheRead: 2e-8,
    // $0.50 / 1M  →  2.5x INPUT. Cache writes on this model cost more than
    // fresh input, which is the opposite of the `openai: { write: 1.0 }`
    // assumption in CACHE_RATES and unlike Anthropic's 1.25x. Worth knowing
    // before assuming more caching is always cheaper here.
    cacheWrite: 5e-7,
    // $1.20 / 1M
    output: 1.2e-6,
    source: "https://developers.openai.com/api/docs/pricing",
    verifiedOn: "2026-07-31",
    providerQuote:
      'gpt-5.6-luna standard: Input "$0.20", Cached input "$0.02", Cache writes "$0.50", Output "$1.20" per 1M tokens',
    catalogSaid:
      "LiteLLM: input 1e-6, output 6e-6, cache_read 1e-7, cache_write 1.25e-6 — input/output/read all 5x high, cache_write 2x high even after correcting the 5x scale error",
    notes:
      "Sibling gpt-5.6-sol was checked at the same time and LiteLLM has it exactly right ($5.00/$0.50/$30.00), so this is a per-row error rather than family-wide staleness.",
  },
];

/** Index by model key for O(1) lookup during a merge. */
const BY_MODEL: ReadonlyMap<string, VerifiedPriceEntry> = new Map(
  VERIFIED_PRICES.map((e) => [e.model, e]),
);

/**
 * Look up a verified override, probing each of the caller's lookup-key variants
 * (`openai:gpt-5.6-luna`, `gpt-5.6-luna`, `openai/gpt-5.6-luna`, …) so the
 * override matches wherever the catalog key would have.
 */
export function verifiedPriceFor(
  lookupKeys: readonly string[],
): VerifiedPriceEntry | null {
  for (const k of lookupKeys) {
    const hit = BY_MODEL.get(k);
    if (hit) return hit;
  }
  return null;
}

/**
 * Merge verified overrides into a catalog entry. Field-level, not row-level:
 * a verified `cacheRead` must not silently blank an `input` we did not verify.
 * Returns a new object; never mutates the catalog.
 */
export function applyVerifiedPrice<
  T extends {
    input_cost_per_token?: number;
    output_cost_per_token?: number;
    cache_read_input_token_cost?: number;
    cache_creation_input_token_cost?: number;
  },
>(entry: T | undefined, verified: VerifiedPriceEntry | null): T | undefined {
  if (!verified) return entry;
  const base = (entry ?? {}) as T;
  return {
    ...base,
    ...(verified.input !== undefined ? { input_cost_per_token: verified.input } : {}),
    ...(verified.output !== undefined ? { output_cost_per_token: verified.output } : {}),
    ...(verified.cacheRead !== undefined
      ? { cache_read_input_token_cost: verified.cacheRead }
      : {}),
    ...(verified.cacheWrite !== undefined
      ? { cache_creation_input_token_cost: verified.cacheWrite }
      : {}),
  };
}
