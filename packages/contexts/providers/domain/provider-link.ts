// `EnvironmentProvider` — whether an environment has adopted a provider.
//
// Three independent facts decide whether an environment can actually use a
// provider, and the source keeps them separate for a reason worth restating:
//
//   linked    an operator has adopted this provider here at all.
//   enabled   the adoption is currently switched on.
//   ready     every credential the manifest requires resolves in this scope.
//
// A provider can be linked and disabled (paused), linked and unready (adopted but
// the key was never added), or unlinked and ready (a credential exists that
// nobody has adopted). Collapsing them into one boolean is what makes "why can't
// I pick this model" unanswerable, so the state below reports all three and the
// selection rule names all three.
//
// The row is UNIQUE per [environmentId, providerId]: adopting a provider twice
// is the same adoption.

import type { EnvironmentId } from "@platos/kernel";

import type { EnvironmentProviderId, ProviderId } from "./identifiers.js";
import type { CredentialReadiness, ProviderManifest, ProviderReadiness } from "./manifest.js";

export interface ProviderLink {
  readonly environmentProviderId: EnvironmentProviderId;
  readonly environmentId: EnvironmentId;
  readonly provider: ProviderId;
  readonly enabled: boolean;
  readonly linkedAt: Date;
  readonly updatedAt: Date;
}

/**
 * A provider as an operator sees it: the manifest, this environment's adoption,
 * and the readiness of the credentials it needs.
 */
export interface ProviderState {
  readonly provider: ProviderId;
  readonly displayName: string;
  readonly description: string;
  readonly requiredCredentials: readonly CredentialReadiness[];
  readonly optionalCredentials: readonly string[];
  readonly ready: boolean;
  readonly enabled: boolean;
  readonly linked: boolean;
  readonly linkedAt: Date | null;
  /** The model the liveness call names. Non-secret, manifest-owned. */
  readonly probeModel: string;
  readonly models: readonly string[];
}

export function providerState(
  manifest: ProviderManifest,
  link: ProviderLink | null,
  readiness: ProviderReadiness,
  models: readonly string[],
): ProviderState {
  return {
    provider: manifest.id,
    displayName: manifest.displayName,
    description: manifest.description,
    requiredCredentials: readiness.required,
    optionalCredentials: manifest.optionalCredentials,
    ready: readiness.ready,
    enabled: link?.enabled ?? false,
    linked: link !== null,
    linkedAt: link?.linkedAt ?? null,
    probeModel: manifest.probeModel,
    models,
  };
}

/**
 * Should this provider's live model list be fetched?
 *
 * All four clauses matter. A provider that is not enabled must not be called at
 * all; one whose credentials are not ready would fail the call and cache the
 * failure; one with no published list has nothing to call. Getting this wrong
 * costs an upstream request per provider on every page load.
 */
export function shouldDiscoverModels(manifest: ProviderManifest, state: ProviderState): boolean {
  return manifest.modelList !== null && state.linked && state.enabled && state.ready;
}

/** The providers a turn may actually route to. */
export function usableProviders(states: readonly ProviderState[]): readonly ProviderState[] {
  return states.filter((state) => state.linked && state.enabled && state.ready);
}

export function enable(link: ProviderLink, enabled: boolean, now: Date): ProviderLink {
  return { ...link, enabled, updatedAt: now };
}
