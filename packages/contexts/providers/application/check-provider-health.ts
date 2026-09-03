// Use case: is this provider's credential actually accepted?
//
// This is the capability ADR M0.3 §3 moves out of `auth` — the four
// `provider-health.service` files that made `auth → providers` a wrong-way edge.
// Here it is intra-context and the edge is gone.
//
// IT NEEDS A RUNTIME GRANT, NOT AN OPERATOR ONE. Probing means using the
// provider's key, which is a material read, which `secrets` grants only to the
// runtime tier. The composition root mints one for a console request that is
// entitled to it; this context does not derive one from an operator grant,
// because that would make every console session able to read out of the vault.
//
// THE CACHE IS CONSULTED ONLY AFTER READINESS IS ESTABLISHED, and that ordering
// is transcribed from the source. An unconfigured provider is answered without a
// call and without a lookup, so adding a key produces a fresh answer immediately
// rather than one served from a window opened before the key existed.
//
// A REFUSAL IS AN OUTCOME, NOT A FAILURE. The provider answering "no" is a
// successful check that reports `invalid_key`, and it is cached like any other
// result — briefly, so a fixed key is re-checked within a minute.

import { err, ok, type EnvironmentScope, type Result } from "@platos/kernel";

import {
  expiresAt,
  findManifest,
  healthCacheKey,
  isFresh,
  NO_RUNTIME_SETTINGS,
  notConfigured,
  planModelRoute,
  qualifyModel,
  readiness,
  statusForFailure,
  unknownProviderReport,
  asProvidersIdentifier,
  type ProviderHealthReport,
  type ProviderId,
  type ProviderKey,
  type ProviderManifest,
} from "../domain/index.js";
import type { SecretsRuntimeGrant } from "./authorization.js";
import { verifyRuntimeGrant } from "./authorization.js";
import type { ProvidersDependencies } from "./dependencies.js";
import { runtimeSettingsFor } from "./runtime-settings.js";

export interface CheckProviderHealthQuery {
  readonly authorization: SecretsRuntimeGrant;
  readonly scope: EnvironmentScope;
  readonly provider: string;
}

export interface CheckAllProvidersHealthQuery {
  readonly authorization: SecretsRuntimeGrant;
  readonly scope: EnvironmentScope;
}

async function readinessOf(
  dependencies: ProvidersDependencies,
  grant: SecretsRuntimeGrant,
  manifest: ProviderManifest,
  keys: readonly ProviderKey[],
): Promise<Result<ReturnType<typeof readiness>>> {
  const named = await dependencies.secrets.listCredentials(grant);
  if (!named.ok) return err(named.error);
  const present: Record<string, boolean> = {};
  for (const name of manifest.requiredCredentials) {
    present[name] = named.value.some(
      (credential) =>
        credential.name === name &&
        credential.provider === manifest.id &&
        credential.revokedAt === null &&
        credential.activeSecretVersion !== null,
    );
  }
  return ok(readiness(manifest, present, keys.length > 0));
}

