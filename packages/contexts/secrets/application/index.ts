// The `secrets` use cases.
//
// Each one is a plain function of `(dependencies, command)` returning the kernel
// `Result`. No class, no framework, no container: a use case is invokable in a
// test with in-memory ports and nothing else running.
//
// ADR M0.3 §6 keeps a turn's orchestration in named sub-use-case files rather than
// one god service; the same rule is applied here, so every file below is one
// operation and the encryption boundary has no 1,000-line centre.

export type { SecretsDependencies } from "./dependencies.js";
export type {
  AeadCipher,
  CredentialQuery,
  CredentialWithActiveVersion,
  EnvironmentVariableRepository,
  EnvironmentVariableUpsert,
  Hasher,
  KeyRing,
  OpenRequest,
  RetiredSecretVersionCandidate,
  RootKeyHandle,
  SealRequest,
  SecretsRepository,
} from "./ports/index.js";

export { createCredential } from "./create-credential.js";
export type { CreateCredentialCommand } from "./create-credential.js";

export { rotateCredential } from "./rotate-credential.js";
export type { RotateCredentialCommand } from "./rotate-credential.js";

export { reEncryptCredential } from "./re-encrypt-credential.js";
export type { ReEncryptCredentialCommand } from "./re-encrypt-credential.js";

// WIN-259 M2.4 — the same operation as a JOB rather than a request. Published
// beside it because a composition root wiring a durable schedule needs the
// bounded, resumable form and a transport handling one credential needs the
// single one, and neither should have to reach past this entry point for the
// other.
export { SWEEP_HARD_LIMIT, sweepRootKeyReEncryption } from "./sweep-root-key-reencryption.js";
export type {
  RootKeySweepReport,
  SweepRootKeyReEncryptionCommand,
  SweepSkip,
} from "./sweep-root-key-reencryption.js";

export {
  DEFAULT_REVOKED_SECRET_RETENTION_MS,
  MAX_REVOKED_SECRET_RETENTION_MS,
  revokeCredential,
} from "./revoke-credential.js";
export type { RevokeCredentialCommand } from "./revoke-credential.js";

export { readSecret } from "./read-secret.js";
export type { ReadSecretQuery } from "./read-secret.js";

export { describeCredential, listCredentials, reportRootKeyUsage } from "./describe-credentials.js";
export type { DescribeCredentialQuery } from "./describe-credentials.js";

export { PURGE_RETIRED_HARD_LIMIT, purgeRetiredSecretVersions } from "./purge-retired-versions.js";
export type { PurgeReport, PurgeRetiredCommand } from "./purge-retired-versions.js";

export { deleteEnvironmentVariable, setEnvironmentVariable } from "./environment-variable-writes.js";
export type {
  DeleteEnvironmentVariableCommand,
  DeleteEnvironmentVariableResult,
  SetEnvironmentVariableCommand,
} from "./environment-variable-writes.js";

export { listEnvironmentVariables, readEnvironmentVariable } from "./environment-variable-reads.js";
export type {
  EnvironmentVariableValue,
  ReadEnvironmentVariableQuery,
} from "./environment-variable-reads.js";

export { openSecret, sealSecret } from "./envelope-operations.js";
export type { OpenInput, SealInput } from "./envelope-operations.js";

export { inTransaction } from "./transaction.js";
export { recordAudit } from "./audit-log.js";
export type { AuditInput } from "./audit-log.js";

// The in-memory port implementations. They ship with the package on purpose: the
// composition root can smoke-test its wiring against them, and every colocated
// test drives the real use cases through them (ADR M0.3 §5's gates police the
// real code either way).
export {
  inMemoryAeadCipher,
  inMemoryClock,
  inMemoryHasher,
  inMemoryIdGenerator,
  inMemoryKeyRing,
  inMemoryUnitOfWork,
} from "./in-memory-crypto.js";
export type {
  InMemoryClock,
  InMemoryKeyRing,
  InMemoryUnitOfWork,
  TransactionParticipant,
} from "./in-memory-crypto.js";
export { inMemorySecretsStore } from "./in-memory-store.js";
export type { InMemorySecretsStore } from "./in-memory-store.js";
export { inMemorySecrets } from "./in-memory-dependencies.js";
export type { InMemorySecrets, InMemorySecretsOptions } from "./in-memory-dependencies.js";
export { inMemoryGrants } from "./in-memory-grants.js";
export type { InMemoryGrants } from "./in-memory-grants.js";
