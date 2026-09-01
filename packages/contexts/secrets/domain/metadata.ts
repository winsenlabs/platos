// The read model — and the reason it is a separate file.
//
// THE RULE: a plaintext secret never leaves the encryption boundary, and neither
// does the ciphertext that stands in for it. Everything a caller outside this
// context can read about a credential is here, and it is metadata.
//
// The projection is built by ENUMERATING what is included, never by omitting what
// is excluded. Under a spread-then-delete projection, a column added to the store
// tomorrow is exported by default and leaks silently. Under this one it is invisible
// until somebody deliberately adds it, and the field-list constants below make even
// that deliberate addition fail a colocated test until it is reviewed.
//
// The extraction source expresses the same intent as `CREDENTIAL_SAFE_SELECT`.
// Restating it as a pure function is what lets a test prove the property without a
// database.

import type { EnvironmentId } from "@platos/kernel";

import type { Credential, CredentialKind } from "./credential.js";
import type { EnvelopeFormatVersion } from "./envelope.js";
import type { ActorId, CredentialId, RootKeyVersion, SecretRevision, SecretVersionId } from "./ids.js";
import type { CredentialSecretVersion } from "./secret-version.js";

/**
 * What may be said about the active envelope.
 *
 * Note what is NOT here: salt, nonce, ciphertext, authTag. An operator learns the
 * envelope's shape and age — enough to reason about rotation — and never a byte
 * of it.
 */
export interface SecretVersionMetadata {
  readonly id: SecretVersionId;
  readonly secretRevision: SecretRevision;
  readonly formatVersion: EnvelopeFormatVersion;
  readonly rootKeyVersion: RootKeyVersion;
  readonly retiredAt: Date | null;
  readonly readableUntil: Date | null;
  readonly createdAt: Date;
}

export interface CredentialMetadata {
  readonly id: CredentialId;
  readonly environmentId: EnvironmentId;
  readonly kind: CredentialKind;
  readonly name: string;
  readonly provider: string | null;
  readonly permissions: readonly string[];
  readonly expiresAt: Date | null;
  readonly lastUsedAt: Date | null;
  readonly revokedAt: Date | null;
  readonly createdBy: ActorId | null;
  readonly createdAt: Date;
  readonly updatedAt: Date;
  readonly activeSecretVersion: SecretVersionMetadata | null;
}

export const SECRET_VERSION_METADATA_FIELDS = [
  "id",
  "secretRevision",
  "formatVersion",
  "rootKeyVersion",
  "retiredAt",
  "readableUntil",
  "createdAt",
] as const;

export const CREDENTIAL_METADATA_FIELDS = [
  "id",
  "environmentId",
  "kind",
  "name",
  "provider",
  "permissions",
  "expiresAt",
  "lastUsedAt",
  "revokedAt",
  "createdBy",
  "createdAt",
  "updatedAt",
  "activeSecretVersion",
] as const;

/**
 * The fields the projection deliberately drops. Four are envelope bytes; two are
 * the transitional escape hatches documented on domain/credential.ts, which hold
 * legacy-format material and a wire verifier and belong in NO read model.
 */
export const WITHHELD_CREDENTIAL_FIELDS = [
  "salt",
  "nonce",
  "ciphertext",
  "authTag",
  "secretHash",
  "encryptedReference",
] as const;

export function toSecretVersionMetadata(version: CredentialSecretVersion): SecretVersionMetadata {
  return Object.freeze({
    id: version.id,
    secretRevision: version.secretRevision,
    formatVersion: version.formatVersion,
    rootKeyVersion: version.rootKeyVersion,
    retiredAt: version.retiredAt,
    readableUntil: version.readableUntil,
    createdAt: version.createdAt,
  });
}

export function toCredentialMetadata(
  credential: Credential,
  activeSecretVersion: CredentialSecretVersion | null,
): CredentialMetadata {
  return Object.freeze({
    id: credential.id,
    environmentId: credential.environmentId,
    kind: credential.kind,
    name: credential.name,
    provider: credential.provider,
    permissions: Object.freeze([...credential.permissions]),
    expiresAt: credential.expiresAt,
    lastUsedAt: credential.lastUsedAt,
    revokedAt: credential.revokedAt,
    createdBy: credential.createdBy,
    createdAt: credential.createdAt,
    updatedAt: credential.updatedAt,
    activeSecretVersion:
      activeSecretVersion === null ? null : toSecretVersionMetadata(activeSecretVersion),
  });
}