async function probe(
  dependencies: ProvidersDependencies,
  query: CheckProviderHealthQuery,
  manifest: ProviderManifest,
  key: ProviderKey,
  required: ReturnType<typeof readiness>["required"],
): Promise<Result<ProviderHealthReport>> {
  const startedAt = dependencies.clock.now();
  const material = await dependencies.secrets.readSecret({
    authorization: query.authorization,
    credentialId: key.credentialId,
    provider: manifest.id,
  });
  if (!material.ok) {
    return ok(failed(manifest.id, "probe_not_configurable", required, startedAt, startedAt));
  }

  const settings = await runtimeSettingsFor(dependencies, query.authorization, manifest);
  const plan = planModelRoute(
    dependencies.catalogue,
    qualifyModel(manifest.id, manifest.probeModel),
    settings.ok ? settings.value : NO_RUNTIME_SETTINGS,
  );
  if (!plan.ok) {
    // An unroutable plan is a configuration problem — a missing per-resource
    // root, say — and never a verdict on the key.
    return ok(failed(manifest.id, "probe_not_configurable", required, startedAt, dependencies.clock.now()));
  }

  const outcome = await dependencies.modelRouter.probe({
    plan: plan.value,
    credential: { reveal: () => material.value.reveal(), fingerprint: key.providerKeyId },
    timeoutMs: dependencies.policy.health.probeTimeoutMs,
  });
  const finishedAt = dependencies.clock.now();
  if (!outcome.ok) {
    return ok(failed(manifest.id, "request_failed", required, startedAt, finishedAt));
  }
  if (outcome.value.failure !== null) {
    return ok(
      failed(manifest.id, outcome.value.failure, required, startedAt, finishedAt, outcome.value.model),
    );
  }
  return ok({
    provider: manifest.id,
    status: "healthy",
    latencyMs: finishedAt.getTime() - startedAt.getTime(),
    failure: null,
    model: outcome.value.model,
    requiredCredentials: required,
    checkedAt: finishedAt,
  });
}

function failed(
  provider: ProviderId,
  failure: Parameters<typeof statusForFailure>[0],
  required: ReturnType<typeof readiness>["required"],
  startedAt: Date,
  finishedAt: Date,
  model: string | null = null,
): ProviderHealthReport {
  return {
    provider,
    status: statusForFailure(failure),
    latencyMs: finishedAt.getTime() - startedAt.getTime(),
    failure,
    model,
    requiredCredentials: required,
    checkedAt: finishedAt,
  };
}

export async function checkProviderHealth(
  dependencies: ProvidersDependencies,
  query: CheckProviderHealthQuery,
): Promise<Result<ProviderHealthReport>> {
  const granted = verifyRuntimeGrant(query.authorization, query.scope);
  if (!granted.ok) return err(granted.error);

  const manifest = findManifest(dependencies.catalogue, query.provider);
  if (manifest === null) {
    return ok(
      unknownProviderReport(asProvidersIdentifier<ProviderId>(query.provider), dependencies.clock.now()),
    );
  }

  const keys = await dependencies.repository.listProviderKeysFor(query.scope, manifest.id);
  if (!keys.ok) return err(keys.error);
  const ready = await readinessOf(dependencies, granted.value, manifest, keys.value);
  if (!ready.ok) return err(ready.error);
  if (!ready.value.ready) {
    return ok(notConfigured(manifest.id, ready.value.required, dependencies.clock.now()));
  }

  const key = keys.value.find((candidate) => candidate.isDefault) ?? keys.value[0];
  if (key === undefined) {
    return ok(notConfigured(manifest.id, ready.value.required, dependencies.clock.now()));
  }

  const cacheKey = healthCacheKey(manifest.id, key.providerKeyId);
  const cached = await dependencies.probeCache.readHealth(cacheKey);
  if (cached.ok && cached.value !== null) {
    if (isFresh(cached.value, dependencies.policy.health, dependencies.clock.now())) {
      return ok(cached.value);
    }
  }

  const report = await probe(dependencies, query, manifest, key, ready.value.required);
  if (!report.ok) return err(report.error);
  const written = await dependencies.probeCache.writeHealth(
    cacheKey,
    report.value,
    expiresAt(report.value, dependencies.policy.health),
  );
  if (!written.ok) return err(written.error);
  return ok(report.value);
}

/** Every provider in the catalogue, checked in catalogue order. */
export async function checkAllProvidersHealth(
  dependencies: ProvidersDependencies,
  query: CheckAllProvidersHealthQuery,
): Promise<Result<readonly ProviderHealthReport[]>> {
  const reports: ProviderHealthReport[] = [];
  for (const manifest of dependencies.catalogue) {
    const report = await checkProviderHealth(dependencies, { ...query, provider: manifest.id });
    if (!report.ok) return err(report.error);
    reports.push(report.value);
  }
  return ok(reports);
}
