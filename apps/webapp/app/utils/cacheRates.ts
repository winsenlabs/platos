/**
 * PRELAUNCH-A1-2 / A1-8 / A1-9 — provider-aware cache surcharge factors.
 *
 * As of the anomaly-3 follow-up (2026-05-04) the table + helpers live in
 * `@internal/cost-rates` so agent + webapp can't drift. This file is now a
 * thin re-export — kept for back-compat with existing import sites in the
 * webapp.
 */
export {
  CACHE_RATES,
  providerForModel,
  cacheRatesFor,
  cacheDiscountLabel,
} from "@internal/cost-rates";
