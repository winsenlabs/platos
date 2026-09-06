// Use cases: the provider registry an operator manages.
//
// Reading the registry assembles three facts that are stored three different
// ways: the manifest (a catalogue constant), the adoption (a row this context
// owns), and readiness (a question only the vault can answer). The assembly is
// the whole point — a surface showing any one of them alone cannot tell an
// operator WHY a provider is unusable.
//
// TWO GRANTS, AND THE SECOND ONE IS OPTIONAL. This is where the extraction
// found a privilege seam that was invisible in the source and is explicit here.
//
//   `authorization` is tenancy's operator grant. It authorizes the console
//   action and it is enough for everything on this page that is METADATA:
//   which providers exist, which are adopted, and which required credentials
//   are present. None of that decrypts anything.
//
//   `runtimeAuthorization` is the vault's runtime grant, and it is what a LIVE
//   MODEL LIST needs, because fetching one means using the provider's key.
//   `secrets` grants material reads to the runtime tier ONLY — "operators
//   administer the vault; they do not read out of it" — so this context does not
//   derive a runtime grant from an operator one. It accepts one when the
//   composition root, which holds identity-access, chose to mint one.
//
// Absent the second grant the page renders the curated model list and makes no
// upstream call. That is a correct answer, not a degraded one, and it is the
// answer that fails safe.

import { err, ok, type Result } from "@platos/kernel";
import type { CredentialMetadata } from "@platos/context-secrets";

import {
  asProvidersIdentifier,
  enable,
  mergeModelLists,
  providerState,
  readiness,
  requireManifest,
  shouldDiscoverModels,
  usableProviders,
  type EnvironmentProviderId,
  type ProviderLink,
  type ProviderManifest,
  type ProviderState,
} from "../domain/index.js";
import {
  requireAccess,
  vaultGrantFor,
  verifyOperator,
  type SecretsRuntimeGrant,
  type TenancyOperatorGrant,
} from "./authorization.js";
import type { ProvidersDependencies } from "./dependencies.js";
import { evictProbeCache } from "./evict-probe-cache.js";
import { discoverModels } from "./discover-models.js";

export interface DescribeProvidersQuery {
  /** A grant minted by `tenancy`. Its scope is the only environment it reaches. */
  readonly authorization: unknown;
  /**
   * Minted by the composition root when this caller may also read material.
   * Absent means the live model list is not fetched. See the note above.
   */
  readonly runtimeAuthorization?: SecretsRuntimeGrant | null;
}

export interface DescribeProviderQuery extends DescribeProvidersQuery {
  readonly provider: string;
}

export interface SetProviderAdoptionCommand extends DescribeProvidersQuery {
  readonly provider: string;
  readonly enabled: boolean;
}

/**
 * Which of a provider's required credentials this environment holds.
 *
 * Takes the environment's credentials as a LIST rather than fetching them,
 * because a fourteen-provider page would otherwise ask the vault for the same
 * answer fourteen times. The source has the same shape of loop and the same
 * cost; hoisting the read is the one behaviour-preserving improvement made to
 * this path.
 */
function credentialPresence(
  credentials: readonly CredentialMetadata[],
  manifest: ProviderManifest,
): Record<string, boolean> {
  const present: Record<string, boolean> = {};
  for (const name of manifest.requiredCredentials) {
    present[name] = credentials.some(
      (credential) =>
        credential.name === name &&
        credential.provider === manifest.id &&
        credential.revokedAt === null &&
        credential.activeSecretVersion !== null,
    );
  }
  return present;
}

async function stateFor(
  dependencies: ProvidersDependencies,
  query: DescribeProvidersQuery,
  grant: TenancyOperatorGrant,
  credentials: readonly CredentialMetadata[],
  manifest: ProviderManifest,
  link: ProviderLink | null,
): Promise<Result<ProviderState>> {
  const keys = await dependencies.repository.listProviderKeysFor(grant.scope, manifest.id);
  if (!keys.ok) return err(keys.error);

  // Two independent ways the API-key slot can be satisfied, exactly as the
  // source has it: a credential filed under the bare name, or a ProviderKey
  // pointing at one. Both are metadata reads; neither decrypts anything.
  const ready = readiness(manifest, credentialPresence(credentials, manifest), keys.value.length > 0);
  const base = providerState(manifest, link, ready, manifest.models);

  const runtime = query.runtimeAuthorization ?? null;
  if (runtime === null || !shouldDiscoverModels(manifest, base)) return ok(base);

  const live = await discoverModels(dependencies, {
    authorization: runtime,
    scope: grant.scope,
    manifest,
  });
  // A discovery failure narrows the picker; it never fails the page.
  if (!live.ok) return ok(base);
  return ok({ ...base, models: mergeModelLists(manifest.models, live.value) });
}

