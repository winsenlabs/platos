// Where this context meets the credential vault.
//
// `secrets` publishes no "find a credential by name", and deliberately so: its
// contract is a vault, not a query surface. What it does publish is
// `listCredentials`, and the lookup this context needs is a filter over that.
// Keeping the filter here — once — is what stops four call sites from each
// deciding privately what "usable" means.
//
// USABLE MEANS EXACTLY WHAT THE RUNNING SYSTEM MEANS BY IT: the credential
// belongs to this provider, has not been revoked, and still points at an active
// envelope. It deliberately does NOT consider `expiresAt`, because the provider
// path in the source does not: a provider credential's expiry is the provider's
// business, and refusing one here would take an environment offline for a date
// nobody in this system set.

import { err, ok, type Result } from "@platos/kernel";

import type { CredentialMetadata } from "@platos/context-secrets";

import { credentialUnavailable, type ProviderId } from "../domain/index.js";
import type { SecretsOperatorGrant } from "./authorization.js";
import type { ProvidersDependencies } from "./dependencies.js";

/** The kind a provider API key is stored as. */
export const PROVIDER_CREDENTIAL_KIND = "SERVICE_CREDENTIAL" as const;

export function isUsableFor(credential: CredentialMetadata, provider: ProviderId): boolean {
  return (
    credential.provider === provider &&
    credential.revokedAt === null &&
    credential.activeSecretVersion !== null
  );
}

/** The usable credential of this name for this provider, or null. */
export async function findProviderCredential(
  dependencies: ProvidersDependencies,
  grant: SecretsOperatorGrant,
  name: string,
  provider: ProviderId,
): Promise<Result<CredentialMetadata | null>> {
  const listed = await dependencies.secrets.listCredentials(grant);
  if (!listed.ok) return err(listed.error);
  return ok(listed.value.find((credential) => credential.name === name && isUsableFor(credential, provider)) ?? null);
}

/** The same lookup, refusing rather than returning null. */
export async function requireProviderCredential(
  dependencies: ProvidersDependencies,
  grant: SecretsOperatorGrant,
  name: string,
  provider: ProviderId,
): Promise<Result<CredentialMetadata>> {
  const found = await findProviderCredential(dependencies, grant, name, provider);
  if (!found.ok) return err(found.error);
  if (found.value === null) return err(credentialUnavailable(name, provider));
  return ok(found.value);
}

/**
 * Any credential of this name, whatever its state.
 *
 * Used only by the register path, which must tell "no credential of this name"
 * (create one) from "a credential of this name that this provider may not use"
 * (refuse). Collapsing those two would let registering a key for one provider
 * silently overwrite another provider's credential of the same name.
 */
export async function findCredentialByName(
  dependencies: ProvidersDependencies,
  grant: SecretsOperatorGrant,
  name: string,
): Promise<Result<CredentialMetadata | null>> {
  const listed = await dependencies.secrets.listCredentials(grant);
  if (!listed.ok) return err(listed.error);
  return ok(
    listed.value.find(
      (credential) => credential.name === name && credential.kind === PROVIDER_CREDENTIAL_KIND,
    ) ?? null,
  );
}
