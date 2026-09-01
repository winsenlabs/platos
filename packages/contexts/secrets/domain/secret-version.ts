// CredentialSecretVersion — the envelope row, and its whole lifecycle.
//
// The field list below IS the canonical store's, column for column:
// credentialId, secretRevision Int, formatVersion Int, rootKeyVersion Int,
// salt Bytes, nonce Bytes, ciphertext Bytes, authTag Bytes, retiredAt?,
// readableUntil?, createdAt — unique on [credentialId, secretRevision,
// rootKeyVersion].
//
// LIFECYCLE, from the extraction source's observable behaviour:
//
//   * Exactly one version at a time is the credential's ACTIVE version. Only the
//     active version is ever opened for a runtime read.
//   * Rotation seals a NEW version at revision+1 under the ACTIVE root key and
//     retires the old one. Re-encryption seals a new version at the SAME revision
//     under the active root key and retires the old one — which is why the store's
//     unique key includes rootKeyVersion.
//   * `retiredAt` closes a version to reads. It does not delete it: an operator
//     may still need to know a version existed.
//   * `readableUntil` is a PURGE-DEFERRAL window, not a read window. The extraction
//     source's purge predicate is `readableUntil IS NULL OR readableUntil <= cutoff`,
//     and its runtime read path never looks at a retired version at all. Modelling
//     it as a read window would silently re-open revoked secrets.

import type { EnvelopeBinding, EnvelopeFormatVersion, SealedEnvelope } from "./envelope.js";
import type { CredentialId, RootKeyVersion, SecretRevision, SecretVersionId } from "./ids.js";

export interface CredentialSecretVersion extends SealedEnvelope {
  readonly id: SecretVersionId;
  readonly credentialId: CredentialId;
  readonly secretRevision: SecretRevision;
  readonly formatVersion: EnvelopeFormatVersion;
  readonly rootKeyVersion: RootKeyVersion;
  /** Set the moment the version stops being the active one. */
  readonly retiredAt: Date | null;
  /** Until when a retired version is exempt from purging. */
  readonly readableUntil: Date | null;
  readonly createdAt: Date;
}

/** What a use case hands the repository to insert. Identity comes from a port. */
export interface CredentialSecretVersionDraft extends SealedEnvelope {
  readonly id: SecretVersionId;
  readonly credentialId: CredentialId;
  readonly secretRevision: SecretRevision;
  readonly formatVersion: EnvelopeFormatVersion;
  readonly rootKeyVersion: RootKeyVersion;
  readonly createdAt: Date;
}

export type SecretVersionLifecycle =
  /** Openable, and the credential points at it. */
  | "active"
  /** Retired, closed to reads, still exempt from purging. */
  | "retired-retained"
  /** Retired, closed to reads, and eligible to be destroyed. */
  | "retired-purgeable";

export function isRetired(version: CredentialSecretVersion): boolean {
  return version.retiredAt !== null;
}

export function lifecycleOf(version: CredentialSecretVersion, at: Date): SecretVersionLifecycle {
  if (!isRetired(version)) return "active";
  if (version.readableUntil !== null && version.readableUntil.getTime() > at.getTime()) {
    return "retired-retained";
  }
  return "retired-purgeable";
}

/**
 * The read rule, in one place.
 *
 * A version is openable only while it is un-retired AND it is the version the
 * credential currently points at. Both halves matter: the first stops a rotated
 * secret from being read back, the second stops a version that was orphaned by a
 * concurrent write from being read at all.
 */
export function isOpenable(
  version: CredentialSecretVersion,
  activeSecretVersionId: SecretVersionId | null,
): boolean {
  return !isRetired(version) && activeSecretVersionId === version.id;
}

/**
 * Purge eligibility. Every clause is load-bearing, and the extraction source
 * re-checks all of them inside the delete statement so a concurrent re-activation
 * cannot lose the race.
 */
export function isPurgeEligible(
  version: CredentialSecretVersion,
  activeSecretVersionId: SecretVersionId | null,
  cutoff: Date,
): boolean {
  if (version.retiredAt === null) return false;
  if (version.retiredAt.getTime() > cutoff.getTime()) return false;
  if (version.readableUntil !== null && version.readableUntil.getTime() > cutoff.getTime()) {
    return false;
  }
  return activeSecretVersionId !== version.id;
}

export function bindingOf(
  version: CredentialSecretVersion | CredentialSecretVersionDraft,
  environmentId: EnvelopeBinding["environmentId"],
): EnvelopeBinding {
  return Object.freeze({
    environmentId,
    credentialId: version.credentialId,
    secretRevision: version.secretRevision,
    formatVersion: version.formatVersion,
    rootKeyVersion: version.rootKeyVersion,
  });
}

/** Deterministic purge order: oldest first, ties broken by id. */
export function purgeOrder(
  left: CredentialSecretVersion,
  right: CredentialSecretVersion,
): number {
  const byCreation = left.createdAt.getTime() - right.createdAt.getTime();
  if (byCreation !== 0) return byCreation;
  return left.id < right.id ? -1 : left.id > right.id ? 1 : 0;
}
