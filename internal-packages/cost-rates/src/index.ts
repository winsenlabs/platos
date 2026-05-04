/**
 * @internal/cost-rates — provider-aware cache surcharge factors.
 *
 * PRELAUNCH-A1-2 / A1-8 / A1-9 (anomaly 3 follow-up 2026-05-04):
 * single source of truth for the cache rate table previously duplicated
 * between `apps/agent/src/monitoring/cost.service.ts` and
 * `apps/webapp/app/utils/cacheRates.ts`. Both consumers now import from
 * here; the parallel files re-export for backwards compatibility.
 *
 * Each entry is `{ write, read }` expressed as a fraction of the model's
 * fresh-input rate. Multiply that rate by `write` (or `read`) to get the
 * per-token cost for a cache-write (or cache-read) token of that provider.
 *
 *   - Anthropic: write 1.25 (25% premium), read 0.10 (90% discount).
 *   - OpenAI:    write 1.00 (no premium),  read 0.50 (50% discount).
 *   - Google:    write 1.00 (no premium),  read 0.25 (75% discount, 2.5-series).
 *
 * `google-vertex` aliases to `google` since Vertex hosting passes Gemini
 * billing through unchanged. Unknown providers fall back to Anthropic
 * factors — the historical default that all callers used before
 * provider-aware billing landed.
 */
export const CACHE_RATES: Record<string, { write: number; read: number }> = {
  anthropic: { write: 1.25, read: 0.1 },
  openai: { write: 1.0, read: 0.5 },
  google: { write: 1.0, read: 0.25 },
  "google-vertex": { write: 1.0, read: 0.25 },
};

const ANTHROPIC_FALLBACK_RATES = CACHE_RATES.anthropic!;

/**
 * Extract the provider segment from a model string ("anthropic:claude-…" → "anthropic").
 * Returns null for bare model strings (no colon) or empty/null inputs.
 */
export function providerForModel(model: string | null | undefined): string | null {
  if (!model) return null;
  const idx = model.indexOf(":");
  if (idx <= 0) return null;
  return model.slice(0, idx);
}

/**
 * Resolve the cache rate row for a provider id (or model string). Returns
 * the Anthropic defaults when the provider isn't in the table — preserves
 * historical behaviour for unrecognised providers.
 */
export function cacheRatesFor(
  providerOrModel: string | null | undefined,
): { write: number; read: number } {
  if (!providerOrModel) return ANTHROPIC_FALLBACK_RATES;
  const provider = providerOrModel.includes(":")
    ? providerForModel(providerOrModel)
    : providerOrModel;
  if (!provider) return ANTHROPIC_FALLBACK_RATES;
  return CACHE_RATES[provider] ?? ANTHROPIC_FALLBACK_RATES;
}

/**
 * Human-readable cache-discount label.
 *   - Anthropic → "90% off"
 *   - OpenAI    → "50% off"
 *   - Google    → "75% off"
 * Anything unknown returns the Anthropic fallback so existing UI strings
 * keep working without a copy-edit.
 */
export function cacheDiscountLabel(providerOrModel: string | null | undefined): string {
  const rates = cacheRatesFor(providerOrModel);
  const pct = Math.round((1 - rates.read) * 100);
  return `${pct}% off`;
}
