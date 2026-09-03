// The `ProviderProbeCache` port — a short-lived memo of what a provider said.
//
// WHY THIS PORT EXISTS, STATED AS A FINDING RATHER THAN ABSORBED. ADR M0.3 §13
// publishes an "exhaustive" map of adapter-facing ports to owning contexts, and
// assigns the general-purpose `Cache` to `memory`. `providers` may not import
// `memory` — its §1 row 4 allow-list is `tenancy`, `secrets`, `kernel` — so it
// cannot reach that port, and the behaviour it needs is real: the running system
// caches a liveness result for five minutes and a model list for ten, and
// without that every page load calls every configured provider.
//
// §13's own stated principle resolves it: "an adapter-facing port belongs to the
// context whose capability it serves." This is that port, owned here. It is
// recorded as a gap in the §13 map rather than as a correction to it, because
// that ADR is accepted and frozen and a change to it lands as a new ADR.
//
// THE PORT IS DELIBERATELY DUMB. It stores and returns values against a key and
// an expiry instant, and knows nothing about freshness policy — that lives in
// `domain/health.ts`, where it is a rule a test can exercise at an instant. An
// implementation that quietly applied a TTL of its own would make the domain's
// answer and the store's answer disagree.
//
// AN ABSENT ENTRY IS `ok(null)`, NOT AN ERROR. A cache miss is the ordinary case.
// A store that is unreachable IS an error, and the caller's correct response to
// one is to call the provider rather than to fail the page — which it can only
// decide if the two are distinguishable.

import type { Result } from "@platos/kernel";

import type { ProviderHealthReport, ProviderId } from "../../domain/index.js";

export interface ProviderProbeCache {
  /** The stored liveness result for this key, or null when there is none. */
  readHealth(key: string): Promise<Result<ProviderHealthReport | null>>;

  /** Store a liveness result until `expiresAt`. Overwrites any earlier one. */
  writeHealth(key: string, report: ProviderHealthReport, expiresAt: Date): Promise<Result<void>>;

  /**
   * The stored model list for this key, or null when there is none.
   *
   * An EMPTY ARRAY is a stored answer and not a miss: caching the empty result
   * of a failed fetch briefly is what stops a broken upstream from being called
   * once per page load, and an implementation that returned `null` for it would
   * defeat that entirely.
   */
  readModelList(key: string): Promise<Result<readonly string[] | null>>;

  writeModelList(key: string, models: readonly string[], expiresAt: Date): Promise<Result<void>>;

  /**
   * Drop every entry for one provider, whatever credential it was keyed by.
   *
   * Called when a key is added, rotated or removed. The credential fingerprint
   * already invalidates a rotated key's own entries, but adding the FIRST key
   * for a provider changes an answer that was cached under no key at all, and
   * removing one changes what the remaining keys can reach.
   */
  forgetProvider(provider: ProviderId): Promise<Result<void>>;
}
