// The rows `secrets` owns, read back into the shapes its domain declares.
//
// ONE COLUMN LIST PER ROW, and every read in this half of the package uses it.
// A `select` written per call site is how a column quietly stops being read: the
// day `Credential.expiresAt` joined the domain type, a second selection
// somewhere would have kept answering `undefined` and `isUsable` would have
// treated an expired credential as live. The lists below are the contract.
//
// WHAT IS DELIBERATELY NOT SELECTED — nothing. `Credential.secretHash` and
// `Credential.encryptedReference` ARE read, although no read model surfaces
// either, because `domain/credential.ts` declares both on `Credential` through
// `TransitionalCredentialFields` and marks them deprecated rather than absent. A
// store that silently answered `null` for a column the row carries would make
// the deprecation untrue, and WIN-259 — which retires both onto `secretVersions`
// — has to be able to SEE them to know what it is retiring.
//
// THERE IS NO `CredentialAudit` READER, AND THAT IS THE PORT'S SHAPE RATHER THAN
// AN OMISSION. `SecretsRepository.appendAudit` returns `Promise<Result<void>>`
// and no other method mentions the row: the table is append-only in the database
// (three rules refuse UPDATE, DELETE and TRUNCATE, and PUBLIC is revoked), and
// this context never reads its own evidence back. A reader here would be surface
// nothing imports, so the suites that verify an audit row select its columns
// directly.
//
// EXPAND/CONTRACT. Every column named here exists in the frozen baseline
// migration `00000000000000_initial`. Nothing added by a later migration is
// read or written, so a row written before any later migration reads back whole.

import type {
  ActorId,
  Credential,
  CredentialId,
  CredentialKind,
  CredentialSecretVersion,
  EnvelopeFormatVersion,
  EnvironmentId,
  EnvironmentVariable,
  EnvironmentVariableId,
  EnvironmentVariableKind,
  RootKeyUsage,
  RootKeyVersion,
  SecretRevision,
  SecretVersionId,
} from "@platos/context-secrets/application/ports/index.js";
import {
  CREDENTIAL_KINDS,
  ENVELOPE_FORMAT_VERSIONS,
  ENVIRONMENT_VARIABLE_KINDS,
  asSecretsIdentifier,
} from "@platos/context-secrets/application/ports/index.js";

/** `Credential.kind` holds a value this binary does not know. */
export const UNKNOWN_CREDENTIAL_KIND = "secrets.row.unknown_credential_kind";

/** `EnvironmentVariable.kind` holds a value this binary does not know. */
export const UNKNOWN_VARIABLE_KIND = "secrets.row.unknown_variable_kind";

/** `CredentialSecretVersion.formatVersion` is outside the closed union. */
export const UNKNOWN_ENVELOPE_FORMAT = "secrets.row.unknown_envelope_format";

/**
 * A row this binary cannot read.
 *
 * It THROWS rather than returning a `Result`, and that is the decision
 * `mapping.ts` already made for the tenancy rows: a stored value outside a
 * closed union is a release mismatch — an older binary against a newer database
 * — not an outcome a caller is entitled to handle. Answering `null` would
 * present a credential that exists as a credential that does not, which in a
 * vault is the difference between "you may not read this" and "there is nothing
 * here".
 */
export class UnreadableSecretsRowError extends Error {
  readonly code: string;
  readonly column: string;
  readonly value: string;

  constructor(code: string, column: string, value: string) {
    super(`${column} holds ${JSON.stringify(value)}, which this binary cannot read`);
    this.name = "UnreadableSecretsRowError";
    this.code = code;
    this.column = column;
    this.value = value;
  }
}

/** Every column of `Credential`, including the two the schema flags transitional. */
export const CREDENTIAL_COLUMNS = {
  id: true,
  environmentId: true,
  activeSecretVersionId: true,
  kind: true,
  name: true,
  prefix: true,
  secretHash: true,
  encryptedReference: true,
  permissions: true,
  allowedOrigins: true,
  provider: true,
  externalClientId: true,
  expiresAt: true,
  lastUsedAt: true,
  revokedAt: true,
  createdBy: true,
  createdAt: true,
  updatedAt: true,
} as const;

/** Every column of `CredentialSecretVersion`. The four `Bytes` are the envelope. */
export const SECRET_VERSION_COLUMNS = {
  id: true,
  credentialId: true,
  secretRevision: true,
  formatVersion: true,
  rootKeyVersion: true,
  salt: true,
  nonce: true,
  ciphertext: true,
  authTag: true,
  retiredAt: true,
  readableUntil: true,
  createdAt: true,
} as const;

/** Every column of `EnvironmentVariable`. */
export const VARIABLE_COLUMNS = {
  id: true,
  environmentId: true,
  key: true,
  kind: true,
  value: true,
  credentialId: true,
  version: true,
  lastUpdatedBy: true,
  createdAt: true,
  updatedAt: true,
} as const;

export interface CredentialRow {
  readonly id: string;
  readonly environmentId: string;
  readonly activeSecretVersionId: string | null;
  readonly kind: string;
  readonly name: string;
  readonly prefix: string | null;
  readonly secretHash: string | null;
  readonly encryptedReference: string | null;
  readonly permissions: readonly string[];
  readonly allowedOrigins: readonly string[];
  readonly provider: string | null;
  readonly externalClientId: string | null;
  readonly expiresAt: Date | null;
  readonly lastUsedAt: Date | null;
  readonly revokedAt: Date | null;
  readonly createdBy: string | null;
  readonly createdAt: Date;
  readonly updatedAt: Date;
}

