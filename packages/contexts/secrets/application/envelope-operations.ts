// Seal and open: the two operations every write and read path shares.
//
// Both are here rather than duplicated across five use cases, because both carry
// security rules that must not diverge by accident:
//
//   SEAL always uses the ACTIVE root key and the CANONICAL format. There is no
//   parameter for either. A caller cannot ask for an old key or a legacy format,
//   so "seal under the key that is being rotated out" is not expressible.
//
//   OPEN fails closed three ways before it reaches the cipher: an absent root key
//   version, a legacy envelope format, and a retired or non-active envelope. Each
//   returns the single stable CREDENTIAL_UNAVAILABLE, so a caller learns nothing
//   about which one it hit — and, critically, never receives the ciphertext as a
//   consolation.

import { err, ok } from "@platos/kernel";
import type { EnvironmentId, Result } from "@platos/kernel";

import {
  CANONICAL_ENVELOPE_FORMAT,
  envelopeFormat,
  requireWritableFormat,
} from "../domain/envelope.js";
import type { EnvelopeBinding } from "../domain/envelope.js";
import { credentialUnavailable } from "../domain/errors.js";
import { asSecretsIdentifier } from "../domain/ids.js";
import type { CredentialId, SecretRevision, SecretVersionId } from "../domain/ids.js";
import { rootKeyStatus } from "../domain/key-ring.js";
import type { SecretMaterial } from "../domain/secret-material.js";
import { isOpenable } from "../domain/secret-version.js";
import type {
  CredentialSecretVersion,
  CredentialSecretVersionDraft,
} from "../domain/secret-version.js";
import type { SecretsDependencies } from "./dependencies.js";

export interface SealInput {
  readonly environmentId: EnvironmentId;
  readonly credentialId: CredentialId;
  readonly secretRevision: SecretRevision;
  readonly plaintext: SecretMaterial;
}

/** Seal new material under the active root key, in the canonical format. */
export async function sealSecret(
  deps: SecretsDependencies,
  input: SealInput,
): Promise<Result<CredentialSecretVersionDraft>> {
  const format = requireWritableFormat(CANONICAL_ENVELOPE_FORMAT);
  if (!format.ok) return err(format.error);

  const ring = await deps.keyRing.state();
  if (!ring.ok) return err(ring.error);

  const key = await deps.keyRing.handle(ring.value.activeVersion);
  if (!key.ok) return err(key.error);

  const binding: EnvelopeBinding = {
    environmentId: input.environmentId,
    credentialId: input.credentialId,
    secretRevision: input.secretRevision,
    formatVersion: format.value.formatVersion,
    rootKeyVersion: ring.value.activeVersion,
  };
  const sealed = await deps.cipher.seal({
    key: key.value,
    binding,
    plaintext: input.plaintext,
  });
  if (!sealed.ok) return err(sealed.error);

  return ok({
    id: asSecretsIdentifier<SecretVersionId>(deps.ids.uuid()),
    credentialId: input.credentialId,
    secretRevision: input.secretRevision,
    formatVersion: binding.formatVersion,
    rootKeyVersion: binding.rootKeyVersion,
    salt: sealed.value.salt,
    nonce: sealed.value.nonce,
    ciphertext: sealed.value.ciphertext,
    authTag: sealed.value.authTag,
    createdAt: deps.clock.now(),
  });
}

export interface OpenInput {
  readonly environmentId: EnvironmentId;
  readonly version: CredentialSecretVersion;
  /** What the credential currently points at, so an orphan cannot be read. */
  readonly activeSecretVersionId: SecretVersionId | null;
}

/**
 * Open the credential's active envelope, or fail closed.
 *
 * Used by the runtime read path and by re-encryption. Re-encryption passes the
 * version it is replacing as the active one, which is exactly right: it may only
 * re-seal material the credential is still standing behind.
 */
export async function openSecret(
  deps: SecretsDependencies,
  input: OpenInput,
): Promise<Result<SecretMaterial>> {
  const { version } = input;
  if (!isOpenable(version, input.activeSecretVersionId)) {
    return err(
      credentialUnavailable(
        version.retiredAt === null ? "secret_version_not_active" : "secret_version_retired",
      ),
    );
  }
  if (!envelopeFormat(version.formatVersion).versionedRootKey) {
    return err(credentialUnavailable("envelope_format_unreadable"));
  }

  const ring = await deps.keyRing.state();
  if (!ring.ok) return err(ring.error);
  if (rootKeyStatus(ring.value, version.rootKeyVersion) === "absent") {
    return err(credentialUnavailable("root_key_absent"));
  }

  const key = await deps.keyRing.handle(version.rootKeyVersion);
  if (!key.ok) return err(credentialUnavailable("root_key_absent"));

  const opened = await deps.cipher.open({
    key: key.value,
    binding: {
      environmentId: input.environmentId,
      credentialId: version.credentialId,
      secretRevision: version.secretRevision,
      formatVersion: version.formatVersion,
      rootKeyVersion: version.rootKeyVersion,
    },
    envelope: version,
  });
  return opened.ok ? opened : err(credentialUnavailable("envelope_open_failed"));
}
