// The ONLY surface other contexts and apps/core-api may import (ADR M0.3 §2,
// §5.1 rule (c)). `providers`, `tools` and `conversations` are the three contexts
// whose §1 allow-list includes `secrets`; all three reach it through here.
//
// WHAT THIS SURFACE DELIBERATELY DOES NOT OFFER:
//
//   * No `SecretReference` type. ADR M0.3 §1 row 3 lists SecretReference as a
//     secrets sole-writer row, but it DOES NOT EXIST in the canonical schema
//     (internal-packages/tenancy-database/prisma/schema.prisma). It survives only
//     in the inherited legacy schema, and docs/model-disposition.md already
//     retired it into Credential: "Merge secret metadata/reference into one
//     credential record with encrypted material stored behind a provider
//     boundary." `CredentialKind.SECRET_REFERENCE` IS that merged shape. The ADR
//     row is stale; see domain/credential.ts for the full record.
//
//   * No ProviderKey operation. The extraction source writes ProviderKey inside
//     the secret store, but ADR M0.3 §1 row 4 makes `providers` its sole writer.
//     `providers` composes `createCredential` / `rotateCredential` from here with
//     its own ProviderKey write.
//
//   * No envelope bytes, and no way to ask for any. Every read below is metadata
//     except `readSecret`, which returns `SecretMaterial` — a value that redacts
//     itself under JSON, string coercion, inspection, spreading and enumeration.
//
//   * No plaintext ARGUMENT either, since WIN-259. Every mutating command takes
//     its material as the same self-redacting `SecretMaterial`, minted by the
//     `acceptPlaintext` re-exported below. The read side has been safe since
//     this context was written; the write side was a bare `string`, so a
//     command serialised into a queue, a retry buffer, a structured log or an
//     error report on its way here recorded the secret verbatim.

import type { Result } from "@platos/kernel";

import * as useCases from "../application/index.js";
import type { SecretsDependencies } from "../application/index.js";

import type {
  CredentialMetadata,
  EnvironmentVariableMetadata,
  RootKeyReport,
  SecretMaterial,
} from "../domain/index.js";
import type {
  DeleteEnvironmentVariableCommand,
  DeleteEnvironmentVariableResult,
  DescribeCredentialQuery,
  EnvironmentVariableValue,
  PurgeReport,
  PurgeRetiredCommand,
  ReadEnvironmentVariableQuery,
  ReadSecretQuery,
  ReEncryptCredentialCommand,
  RevokeCredentialCommand,
  RotateCredentialCommand,
  SetEnvironmentVariableCommand,
  CreateCredentialCommand,
} from "../application/index.js";

// The vault's vocabulary, published for callers.
export type {
  ActorId,
  CredentialAuditAction,
  CredentialAuditOutcome,
  CredentialId,
  CredentialKind,
  CredentialMetadata,
  EnvelopeFormatDescriptor,
  EnvelopeFormatVersion,
  EnvironmentAuthorization,
  EnvironmentAuthorizationAccess,
  EnvironmentOperatorAuthorization,
  EnvironmentRuntimeAuthorization,
  EnvironmentServiceAuthorization,
  EnvironmentVariableId,
  EnvironmentVariableKind,
  EnvironmentVariableMetadata,
  RootKeyOperationsAuthorization,
  RootKeyReport,
  RootKeyStatus,
  RootKeyUsage,
  RootKeyVersion,
  SecretMaterial,
  SecretRevision,
  SecretVersionId,
  SecretVersionMetadata,
  SecretsErrorCode,
} from "../domain/index.js";

export {
  CANONICAL_ENVELOPE_FORMAT,
  CREDENTIAL_KINDS,
  CREDENTIAL_METADATA_FIELDS,
  ENVELOPE_FORMAT_VERSIONS,
  ENVIRONMENT_VARIABLE_KINDS,
  ENVIRONMENT_VARIABLE_METADATA_FIELDS,
  SECRETS_ERROR_CODES,
  WITHHELD_CREDENTIAL_FIELDS,
  envelopeFormat,
  isSecretMaterial,
  // WIN-259. The ONE way to mint the write-only input every mutating command
  // below now requires. A transport calls this the moment it has decoded a
  // request body and before it has built a command, so the plaintext is inside
  // a self-redacting holder before any object exists that a logger, a retry
  // buffer or an error report could serialise.
  acceptPlaintext,
} from "../domain/index.js";

// The mint functions. `secrets` may not import identity-access (ADR M0.3 §1 row
// 3), so the composition root authenticates first and mints the grant here. A
// value that arrived as data — a parsed request body, a cache entry — can never
// be one of these, because the check is object identity against a register this
// module owns, not shape.
export {
  authorizeEnvironmentOperator,
  authorizeEnvironmentRuntime,
  authorizeEnvironmentService,
  authorizeRootKeyOperations,
  isMintedAuthorization,
} from "../domain/index.js";

