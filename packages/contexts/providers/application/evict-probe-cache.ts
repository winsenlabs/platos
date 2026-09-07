// One place every write that changes a provider's material drops its cached
// verdict — and one place that failure stops being silent.
//
// WIN-259 M2.4. Six call sites across five files already called
// `probeCache.forgetProvider(...)` after registering, linking, rotating,
// relinking or deleting a key, and every one of them was written
//
//     await dependencies.probeCache.forgetProvider(key.value.provider);
//     return ok(written.value);
//
// The port returns `Promise<Result<void>>`. The `Result` was discarded at all
// six. So an eviction that failed — the cache unreachable, the keyspace refusing
// a write, the connection dropped mid-call — was indistinguishable from one that
// succeeded, and the operation reported success either way.
//
// WHAT THAT COST. `check-provider-health.ts` serves a cached verdict for as long
// as the health policy's window (five minutes for `healthy`, one for anything
// else) without re-probing. A key rotated because it LEAKED therefore kept
// answering `healthy`, on the strength of a probe made against the material that
// leaked, to every console request in that window. `domain/health.ts` says a
// rotation "invalidates the answer by construction rather than by remembering
// to" — and until this issue the construction was not there either, because the
// cache key was the row identifier and a rotation does not change it.
//
// BOTH HALVES ARE FIXED, AND THE ORDER MATTERS. `credentialFingerprint` now
// makes the invalidation STRUCTURAL: a rotated key addresses a different cache
// key, so the stale entry is unreachable whether or not this eviction ran. This
// module is the second line, for the case the fingerprint cannot cover — the
// port's own header names it: "adding the FIRST key for a provider changes an
// answer that was cached under no key at all". A security property must not rest
// on a best-effort side effect, so the structural fix leads and this one is
// belt-and-braces that is nonetheless no longer silent.

import { err, ok } from "@platos/kernel";
import type { Result } from "@platos/kernel";

import { probeCacheNotEvicted } from "../domain/index.js";
import type { ProviderId } from "../domain/index.js";
import type { ProvidersDependencies } from "./dependencies.js";

/**
 * Drop every cached probe for one provider, or refuse.
 *
 * THE VALUE IS PASSED THROUGH rather than returned as `void`, so a caller reads
 *
 *     return evictProbeCache(dependencies, provider, written.value);
 *
 * and cannot write the `await`-and-discard line this module exists to delete.
 * A helper returning `Result<void>` would have left `await evict(...)` on its own
 * a legal statement, which is exactly the shape of the defect.
 */
export async function evictProbeCache<Value>(
  dependencies: ProvidersDependencies,
  provider: ProviderId,
  value: Value,
): Promise<Result<Value>> {
  const evicted = await dependencies.probeCache.forgetProvider(provider);
  if (evicted.ok) return ok(value);
  // The LONGER of the two windows. A caller told to retry after one minute when
  // a `healthy` verdict is servable for five has been told a number that does
  // not clear the staleness it was warned about.
  const window = Math.max(
    dependencies.policy.health.healthySeconds,
    dependencies.policy.health.unhealthySeconds,
  );
  return err(probeCacheNotEvicted(provider, window));
}
