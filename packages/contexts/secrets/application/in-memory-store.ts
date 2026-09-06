// In-memory stores for the four rows this context is sole writer of.
//
// They are stores, not stubs: they enforce the canonical schema's two unique keys
// (`[environmentId, kind, name]` on Credential and
// `[credentialId, secretRevision, rootKeyVersion]` on CredentialSecretVersion),
// they apply the domain's purge predicate rather than a looser one, and they
// snapshot and restore so a failed unit of work really rolls back. Without the
// rollback the atomicity properties could not be tested at all, and "fails closed
// when the audit write fails" would be an assertion about nothing.
//
// `failNextAudit` is the one injectable fault. It exists because the extraction
// source's integration suite pins that exact behaviour, and a property nobody can
// reproduce is not a property.

import { err, ok } from "@platos/kernel";
import type { EnvironmentId, Result } from "@platos/kernel";

import type { CredentialAuditDraft, CredentialAuditRecord } from "../domain/audit.js";
import type { Credential, CredentialDraft } from "../domain/credential.js";
import {
  credentialNameTaken,
  credentialUnavailable,
  environmentVariableVersionConflict,
  secretVersionAlreadyExists,
} from "../domain/errors.js";
import type { EnvironmentVariable } from "../domain/environment-variable.js";
import type { CredentialId, EnvironmentVariableId, SecretVersionId } from "../domain/ids.js";
import type { RootKeyUsage } from "../domain/key-ring.js";
import { isPurgeEligible, purgeOrder } from "../domain/secret-version.js";
import type {
  CredentialSecretVersion,
  CredentialSecretVersionDraft,
} from "../domain/secret-version.js";
import type { TransactionParticipant } from "./in-memory-crypto.js";
import type {
  CredentialQuery,
  CredentialWithActiveVersion,
  EnvironmentVariableRepository,
  EnvironmentVariableUpsert,
  RetiredSecretVersionCandidate,
  SecretsRepository,
} from "./ports/index.js";

interface Tables {
  credentials: Map<CredentialId, Credential>;
  versions: Map<SecretVersionId, CredentialSecretVersion>;
  audits: CredentialAuditRecord[];
  variables: Map<EnvironmentVariableId, EnvironmentVariable>;
}

function emptyTables(): Tables {
  return { credentials: new Map(), versions: new Map(), audits: [], variables: new Map() };
}

function copyTables(tables: Tables): Tables {
  return {
    credentials: new Map(tables.credentials),
    versions: new Map(tables.versions),
    audits: [...tables.audits],
    variables: new Map(tables.variables),
  };
}

export interface InMemorySecretsStore
  extends SecretsRepository,
    EnvironmentVariableRepository,
    TransactionParticipant {
  readonly allCredentials: () => readonly Credential[];
  readonly allVersions: () => readonly CredentialSecretVersion[];
  readonly allAudits: () => readonly CredentialAuditRecord[];
  readonly allVariables: () => readonly EnvironmentVariable[];
  /** Make the NEXT audit append fail, to prove the fail-closed path. */
  readonly failNextAudit: () => void;
}