export interface SecretVersionRow {
  readonly id: string;
  readonly credentialId: string;
  readonly secretRevision: number;
  readonly formatVersion: number;
  readonly rootKeyVersion: number;
  readonly salt: Uint8Array;
  readonly nonce: Uint8Array;
  readonly ciphertext: Uint8Array;
  readonly authTag: Uint8Array;
  readonly retiredAt: Date | null;
  readonly readableUntil: Date | null;
  readonly createdAt: Date;
}

export interface VariableRow {
  readonly id: string;
  readonly environmentId: string;
  readonly key: string;
  readonly kind: string;
  readonly value: string | null;
  readonly credentialId: string | null;
  readonly version: number;
  readonly lastUpdatedBy: string | null;
  readonly createdAt: Date;
  readonly updatedAt: Date;
}

export function readCredentialKind(value: string): CredentialKind {
  if (!(CREDENTIAL_KINDS as readonly string[]).includes(value)) {
    throw new UnreadableSecretsRowError(UNKNOWN_CREDENTIAL_KIND, "Credential.kind", value);
  }
  return value as CredentialKind;
}

export function readVariableKind(value: string): EnvironmentVariableKind {
  if (!(ENVIRONMENT_VARIABLE_KINDS as readonly string[]).includes(value)) {
    throw new UnreadableSecretsRowError(UNKNOWN_VARIABLE_KIND, "EnvironmentVariable.kind", value);
  }
  return value as EnvironmentVariableKind;
}

/**
 * `formatVersion` is an `Int` column over a CLOSED union of three.
 *
 * `domain/envelope.ts` says why the union is closed: format 1 is the only
 * writable shape and formats 2 and 3 are legacy envelopes carrying no root key
 * version. A fourth value read back as a plain number would flow into
 * `envelopeFormat()` and index an undefined descriptor, so the refusal is here,
 * at the column, while the value can still be named.
 */
export function readEnvelopeFormat(value: number): EnvelopeFormatVersion {
  if (!(ENVELOPE_FORMAT_VERSIONS as readonly number[]).includes(value)) {
    throw new UnreadableSecretsRowError(
      UNKNOWN_ENVELOPE_FORMAT,
      "CredentialSecretVersion.formatVersion",
      String(value),
    );
  }
  return value as EnvelopeFormatVersion;
}

/**
 * A `Bytes` column, copied into a plain `Uint8Array`.
 *
 * The driver answers a `Bytes` column with a view whose backing buffer it may
 * share. `SealedEnvelope` is a value the domain holds and compares, and the
 * in-memory double's envelopes are freshly allocated arrays, so a shared view
 * would make the conformance differential's byte comparison depend on the
 * driver's allocation strategy rather than on the bytes.
 */
function readBytes(value: Uint8Array): Uint8Array {
  return Uint8Array.from(value);
}

export function readCredential(row: CredentialRow): Credential {
  return {
    id: asSecretsIdentifier<CredentialId>(row.id),
    environmentId: asSecretsIdentifier<EnvironmentId>(row.environmentId),
    kind: readCredentialKind(row.kind),
    name: row.name,
    provider: row.provider,
    prefix: row.prefix,
    permissions: [...row.permissions],
    allowedOrigins: [...row.allowedOrigins],
    externalClientId: row.externalClientId,
    activeSecretVersionId:
      row.activeSecretVersionId === null
        ? null
        : asSecretsIdentifier<SecretVersionId>(row.activeSecretVersionId),
    expiresAt: row.expiresAt,
    lastUsedAt: row.lastUsedAt,
    revokedAt: row.revokedAt,
    createdBy: row.createdBy === null ? null : asSecretsIdentifier<ActorId>(row.createdBy),
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
    secretHash: row.secretHash,
    encryptedReference: row.encryptedReference,
  };
}

export function readSecretVersion(row: SecretVersionRow): CredentialSecretVersion {
  return {
    id: asSecretsIdentifier<SecretVersionId>(row.id),
    credentialId: asSecretsIdentifier<CredentialId>(row.credentialId),
    secretRevision: row.secretRevision as SecretRevision,
    formatVersion: readEnvelopeFormat(row.formatVersion),
    rootKeyVersion: row.rootKeyVersion as RootKeyVersion,
    salt: readBytes(row.salt),
    nonce: readBytes(row.nonce),
    ciphertext: readBytes(row.ciphertext),
    authTag: readBytes(row.authTag),
    retiredAt: row.retiredAt,
    readableUntil: row.readableUntil,
    createdAt: row.createdAt,
  };
}

export function readVariable(row: VariableRow): EnvironmentVariable {
  return {
    id: asSecretsIdentifier<EnvironmentVariableId>(row.id),
    environmentId: asSecretsIdentifier<EnvironmentId>(row.environmentId),
    key: row.key,
    kind: readVariableKind(row.kind),
    value: row.value,
    credentialId:
      row.credentialId === null ? null : asSecretsIdentifier<CredentialId>(row.credentialId),
    version: row.version,
    lastUpdatedBy: row.lastUpdatedBy,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

/**
 * One `GROUP BY` bucket, from the aggregate that answers `countVersionsByRootKey`.
 *
 * NO SORT IS APPLIED HERE. `rootKeyReport` in the domain sorts the usage list
 * itself, and two sorts over one list is one of them being wrong later.
 */
export function readRootKeyUsage(row: {
  readonly rootKeyVersion: number;
  readonly unpurgedVersionCount: number;
}): RootKeyUsage {
  return {
    rootKeyVersion: row.rootKeyVersion as RootKeyVersion,
    unpurgedVersionCount: row.unpurgedVersionCount,
  };
}
