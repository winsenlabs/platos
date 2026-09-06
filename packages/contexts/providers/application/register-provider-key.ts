// Use case: register a provider key by pasting the material ("bring your own key").
//
// Two writes in two contexts: the vault mints or rotates a credential, and this
// context links a ProviderKey to it. In the source both happen inside ONE
// database transaction. They cannot here — ADR M0.3 §1 row 3 makes `secrets` the
// sole writer of `Credential`, and no context passes a transaction handle across
// a port (§3) — so the failure model changes, and it is recorded rather than
// hidden.
//
// THE THREE OUTCOMES, EXPLICITLY.
//
//   1. The label was already taken. Refused BEFORE the vault is touched, so the
//      common mistake never reaches this seam at all.
//
//   2. A NEW credential was minted and the key write then failed. The credential
//      is REVOKED as compensation. Nothing points at it — no ProviderKey exists
//      — so revoking is total and leaves the environment exactly as it was.
//
//   3. An EXISTING credential was rotated and the key write then failed. The
//      rotation STANDS. That is the safe answer and not a shortcut: the operator
//      asked for the material to change, it has changed, and any other key
//      already pointing at that credential is now using the new material.
//      "Rolling back" would mean writing the previous secret again, which an
//      append-only version history does not offer and which would silently
//      un-rotate a credential an operator may have rotated because it leaked.
//
// The reported error is the one that actually happened. A compensation that
// itself fails is reported instead, because at that point the environment is in
// a state an operator needs told about.

import { asIdentifier, err, ok, type DomainError, type Result } from "@platos/kernel";
import { acceptPlaintext } from "@platos/context-secrets";
import type { CredentialMetadata, SecretMaterial } from "@platos/context-secrets";

import {
  admitProviderKey,
  admitProviderSecret,
  asProvidersIdentifier,
  credentialUnavailable,
  type ActorId,
  type CredentialId,
  type CredentialName,
  type ProviderKey,
  type ProviderKeyId,
  type ProviderKeyIntake,
} from "../domain/index.js";
import { requireAccess, vaultGrantFor, verifyOperator, type SecretsOperatorGrant } from "./authorization.js";
import type { ProvidersDependencies } from "./dependencies.js";
import { assertLabelIsFree, insertProviderKey } from "./provider-key-store.js";
import { findCredentialByName, isUsableFor, PROVIDER_CREDENTIAL_KIND } from "./vault.js";

export interface RegisterProviderKeyCommand {
  readonly authorization: unknown;
  readonly intake: ProviderKeyIntake;
  /** The material. Its value is never logged, compared or returned. */
  readonly plaintext: unknown;
}

interface VaultOutcome {
  readonly credential: CredentialMetadata;
  /** True when this call minted it, which is what decides the compensation. */
  readonly minted: boolean;
}

async function putMaterial(
  dependencies: ProvidersDependencies,
  grant: SecretsOperatorGrant,
  name: string,
  provider: string,
  plaintext: SecretMaterial,
): Promise<Result<VaultOutcome>> {
  const existing = await findCredentialByName(dependencies, grant, name);
  if (!existing.ok) return err(existing.error);

  if (existing.value === null) {
    const created = await dependencies.secrets.createCredential({
      authorization: grant,
      name,
      kind: PROVIDER_CREDENTIAL_KIND,
      provider,
      plaintext,
    });
    return created.ok ? ok({ credential: created.value, minted: true }) : err(created.error);
  }

  // A credential of this name exists but is another provider's, is revoked, or
  // has no active envelope. Rotating it would hand this provider a name it does
  // not own; refusing is the only safe answer, and it is the source's.
  if (!isUsableFor(existing.value, asProvidersIdentifier(provider))) {
    return err(credentialUnavailable(name, provider));
  }
  const rotated = await dependencies.secrets.rotateCredential({
    authorization: grant,
    credentialId: existing.value.id,
    plaintext,
  });
  return rotated.ok ? ok({ credential: rotated.value, minted: false }) : err(rotated.error);
}

/**
 * Undo the vault half, when undoing it is safe.
 *
 * Returns the compensation's OWN failure when it has one, and null otherwise —
 * including when there was nothing to undo. A compensation that itself failed is
 * what the caller must be told about, because at that point the environment
 * holds a credential nothing points at.
 */
async function compensate(
  dependencies: ProvidersDependencies,
  grant: SecretsOperatorGrant,
  outcome: VaultOutcome,
): Promise<DomainError | null> {
  if (!outcome.minted) return null;
  const revoked = await dependencies.secrets.revokeCredential({
    authorization: grant,
    credentialId: outcome.credential.id,
  });
  return revoked.ok ? null : revoked.error;
}

export async function registerProviderKey(
  dependencies: ProvidersDependencies,
  command: RegisterProviderKeyCommand,
): Promise<Result<ProviderKey>> {
  const verified = verifyOperator(dependencies, command.authorization);
  if (!verified.ok) return err(verified.error);
  const granted = requireAccess(verified.value, "secret:mutate");
  if (!granted.ok) return err(granted.error);

  const admitted = admitProviderKey(command.intake);
  if (!admitted.ok) return err(admitted.error);
  const admittedSecret = admitProviderSecret(command.plaintext);
  if (!admittedSecret.ok) return err(admittedSecret.error);
  // WIN-259 — the plaintext stops being a bare string HERE, at the last point
  // inside this context that still holds one, so nothing crosses the boundary
  // into `secrets` as a value a serialiser could record.
  const material = acceptPlaintext(admittedSecret.value);
  if (!material.ok) return err(material.error);

  const scope = granted.value.scope;
  const free = await assertLabelIsFree(dependencies, scope, admitted.value.provider, admitted.value.label);
  if (!free.ok) return err(free.error);

  const vault = vaultGrantFor(granted.value);
  const stored = await putMaterial(
    dependencies,
    vault,
    admitted.value.credentialName,
    admitted.value.provider,
    material.value,
  );
  if (!stored.ok) return err(stored.error);

  const now = dependencies.clock.now();
  const draft: ProviderKey = {
    providerKeyId: asProvidersIdentifier<ProviderKeyId>(dependencies.ids.uuid()),
    environmentId: scope.environmentId,
    credentialId: asIdentifier<CredentialId>(stored.value.credential.id),
    provider: admitted.value.provider,
    label: admitted.value.label,
    credentialName: asProvidersIdentifier<CredentialName>(stored.value.credential.name),
    isDefault: admitted.value.isDefault,
    createdBy: asIdentifier<ActorId>(granted.value.effectiveUserId),
    lastUsedAt: null,
    createdAt: now,
    updatedAt: now,
  };

  const inserted = await insertProviderKey(dependencies, scope, draft);
  if (!inserted.ok) {
    const compensation = await compensate(dependencies, vault, stored.value);
    return err(compensation ?? inserted.error);
  }

  await dependencies.probeCache.forgetProvider(draft.provider);
  return ok(inserted.value);
}
