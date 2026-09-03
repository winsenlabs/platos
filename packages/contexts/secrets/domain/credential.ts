// Credential — the vault record this context is sole writer of.
//
// -----------------------------------------------------------------------------
// ADR-vs-SCHEMA CONTRADICTION, RECORDED HERE ON PURPOSE.
//
// ADR M0.3 §1 row 3 lists FIVE canonical rows as `secrets` sole-writer rows:
// Credential, CredentialSecretVersion, CredentialAudit, EnvironmentVariable and
// **SecretReference**. `SecretReference` DOES NOT EXIST in the canonical schema
// (internal-packages/tenancy-database/prisma/schema.prisma). It survives only in
// the inherited legacy schema (internal-packages/database/prisma/schema.prisma,
// with a `cuid` primary key and a `SecretStoreProvider` enum), and
// docs/model-disposition.md already retired it:
//
//     SecretReference -> Credential — "Merge secret metadata/reference into one
//     credential record with encrypted material stored behind a provider boundary."
//
// The merge has already happened. `CredentialKind.SECRET_REFERENCE` below IS the
// merged shape: a Credential whose kind marks it as backing an environment
// variable. So NO `SecretReference` contract is defined by this context, and the
// ADR row is stale rather than unimplemented. Recorded for a superseding decision
// (the ADR is accepted and frozen; §7 says a change lands as a new ADR).
//
// A SECOND DISAGREEMENT, same shape. The extraction source
// (internal-packages/tenancy-database/src/secrets.ts) also writes `ProviderKey`
// in `createProviderCredentialAndKey`, `linkProviderKey` and
// `relinkProviderKey`. ADR M0.3 §1 row 4 assigns `ProviderKey` to `providers`,
// not to `secrets`, and §5.2's sole-writer lint would fail that write here. Those
// three methods are therefore deliberately NOT extracted into this context: the
// credential half is `createCredential`/`rotateCredential` below, and `providers`
// composes it with its own ProviderKey write (its allow-list already includes
// `secrets`).
// -----------------------------------------------------------------------------

import type { EnvironmentId } from "@platos/kernel";

import type { ActorId, CredentialId, SecretVersionId } from "./ids.js";

/** The canonical store's `CredentialKind` enum, unchanged. */
export const CREDENTIAL_KINDS = [
  "SECRET_REFERENCE",
  "CHANNEL_SECRET",
  "ENTITY_SECRET",
  "SERVICE_CREDENTIAL",
] as const;

export type CredentialKind = (typeof CREDENTIAL_KINDS)[number];

export function isCredentialKind(value: string): value is CredentialKind {
  return (CREDENTIAL_KINDS as readonly string[]).includes(value);
}

/**
 * The two transitional escape hatches the schema itself flags.
 *
 * These are modelled, not hidden, and they are modelled as DEPRECATED, because
 * pretending they are gone is how a boundary quietly grows a second one. Both are
 * plain string columns on Credential that hold material this context's envelope
 * machinery never touches:
 *
 *   secretHash          "Transitional non-provider verifier used by canonical
 *                        wire transport authentication."
 *   encryptedReference  "Transitional non-provider channel envelope;
 *                        provider/MCP resolution must use secretVersions."
 *
 * Neither is readable through this context's read model, neither may be written by
 * a use case here, and `encryptedReference` in particular holds a LEGACY envelope
 * format (see domain/envelope.ts formats 2 and 3) that carries no root key version
 * and therefore cannot be rotated. Retiring them onto `secretVersions` is WIN-259.
 */
export interface TransitionalCredentialFields {
  /** @deprecated Transitional wire-transport verifier. Never part of the read model. */
  readonly secretHash: string | null;
  /** @deprecated Transitional channel envelope in a legacy format. Not rotatable. */
  readonly encryptedReference: string | null;
}

export interface Credential extends TransitionalCredentialFields {
  readonly id: CredentialId;
  readonly environmentId: EnvironmentId;
  readonly kind: CredentialKind;
  /** Unique with [environmentId, kind] in the canonical store. */
  readonly name: string;
  readonly provider: string | null;
  readonly prefix: string | null;
  readonly permissions: readonly string[];
  readonly allowedOrigins: readonly string[];
  readonly externalClientId: string | null;
  readonly activeSecretVersionId: SecretVersionId | null;
  readonly expiresAt: Date | null;
  readonly lastUsedAt: Date | null;
  readonly revokedAt: Date | null;
  readonly createdBy: ActorId | null;
  readonly createdAt: Date;
  readonly updatedAt: Date;
}

/** What a use case hands the repository to insert. */
export interface CredentialDraft {
  readonly id: CredentialId;
  readonly environmentId: EnvironmentId;
  readonly kind: CredentialKind;
  readonly name: string;
  readonly provider: string | null;
  readonly createdBy: ActorId | null;
  readonly createdAt: Date;
}

export function isRevoked(credential: Credential): boolean {
  return credential.revokedAt !== null;
}

export function isExpired(credential: Credential, at: Date): boolean {
  return credential.expiresAt !== null && credential.expiresAt.getTime() <= at.getTime();
}

/**
 * Usable means: not revoked, not expired, and still pointing at an active
 * envelope. A credential that fails any clause yields the one stable
 * `CREDENTIAL_UNAVAILABLE`, so a caller cannot tell which clause it failed.
 */
export function isUsable(credential: Credential, at: Date): boolean {
  return !isRevoked(credential) && !isExpired(credential, at) && credential.activeSecretVersionId !== null;
}

/** The store's `[environmentId, kind, name]` uniqueness, as a value. */
export function credentialSlot(credential: Credential | CredentialDraft): string {
  return `${credential.environmentId}/${credential.kind}/${credential.name}`;
}
