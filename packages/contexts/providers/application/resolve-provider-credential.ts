// Use case: resolve the credential a turn will spend against.
//
// This is the hot path and the one with the most careful failure model in the
// whole context. It is transcribed, clause for clause, from the running
// resolution, because every clause is a defect someone already fixed:
//
//   A SUPPLIED PIN THAT DOES NOT RESOLVE FAILS CLOSED. An agent version naming a
//   specific key, whose key is absent, is the wrong provider's, or belongs to
//   another environment, is a CONFIGURATION FAILURE. It must never fall back to
//   the environment default, because the whole reason to pin a key is that the
//   default is the wrong one to spend.
//
//   AN ABSENT DEFAULT IS NOT A FAILURE. No pin and no default key means the
//   environment has not registered one, which callers treat as "not configured".
//   It returns null, and the caller decides.
//
//   NOTHING WIDENS TO AN AMBIENT CREDENTIAL. There is no fallback to a process
//   variable, an installation-wide key, or a conventionally-named credential.
//   Resolution is environment-owned material or nothing — a provider SDK's own
//   environment discovery would silently charge one tenant's work to another's
//   account, which is the failure this whole path exists to make impossible.
//
//   THE USAGE STAMP IS NOT PART OF THE ANSWER. `lastUsedAt` is written outside
//   any transaction and its failure is not reported: a bookkeeping write must not
//   be able to fail a turn that resolved correctly.

import { err, ok, type EnvironmentScope, type Result } from "@platos/kernel";
import type { SecretMaterial } from "@platos/context-secrets";

import {
  configurationUnavailable,
  findDefault,
  providerCredentialUnavailable,
  type ProviderId,
  type ProviderKey,
  type ProviderKeyId,
} from "../domain/index.js";
import { runtimeScope, verifyRuntimeGrant, type SecretsRuntimeGrant } from "./authorization.js";
import type { ProvidersDependencies } from "./dependencies.js";
import type { ProviderCredential } from "./ports/index.js";

export interface ResolveProviderCredentialQuery {
  /** Minted by the composition root; `tenancy` publishes no runtime grant yet. */
  readonly authorization: SecretsRuntimeGrant;
  /** Cross-checked against the grant's own ancestry. */
  readonly scope: EnvironmentScope;
  readonly provider: ProviderId;
  /** An agent version's pinned key. Absent means "use the default". */
  readonly providerKeyId?: ProviderKeyId | null;
}

export interface ResolvedProviderCredential {
  readonly key: ProviderKey;
  readonly credential: ProviderCredential;
}

async function selectKey(
  dependencies: ProvidersDependencies,
  query: ResolveProviderCredentialQuery,
): Promise<Result<ProviderKey | null>> {
  const held = await dependencies.repository.listProviderKeysFor(query.scope, query.provider);
  if (!held.ok) return err(held.error);

  const pinned = query.providerKeyId ?? null;
  if (pinned === null) return ok(findDefault(held.value, query.provider));

  const found = held.value.find((key) => key.providerKeyId === pinned) ?? null;
  if (found === null) {
    return err(
      configurationUnavailable("pinned provider key is absent for this provider in this environment", {
        provider: query.provider,
        environmentId: query.scope.environmentId,
        providerKeyId: pinned,
      }),
    );
  }
  return ok(found);
}

/**
 * Turn revealed material into a value the `ModelRouter` can use.
 *
 * The fingerprint is what cache keys are built from, and it MUST NOT be
 * derivable back into the material. It is supplied by the caller's hasher rather
 * than computed here, because `domain/` and `application/` hold no cryptography
 * and a digest computed in a pure layer would be one this package had to
 * implement itself.
 */
export function providerCredentialFrom(
  material: SecretMaterial,
  fingerprint: string,
): ProviderCredential {
  return { reveal: () => material.reveal(), fingerprint };
}

/**
 * Resolve the key and read its material.
 *
 * Returns `ok(null)` when the environment has registered nothing for this
 * provider — the "not configured" outcome, which is not an error.
 */
export async function resolveProviderCredential(
  dependencies: ProvidersDependencies,
  query: ResolveProviderCredentialQuery,
): Promise<Result<ResolvedProviderCredential | null>> {
  const granted = verifyRuntimeGrant(query.authorization, query.scope);
  if (!granted.ok) return err(granted.error);

  const selected = await selectKey(dependencies, query);
  if (!selected.ok) return err(selected.error);
  if (selected.value === null) return ok(null);

  const key = selected.value;
  // `key.credentialId` passes across the boundary uncast. This context brands it
  // with the SAME tag `secrets` uses (`domain/identifiers.ts`), so the two are
  // one type — a deliberate property, and one the compiler checks here.
  const material = await dependencies.secrets.readSecret({
    authorization: granted.value,
    credentialId: key.credentialId,
    provider: key.provider,
  });
  if (!material.ok) {
    return err(
      providerCredentialUnavailable("provider key resolved but its credential could not be read", {
        provider: key.provider,
        environmentId: query.scope.environmentId,
        providerKeyId: key.providerKeyId,
      }),
    );
  }

  await dependencies.repository.touchProviderKey(key.providerKeyId, dependencies.clock.now());
  return ok({
    key,
    credential: providerCredentialFrom(material.value, fingerprintOf(key)),
  });
}

/**
 * What identifies a credential for caching purposes.
 *
 * The ProviderKey id plus the vault's own revision would be ideal; the published
 * metadata this path holds is the key id, which changes when a key is replaced
 * and is stable while it is not. Rotation is handled by `forgetProvider`, which
 * every mutation calls, so the two together cover both.
 */
function fingerprintOf(key: ProviderKey): string {
  return `${key.providerKeyId}`;
}

/** Whether this environment has a usable key for a provider, without reading it. */
export async function hasProviderCredential(
  dependencies: ProvidersDependencies,
  scope: EnvironmentScope,
  provider: ProviderId,
): Promise<Result<boolean>> {
  const held = await dependencies.repository.listProviderKeysFor(scope, provider);
  if (!held.ok) return err(held.error);
  return ok(held.value.length > 0);
}

/** The environment a runtime grant covers, for a caller that holds only the grant. */
export { runtimeScope };
