// Use case: ask a provider which models it currently publishes.
//
// A METADATA-SURFACE PATH, AND FAIL-SOFT BY DESIGN. Every provider-side failure
// — no key, an unroutable plan, an upstream that refuses — yields the empty list
// rather than an error, and the caller unions the empty list under the curated
// one. A provider having a bad afternoon must narrow the model picker, never
// break the page that renders it. The turn path is the opposite and stays
// fail-loud; the two are separate use cases for exactly this reason.
//
// IT NEEDS A RUNTIME GRANT, and the caller may not have one. Reading a provider's
// model list means using that provider's key, which is a material read, which
// `secrets` grants only to the runtime tier. A console request that arrives with
// an operator grant alone therefore gets the curated list and no upstream call —
// which is the correct answer, not a degraded one.
//
// THE NEGATIVE RESULT IS CACHED, BRIEFLY. Caching the empty answer for half a
// minute is what stops a broken upstream from being called once per page load;
// keeping the window short is what lets a recovered upstream reappear without an
// operator waiting out the ten-minute success window.

import { err, ok, type EnvironmentScope, type Result } from "@platos/kernel";

import {
  credentialFingerprint,
  modelListCacheKey,
  NO_RUNTIME_SETTINGS,
  planModelRoute,
  qualifyModel,
  type ProviderManifest,
} from "../domain/index.js";
import type { SecretsRuntimeGrant } from "./authorization.js";
import type { ProvidersDependencies } from "./dependencies.js";
import { runtimeSettingsFor } from "./runtime-settings.js";

const NOTHING: readonly string[] = Object.freeze([]);

export interface DiscoverModelsQuery {
  readonly authorization: SecretsRuntimeGrant;
  readonly scope: EnvironmentScope;
  readonly manifest: ProviderManifest;
}

/**
 * The `<provider>:<model>` strings a provider publishes for this environment.
 *
 * Returns `err` only when the cache itself refused a write — the answer is still
 * correct, but every subsequent call will reach the provider again, which is
 * worth telling the caller about.
 */
export async function discoverModels(
  dependencies: ProvidersDependencies,
  query: DiscoverModelsQuery,
): Promise<Result<readonly string[]>> {
  const { manifest, scope } = query;
  if (manifest.modelList === null) return ok(NOTHING);

  const keys = await dependencies.repository.listProviderKeysFor(scope, manifest.id);
  if (!keys.ok) return ok(NOTHING);
  // The default key first, then any key: discovery is about what the provider
  // offers, and any working credential answers that question.
  const key = keys.value.find((candidate) => candidate.isDefault) ?? keys.value[0];
  if (key === undefined) return ok(NOTHING);

  const cacheKey = modelListCacheKey(manifest.id, credentialFingerprint(key));
  const cached = await dependencies.probeCache.readModelList(cacheKey);
  // An empty array IS a stored answer. Only `null` is a miss.
  if (cached.ok && cached.value !== null) return ok(cached.value);

  const material = await dependencies.secrets.readSecret({
    authorization: query.authorization,
    credentialId: key.credentialId,
    provider: manifest.id,
  });
  if (!material.ok) return ok(NOTHING);

  const settings = await runtimeSettingsFor(dependencies, query.authorization, manifest);
  const plan = planModelRoute(
    dependencies.catalogue,
    qualifyModel(manifest.id, manifest.probeModel),
    settings.ok ? settings.value : NO_RUNTIME_SETTINGS,
  );
  if (!plan.ok) return ok(NOTHING);

  const listed = await dependencies.modelRouter.listModels({
    plan: plan.value,
    endpoint: manifest.modelList,
    credential: { reveal: () => material.value.reveal(), fingerprint: key.providerKeyId },
    timeoutMs: dependencies.policy.modelList.fetchTimeoutMs,
  });

  const models = listed.ok ? listed.value.map((model) => qualifyModel(manifest.id, model)) : NOTHING;
  const seconds = listed.ok
    ? dependencies.policy.modelList.freshSeconds
    : dependencies.policy.modelList.failureSeconds;
  const written = await dependencies.probeCache.writeModelList(
    cacheKey,
    models,
    new Date(dependencies.clock.now().getTime() + seconds * 1000),
  );
  if (!written.ok) return err(written.error);
  return ok(models);
}
