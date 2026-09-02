// Use cases: change what is behind a provider key.
//
// Two different operations that are easy to confuse and must not be:
//
//   ROTATE  the key keeps pointing at the same credential; the MATERIAL behind
//           that credential changes. Every other key pointing at it changes too,
//           which is the point — one credential, one secret.
//   RELINK  the material is untouched; the key is pointed at a DIFFERENT
//           credential of the same provider. Nothing is decrypted and nothing is
//           written to the vault.
//
// Giving them one name would make "rotate the key" ambiguous between "replace
// the secret" and "use a different secret", which are opposite answers to "is
// the old material still valid".

import { asIdentifier, err, ok, type Result } from "@platos/kernel";

import {
  admitProviderSecret,
  asProvidersIdentifier,
  credentialUnavailable,
  providerKeyNotFound,
  relink,
  type CredentialId,
  type CredentialName,
  type ProviderKey,
  type ProviderKeyId,
} from "../domain/index.js";
import { requireAccess, vaultGrantFor, verifyOperator, type TenancyOperatorGrant } from "./authorization.js";
import type { ProvidersDependencies } from "./dependencies.js";
import { assertLabelIsFree, saveProviderKey } from "./provider-key-store.js";
import { isUsableFor, requireProviderCredential } from "./vault.js";

export interface RotateProviderKeySecretCommand {
  readonly authorization: unknown;
  readonly providerKeyId: ProviderKeyId;
  readonly plaintext: unknown;
}

export interface RelinkProviderKeyCommand {
  readonly authorization: unknown;
  readonly providerKeyId: ProviderKeyId;
  /** The bare name of the credential to point at instead. */
  readonly credentialName: string;
  /** Optional rename, applied in the same write. */
  readonly label?: string;
}

export interface RelinkedProviderKey {
  readonly key: ProviderKey;
  /**
   * What the key pointed at before.
   *
   * RETURNED RATHER THAN AUDITED, AND THAT IS A GAP WORTH NAMING. The extraction
   * source writes a `CredentialAudit` row with action `PROVIDER_KEY_RELINK` in
   * the same transaction as this change. `CredentialAudit` is a `secrets`
   * sole-writer row (ADR M0.3 §1 row 3) and that context's published contract
   * offers no way to append one, so this context cannot write it without
   * violating single-writer. The fact is reported instead, and the composition
   * root records it, until `secrets` publishes an audit-append operation.
   */
  readonly previousCredentialName: CredentialName;
}

async function resolveKey(
  dependencies: ProvidersDependencies,
  grant: TenancyOperatorGrant,
  providerKeyId: ProviderKeyId,
): Promise<Result<ProviderKey>> {
  const found = await dependencies.repository.findProviderKey(grant.scope, providerKeyId);
  if (!found.ok) return err(found.error);
  if (found.value === null) return err(providerKeyNotFound(providerKeyId));
  return ok(found.value);
}

export async function rotateProviderKeySecret(
  dependencies: ProvidersDependencies,
  command: RotateProviderKeySecretCommand,
): Promise<Result<ProviderKey>> {
  const verified = verifyOperator(dependencies, command.authorization);
  if (!verified.ok) return err(verified.error);
  const granted = requireAccess(verified.value, "secret:mutate");
  if (!granted.ok) return err(granted.error);

  const material = admitProviderSecret(command.plaintext);
  if (!material.ok) return err(material.error);

  const key = await resolveKey(dependencies, granted.value, command.providerKeyId);
  if (!key.ok) return err(key.error);

  const vault = vaultGrantFor(granted.value);
  const credential = await dependencies.secrets.describeCredential({
    authorization: vault,
    credentialId: asIdentifier(key.value.credentialId),
  });
  if (!credential.ok) return err(credential.error);
  // The credential must still be the one this key names, still this provider's,
  // and still usable. The source re-checks all three inside the transaction
  // rather than trusting the key's own columns, because a credential can be
  // revoked or relinked between the key being read and the secret being written.
  if (
    credential.value === null ||
    credential.value.name !== key.value.credentialName ||
    !isUsableFor(credential.value, key.value.provider)
  ) {
    return err(credentialUnavailable(key.value.credentialName, key.value.provider));
  }

  const rotated = await dependencies.secrets.rotateCredential({
    authorization: vault,
    credentialId: credential.value.id,
    plaintext: material.value,
  });
  if (!rotated.ok) return err(rotated.error);

  // The vault write is what the operator asked for and it has happened. This
  // second write only re-states the link, so it is not a compensation point: it
  // writes the same two columns the source writes after its own rotation.
  const written = await saveProviderKey(
    dependencies,
    granted.value.scope,
    relink(
      key.value,
      asIdentifier<CredentialId>(rotated.value.id),
      asProvidersIdentifier<CredentialName>(rotated.value.name),
      null,
      dependencies.clock.now(),
    ),
    false,
  );
  if (!written.ok) return err(written.error);

  await dependencies.probeCache.forgetProvider(key.value.provider);
  return ok(written.value);
}

export async function relinkProviderKey(
  dependencies: ProvidersDependencies,
  command: RelinkProviderKeyCommand,
): Promise<Result<RelinkedProviderKey>> {
  const verified = verifyOperator(dependencies, command.authorization);
  if (!verified.ok) return err(verified.error);
  const granted = requireAccess(verified.value, "secret:mutate");
  if (!granted.ok) return err(granted.error);

  const key = await resolveKey(dependencies, granted.value, command.providerKeyId);
  if (!key.ok) return err(key.error);

  const label = command.label?.trim();
  if (label !== undefined && label !== "") {
    const free = await assertLabelIsFree(
      dependencies,
      granted.value.scope,
      key.value.provider,
      label,
      key.value,
    );
    if (!free.ok) return err(free.error);
  }

  const vault = vaultGrantFor(granted.value);
  const credential = await requireProviderCredential(
    dependencies,
    vault,
    command.credentialName.trim(),
    key.value.provider,
  );
  if (!credential.ok) return err(credential.error);

  const written = await saveProviderKey(
    dependencies,
    granted.value.scope,
    relink(
      key.value,
      asIdentifier<CredentialId>(credential.value.id),
      asProvidersIdentifier<CredentialName>(credential.value.name),
      label === undefined || label === "" ? null : label,
      dependencies.clock.now(),
    ),
    false,
  );
  if (!written.ok) return err(written.error);

  await dependencies.probeCache.forgetProvider(key.value.provider);
  return ok({ key: written.value, previousCredentialName: key.value.credentialName });
}
