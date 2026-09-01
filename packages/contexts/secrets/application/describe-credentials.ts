// The metadata read model. No plaintext, no ciphertext, no key.
//
// Every function here returns `CredentialMetadata`, which is built by enumerating
// what is included rather than by dropping what is excluded (see
// domain/metadata.ts). That is the difference between a projection that is safe
// today and one that stays safe when somebody adds a column.
//
// Metadata is readable by ANY minted environment grant, including a runtime one.
// Knowing that a credential exists, when it was rotated and which root key holds
// it is administrative information; it reveals nothing about the secret.

import { err, ok } from "@platos/kernel";
import type { Result } from "@platos/kernel";

import { requireMetadataAccess, requireRootKeyOperations } from "../domain/access-rules.js";
import type {
  EnvironmentAuthorization,
  RootKeyOperationsAuthorization,
} from "../domain/authorization.js";
import type { CredentialId } from "../domain/ids.js";
import { rootKeyReport } from "../domain/key-ring.js";
import type { RootKeyReport } from "../domain/key-ring.js";
import { toCredentialMetadata } from "../domain/metadata.js";
import type { CredentialMetadata } from "../domain/metadata.js";
import type { SecretsDependencies } from "./dependencies.js";

export interface DescribeCredentialQuery {
  readonly authorization: EnvironmentAuthorization;
  readonly credentialId: CredentialId;
}

export async function describeCredential(
  deps: SecretsDependencies,
  query: DescribeCredentialQuery,
): Promise<Result<CredentialMetadata | null>> {
  const granted = requireMetadataAccess(query.authorization);
  if (!granted.ok) return err(granted.error);

  const found = await deps.repository.findCredential({
    environmentId: granted.value.environmentId,
    credentialId: query.credentialId,
  });
  if (!found.ok) return err(found.error);
  if (found.value === null) return ok(null);
  return ok(toCredentialMetadata(found.value.credential, found.value.activeSecretVersion));
}

export async function listCredentials(
  deps: SecretsDependencies,
  authorization: EnvironmentAuthorization,
): Promise<Result<readonly CredentialMetadata[]>> {
  const granted = requireMetadataAccess(authorization);
  if (!granted.ok) return err(granted.error);

  const rows = await deps.repository.listCredentials(granted.value.environmentId);
  if (!rows.ok) return err(rows.error);
  return ok(
    rows.value.map((row) => toCredentialMetadata(row.credential, row.activeSecretVersion)),
  );
}

/**
 * How far a root key rotation has actually got, across every tenant. Requires the
 * installation-global grant: it is not an environment-scoped question, and no
 * environment operator should be able to ask it.
 */
export async function reportRootKeyUsage(
  deps: SecretsDependencies,
  authorization: RootKeyOperationsAuthorization,
): Promise<Result<RootKeyReport>> {
  const granted = requireRootKeyOperations(authorization);
  if (!granted.ok) return err(granted.error);

  const ring = await deps.keyRing.state();
  if (!ring.ok) return err(ring.error);
  const usage = await deps.repository.countVersionsByRootKey();
  if (!usage.ok) return err(usage.error);
  return ok(rootKeyReport(ring.value, usage.value));
}
