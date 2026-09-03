// The driven port over the four rows this context is SOLE WRITER of
// (ADR M0.3 §1 row 3): Credential, CredentialSecretVersion, CredentialAudit and —
// through its sibling port — EnvironmentVariable.
//
// Every mutating method takes a kernel `TransactionScope`. ADR M0.3 §3 forbids
// passing a vendor transaction handle across a port, so the scope is opaque and
// the adapter correlates it to its own open transaction. That is what lets a use
// case seal an envelope, repoint the credential and append the audit row
// atomically without this package ever naming a database.
//
// `loadForUpdate` exists because the extraction source takes a row lock before
// every rotation. Its integration suite pins the property that lock provides
// ("serializes plaintext rotation against root rewrap without losing plaintext"),
// so the port must be able to express it or the property is lost in extraction.

import type { EnvironmentId, Result, TransactionScope } from "@platos/kernel";

import type { CredentialAuditDraft } from "../../domain/audit.js";
import type { Credential, CredentialDraft, CredentialKind } from "../../domain/credential.js";
import type { CredentialId, RootKeyVersion, SecretVersionId } from "../../domain/ids.js";
import type { RootKeyUsage } from "../../domain/key-ring.js";
import type {
  CredentialSecretVersion,
  CredentialSecretVersionDraft,
} from "../../domain/secret-version.js";

/** How a caller addresses a credential it has not already loaded. */
export interface CredentialQuery {
  readonly environmentId: EnvironmentId;
  readonly credentialId?: CredentialId;
  readonly name?: string;
  readonly provider?: string;
  readonly kind?: CredentialKind;
}

/** A credential together with the envelope it currently points at. */
export interface CredentialWithActiveVersion {
  readonly credential: Credential;
  readonly activeSecretVersion: CredentialSecretVersion | null;
}

/** One retired envelope a purge may destroy. Metadata only — never the bytes. */
export interface RetiredSecretVersionCandidate {
  readonly secretVersionId: SecretVersionId;
  readonly credentialId: CredentialId;
  readonly environmentId: EnvironmentId;
  readonly secretRevision: CredentialSecretVersion["secretRevision"];
  readonly rootKeyVersion: RootKeyVersion;
}

export interface SecretsRepository {
  // ---- reads -------------------------------------------------------------
  /** Find one live credential and its active envelope, or null. */
  findCredential(query: CredentialQuery): Promise<Result<CredentialWithActiveVersion | null>>;

  /**
   * Load one credential for mutation, taking whatever exclusive lock the adapter
   * provides. Two concurrent rotations of the same credential must serialise here
   * or one plaintext is lost.
   */
  loadForUpdate(
    environmentId: EnvironmentId,
    credentialId: CredentialId,
    transaction: TransactionScope,
  ): Promise<Result<CredentialWithActiveVersion | null>>;

  /** Every credential in one environment, name-ordered. Metadata callers only. */
  listCredentials(environmentId: EnvironmentId): Promise<Result<readonly CredentialWithActiveVersion[]>>;

  /** Retired envelopes eligible for destruction, oldest first, bounded. */
  listPurgeCandidates(
    cutoff: Date,
    limit: number,
    transaction: TransactionScope,
  ): Promise<Result<readonly RetiredSecretVersionCandidate[]>>;

  /** Unpurged envelope counts per root key version, across every tenant. */
  countVersionsByRootKey(): Promise<Result<readonly RootKeyUsage[]>>;

  // ---- writes ------------------------------------------------------------
  insertCredential(draft: CredentialDraft, transaction: TransactionScope): Promise<Result<Credential>>;

  insertSecretVersion(
    draft: CredentialSecretVersionDraft,
    transaction: TransactionScope,
  ): Promise<Result<CredentialSecretVersion>>;

  /** Repoint the credential at a new envelope. */
  setActiveSecretVersion(
    credentialId: CredentialId,
    secretVersionId: SecretVersionId | null,
    at: Date,
    transaction: TransactionScope,
  ): Promise<Result<Credential>>;

  /** Close an envelope to reads and start its retention window. */
  retireSecretVersion(
    secretVersionId: SecretVersionId,
    retiredAt: Date,
    readableUntil: Date | null,
    transaction: TransactionScope,
  ): Promise<Result<CredentialSecretVersion>>;

  revokeCredential(
    credentialId: CredentialId,
    revokedAt: Date,
    transaction: TransactionScope,
  ): Promise<Result<Credential>>;

  /**
   * Destroy one retired envelope. The adapter MUST re-check every eligibility
   * clause inside the delete so a concurrent re-activation cannot lose the race,
   * and MUST report how many rows it removed so the caller can fail closed.
   */
  purgeSecretVersion(
    candidate: RetiredSecretVersionCandidate,
    cutoff: Date,
    transaction: TransactionScope,
  ): Promise<Result<number>>;

  /**
   * Append evidence. A failure here fails the whole unit of work: an unauditable
   * mutation does not happen.
   */
  appendAudit(draft: CredentialAuditDraft, transaction: TransactionScope): Promise<Result<void>>;
}