export type {
  CreateCredentialCommand,
  DeleteEnvironmentVariableCommand,
  DeleteEnvironmentVariableResult,
  DescribeCredentialQuery,
  EnvironmentVariableValue,
  PurgeReport,
  PurgeRetiredCommand,
  ReadEnvironmentVariableQuery,
  ReadSecretQuery,
  ReEncryptCredentialCommand,
  RevokeCredentialCommand,
  RotateCredentialCommand,
  SetEnvironmentVariableCommand,
} from "../application/index.js";

/**
 * The credential vault and the encryption boundary, as one driving port.
 *
 * Every method returns the kernel `Result`, so every failure a caller must handle
 * is in the type rather than in a thrown exception crossing a context boundary.
 */
export interface SecretsContract {
  readonly name: "secrets";

  // ---- metadata (any minted environment grant) ---------------------------
  describeCredential(query: DescribeCredentialQuery): Promise<Result<CredentialMetadata | null>>;
  listCredentials(
    authorization: DescribeCredentialQuery["authorization"],
  ): Promise<Result<readonly CredentialMetadata[]>>;
  listEnvironmentVariables(
    authorization: DescribeCredentialQuery["authorization"],
  ): Promise<Result<readonly EnvironmentVariableMetadata[]>>;

  // ---- secret material (runtime tier only, always audited) ---------------
  readSecret(query: ReadSecretQuery): Promise<Result<SecretMaterial>>;
  readEnvironmentVariable(
    query: ReadEnvironmentVariableQuery,
  ): Promise<Result<EnvironmentVariableValue>>;

  // ---- mutation (operator secret:mutate, or service secret:write) --------
  createCredential(command: CreateCredentialCommand): Promise<Result<CredentialMetadata>>;
  rotateCredential(command: RotateCredentialCommand): Promise<Result<CredentialMetadata>>;
  revokeCredential(command: RevokeCredentialCommand): Promise<Result<CredentialMetadata>>;
  /** Move an envelope onto the active root key without changing the secret. */
  reEncryptCredential(command: ReEncryptCredentialCommand): Promise<Result<CredentialMetadata>>;
  setEnvironmentVariable(
    command: SetEnvironmentVariableCommand,
  ): Promise<Result<EnvironmentVariableMetadata>>;
  deleteEnvironmentVariable(
    command: DeleteEnvironmentVariableCommand,
  ): Promise<Result<DeleteEnvironmentVariableResult>>;

  // ---- installation-global root key operations ---------------------------
  reportRootKeyUsage(
    authorization: PurgeRetiredCommand["authorization"],
  ): Promise<Result<RootKeyReport>>;
  purgeRetiredSecretVersions(command: PurgeRetiredCommand): Promise<Result<PurgeReport>>;
}

/** The integration events this context publishes through the kernel outbox. */
export const SECRETS_EVENT_NAMES = [
  "secrets.credential.created",
  "secrets.credential.rotated",
  "secrets.credential.revoked",
  "secrets.credential.re_encrypted",
  "secrets.secret_version.purged",
  "secrets.environment_variable.set",
  "secrets.environment_variable.deleted",
] as const;

export type SecretsEventName = (typeof SECRETS_EVENT_NAMES)[number];

/**
 * Bind the use cases into the driving port.
 *
 * The composition root builds the dependency bundle from adapters and calls this
 * once. Nothing here holds state: it is a lookup table from a contract method to
 * the one use case that implements it, which is what keeps the contract from
 * quietly growing behaviour of its own.
 */
export function secretsContract(dependencies: SecretsDependencies): SecretsContract {
  const contract: SecretsContract = {
    name: "secrets",
    describeCredential: (query) => useCases.describeCredential(dependencies, query),
    listCredentials: (authorization) => useCases.listCredentials(dependencies, authorization),
    listEnvironmentVariables: (authorization) =>
      useCases.listEnvironmentVariables(dependencies, authorization),
    readSecret: (query) => useCases.readSecret(dependencies, query),
    readEnvironmentVariable: (query) => useCases.readEnvironmentVariable(dependencies, query),
    createCredential: (command) => useCases.createCredential(dependencies, command),
    rotateCredential: (command) => useCases.rotateCredential(dependencies, command),
    revokeCredential: (command) => useCases.revokeCredential(dependencies, command),
    reEncryptCredential: (command) => useCases.reEncryptCredential(dependencies, command),
    setEnvironmentVariable: (command) => useCases.setEnvironmentVariable(dependencies, command),
    deleteEnvironmentVariable: (command) =>
      useCases.deleteEnvironmentVariable(dependencies, command),
    reportRootKeyUsage: (authorization) => useCases.reportRootKeyUsage(dependencies, authorization),
    purgeRetiredSecretVersions: (command) =>
      useCases.purgeRetiredSecretVersions(dependencies, command),
  };
  return Object.freeze(contract);
}