export function inMemorySecretsStore(): InMemorySecretsStore {
  let tables = emptyTables();
  const snapshots: Tables[] = [];
  let auditFails = false;

  const activeVersionOf = (credential: Credential): CredentialSecretVersion | null =>
    credential.activeSecretVersionId === null
      ? null
      : (tables.versions.get(credential.activeSecretVersionId) ?? null);

  const withActive = (credential: Credential): CredentialWithActiveVersion => ({
    credential,
    activeSecretVersion: activeVersionOf(credential),
  });

  const matches = (credential: Credential, query: CredentialQuery): boolean =>
    credential.environmentId === query.environmentId &&
    credential.revokedAt === null &&
    (query.credentialId === undefined || credential.id === query.credentialId) &&
    (query.name === undefined || credential.name === query.name) &&
    (query.provider === undefined || credential.provider === query.provider) &&
    (query.kind === undefined || credential.kind === query.kind);

  return {
    // ---- test observation -------------------------------------------------
    allCredentials: () => [...tables.credentials.values()],
    allVersions: () => [...tables.versions.values()],
    allAudits: () => [...tables.audits],
    allVariables: () => [...tables.variables.values()],
    failNextAudit: () => {
      auditFails = true;
    },

    // ---- transaction participation ---------------------------------------
    snapshot: () => {
      snapshots.push(copyTables(tables));
    },
    restore: () => {
      const previous = snapshots.pop();
      if (previous !== undefined) tables = previous;
    },
    discard: () => {
      snapshots.pop();
    },

    // ---- SecretsRepository: reads ----------------------------------------
    async findCredential(query) {
      const found = [...tables.credentials.values()].find((credential) => matches(credential, query));
      return ok(found === undefined ? null : withActive(found));
    },

    async loadForUpdate(environmentId, credentialId) {
      const credential = tables.credentials.get(credentialId);
      if (credential === undefined || credential.environmentId !== environmentId) return ok(null);
      return ok(withActive(credential));
    },

    async listCredentials(environmentId) {
      return ok(
        [...tables.credentials.values()]
          .filter((credential) => credential.environmentId === environmentId)
          .sort((left, right) => left.name.localeCompare(right.name))
          .map(withActive),
      );
    },

    async listPurgeCandidates(cutoff, limit) {
      const activeIds = new Set(
        [...tables.credentials.values()].map((credential) => credential.activeSecretVersionId),
      );
      const eligible = [...tables.versions.values()]
        .filter((entry) => isPurgeEligible(entry, activeIds.has(entry.id) ? entry.id : null, cutoff))
        .sort(purgeOrder)
        .slice(0, limit);
      return ok(
        eligible.map((entry): RetiredSecretVersionCandidate => {
          const owner = tables.credentials.get(entry.credentialId);
          return {
            secretVersionId: entry.id,
            credentialId: entry.credentialId,
            environmentId: owner?.environmentId ?? ("" as EnvironmentId),
            secretRevision: entry.secretRevision,
            rootKeyVersion: entry.rootKeyVersion,
          };
        }),
      );
    },

    async countVersionsByRootKey() {
      const counts = new Map<number, number>();
      for (const entry of tables.versions.values()) {
        counts.set(entry.rootKeyVersion, (counts.get(entry.rootKeyVersion) ?? 0) + 1);
      }
      const usage: RootKeyUsage[] = [...counts.entries()].map(([rootKeyVersion, count]) => ({
        rootKeyVersion: rootKeyVersion as RootKeyUsage["rootKeyVersion"],
        unpurgedVersionCount: count,
      }));
      return ok(usage);
    },

    // ---- SecretsRepository: writes ---------------------------------------
    async insertCredential(draft: CredentialDraft) {
      const taken = [...tables.credentials.values()].some(
        (credential) =>
          credential.environmentId === draft.environmentId &&
          credential.kind === draft.kind &&
          credential.name === draft.name,
      );
      if (taken) return err(credentialNameTaken());
      const credential: Credential = {
        id: draft.id,
        environmentId: draft.environmentId,
        kind: draft.kind,
        name: draft.name,
        provider: draft.provider,
        prefix: null,
        permissions: [],
        allowedOrigins: [],
        externalClientId: null,
        activeSecretVersionId: null,
        expiresAt: null,
        lastUsedAt: null,
        revokedAt: null,
        createdBy: draft.createdBy,
        createdAt: draft.createdAt,
        updatedAt: draft.createdAt,
        secretHash: null,
        encryptedReference: null,
      };
      tables.credentials.set(credential.id, credential);
      return ok(credential);
    },

    async insertSecretVersion(draft: CredentialSecretVersionDraft) {
      const clash = [...tables.versions.values()].some(
        (entry) =>
          entry.credentialId === draft.credentialId &&
          entry.secretRevision === draft.secretRevision &&
          entry.rootKeyVersion === draft.rootKeyVersion,
      );
      if (clash) return err(secretVersionAlreadyExists());
      const version: CredentialSecretVersion = { ...draft, retiredAt: null, readableUntil: null };
      tables.versions.set(version.id, version);
      return ok(version);
    },

    async setActiveSecretVersion(credentialId, secretVersionId, at) {
      const credential = tables.credentials.get(credentialId);
      if (credential === undefined) return err(credentialUnavailable("credential_not_found"));
      const updated: Credential = { ...credential, activeSecretVersionId: secretVersionId, updatedAt: at };
      tables.credentials.set(credentialId, updated);
      return ok(updated);
    },

    async retireSecretVersion(secretVersionId, retiredAt, readableUntil) {
      const version = tables.versions.get(secretVersionId);
      if (version === undefined) return err(credentialUnavailable("secret_version_retired"));
      const updated: CredentialSecretVersion = { ...version, retiredAt, readableUntil };
      tables.versions.set(secretVersionId, updated);
      return ok(updated);
    },

    async revokeCredential(credentialId, revokedAt) {
      const credential = tables.credentials.get(credentialId);
      if (credential === undefined) return err(credentialUnavailable("credential_not_found"));
      const updated: Credential = { ...credential, revokedAt, updatedAt: revokedAt };
      tables.credentials.set(credentialId, updated);
      return ok(updated);
    },

    async purgeSecretVersion(candidate, cutoff) {
      const version = tables.versions.get(candidate.secretVersionId);
      if (version === undefined) return ok(0);
      const owner = tables.credentials.get(version.credentialId);
      if (!isPurgeEligible(version, owner?.activeSecretVersionId ?? null, cutoff)) return ok(0);
      tables.versions.delete(candidate.secretVersionId);
      return ok(1);
    },

    async appendAudit(draft: CredentialAuditDraft) {
      if (auditFails) {
        auditFails = false;
        return err(credentialUnavailable("credential_not_found"));
      }
      tables.audits.push({ ...draft });
      return ok(undefined);
    },

    // ---- EnvironmentVariableRepository ------------------------------------
    async findByKey(environmentId, key) {
      const found = [...tables.variables.values()].find(
        (variable) => variable.environmentId === environmentId && variable.key === key,
      );
      return ok(found ?? null);
    },

    async list(environmentId) {
      return ok(
        [...tables.variables.values()]
          .filter((variable) => variable.environmentId === environmentId)
          .sort((left, right) => left.key.localeCompare(right.key)),
      );
    },

    async upsert(input: EnvironmentVariableUpsert) {
      // KEYED ON `[environmentId, key]`, NOT ON `id`. WIN-258 T5 found this
      // double keying on `id` while the canonical store keys on the pair the
      // unique index carries, so a caller handing a FRESH id for an existing key
      // got a second row here and SQLSTATE 23505 there. The two now answer the
      // same question.
      const existing =
        [...tables.variables.values()].find(
          (variable) =>
            variable.environmentId === input.environmentId && variable.key === input.key,
        ) ?? null;

      // THE OPTIMISTIC FENCE, and it is here rather than only in the adapter
      // because a double that cannot lose a write cannot be used to test the code
      // that must not lose one. WIN-258 T7.
      if (input.expectedVersion === null) {
        if (existing !== null) return err(environmentVariableVersionConflict(null));
      } else if (existing === null || existing.version !== input.expectedVersion) {
        return err(environmentVariableVersionConflict(input.expectedVersion));
      }

      const variable: EnvironmentVariable = {
        id: existing?.id ?? input.id,
        environmentId: input.environmentId,
        key: input.key,
        kind: input.kind,
        value: input.value,
        credentialId: input.credentialId,
        version: (existing?.version ?? 0) + 1,
        lastUpdatedBy: input.lastUpdatedBy,
        createdAt: existing?.createdAt ?? input.at,
        updatedAt: input.at,
      };
      tables.variables.set(variable.id, variable);
      return ok(variable);
    },

    async remove(environmentId, id) {
      // SCOPED, like the canonical store. A double that deleted on the id alone
      // would answer `true` for another tenant's row and the difference would
      // only ever show up in production.
      const held = tables.variables.get(id);
      if (held === undefined || held.environmentId !== environmentId) return ok(false);
      return ok(tables.variables.delete(id));
    },

    async countReferences(credentialId: CredentialId): Promise<Result<number>> {
      const count = [...tables.variables.values()].filter(
        (variable) => variable.credentialId === credentialId,
      ).length;
      return ok(count);
    },
  };
}