export async function describeProviders(
  dependencies: ProvidersDependencies,
  query: DescribeProvidersQuery,
): Promise<Result<readonly ProviderState[]>> {
  const granted = verifyOperator(dependencies, query.authorization);
  if (!granted.ok) return err(granted.error);

  const links = await dependencies.repository.listProviderLinks(granted.value.scope);
  if (!links.ok) return err(links.error);
  const byProvider = new Map<string, ProviderLink>(links.value.map((link) => [link.provider, link]));

  // Read once, for every provider on the page.
  const credentials = await dependencies.secrets.listCredentials(vaultGrantFor(granted.value));
  if (!credentials.ok) return err(credentials.error);

  const states: ProviderState[] = [];
  for (const manifest of dependencies.catalogue) {
    const state = await stateFor(
      dependencies,
      query,
      granted.value,
      credentials.value,
      manifest,
      byProvider.get(manifest.id) ?? null,
    );
    if (!state.ok) return err(state.error);
    states.push(state.value);
  }
  return ok(states);
}

export async function describeProvider(
  dependencies: ProvidersDependencies,
  query: DescribeProviderQuery,
): Promise<Result<ProviderState>> {
  const granted = verifyOperator(dependencies, query.authorization);
  if (!granted.ok) return err(granted.error);
  const manifest = requireManifest(dependencies.catalogue, query.provider);
  if (!manifest.ok) return err(manifest.error);

  const link = await dependencies.repository.findProviderLink(granted.value.scope, manifest.value.id);
  if (!link.ok) return err(link.error);
  const credentials = await dependencies.secrets.listCredentials(vaultGrantFor(granted.value));
  if (!credentials.ok) return err(credentials.error);
  return stateFor(dependencies, query, granted.value, credentials.value, manifest.value, link.value);
}

/**
 * Adopt a provider, or switch an adoption on or off.
 *
 * One use case rather than two, because the source's `link` and `setEnabled` run
 * the same upsert with a different flag and differ only in which one a surface
 * calls. Adopting is `enabled: true` on a provider that has no row yet.
 */
export async function setProviderAdoption(
  dependencies: ProvidersDependencies,
  command: SetProviderAdoptionCommand,
): Promise<Result<ProviderState>> {
  const verified = verifyOperator(dependencies, command.authorization);
  if (!verified.ok) return err(verified.error);
  const granted = requireAccess(verified.value, "secret:mutate");
  if (!granted.ok) return err(granted.error);
  const manifest = requireManifest(dependencies.catalogue, command.provider);
  if (!manifest.ok) return err(manifest.error);

  const scope = granted.value.scope;
  const existing = await dependencies.repository.findProviderLink(scope, manifest.value.id);
  if (!existing.ok) return err(existing.error);

  const now = dependencies.clock.now();
  const link: ProviderLink =
    existing.value === null
      ? {
          environmentProviderId: asProvidersIdentifier<EnvironmentProviderId>(dependencies.ids.uuid()),
          environmentId: scope.environmentId,
          provider: manifest.value.id,
          enabled: command.enabled,
          linkedAt: now,
          updatedAt: now,
        }
      : enable(existing.value, command.enabled, now);

  const written = await dependencies.unitOfWork.run((transaction) =>
    dependencies.repository.upsertProviderLink(link, transaction),
  );
  if (!written.ok) return err(written.error);
  const credentials = await dependencies.secrets.listCredentials(vaultGrantFor(granted.value));
  if (!credentials.ok) return err(credentials.error);
  return stateFor(dependencies, command, granted.value, credentials.value, manifest.value, written.value);
}

export async function unlinkProvider(
  dependencies: ProvidersDependencies,
  query: DescribeProviderQuery,
): Promise<Result<boolean>> {
  const verified = verifyOperator(dependencies, query.authorization);
  if (!verified.ok) return err(verified.error);
  const granted = requireAccess(verified.value, "secret:mutate");
  if (!granted.ok) return err(granted.error);
  const manifest = requireManifest(dependencies.catalogue, query.provider);
  if (!manifest.ok) return err(manifest.error);

  const removed = await dependencies.unitOfWork.run((transaction) =>
    dependencies.repository.deleteProviderLink(granted.value.scope, manifest.value.id, transaction),
  );
  if (!removed.ok) return err(removed.error);
  // WIN-259 M2.4. Unlinking removes the provider's configuration, so every
  // cached verdict about it now describes a link that is gone. Same class as a
  // rotation and a deletion, same refusal.
  return evictProbeCache(dependencies, manifest.value.id, removed.value);
}

/** The providers a turn in this environment may actually route to. */
export async function listUsableProviders(
  dependencies: ProvidersDependencies,
  query: DescribeProvidersQuery,
): Promise<Result<readonly ProviderState[]>> {
  const states = await describeProviders(dependencies, query);
  if (!states.ok) return err(states.error);
  return ok(usableProviders(states.value));
}
