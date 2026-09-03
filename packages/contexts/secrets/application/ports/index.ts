// The driven ports `secrets` needs. Implemented under `packages/adapters/*`,
// wired at the composition root, never imported by `domain/`.
//
// ADR M0.3 §13: an adapter-facing port belongs to the context whose capability it
// serves, so the vault's repository and its cryptography live here rather than in
// the kernel. The kernel supplies only the cross-cutting decoupling ports this
// context also uses — Clock, IdGenerator, UnitOfWork, OutboxWriter, Logger.
export type {
  AeadCipher,
  Hasher,
  KeyRing,
  OpenRequest,
  RootKeyHandle,
  SealRequest,
} from "./crypto.js";
export type {
  CredentialQuery,
  CredentialWithActiveVersion,
  RetiredSecretVersionCandidate,
  SecretsRepository,
} from "./secrets-repository.js";
export type {
  EnvironmentVariableRepository,
  EnvironmentVariableUpsert,
} from "./environment-variable-repository.js";
