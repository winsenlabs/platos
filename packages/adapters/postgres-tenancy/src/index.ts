// `@platos/adapter-postgres-tenancy` — the PostgreSQL `TenancyRepository`.
//
// `apps/core-api/src/composition/adapter-bindings.ts` names this package and is
// the only file in the repository entitled to. Everything exported below is
// either the adapter itself, the options that configure it, or a refusal code a
// composition root has to be able to recognise without matching on a message.

export type { PostgresTenancyAdapter, PostgresTenancyOptions } from "./adapter.js";
export { buildPostgresTenancyAdapter, createPostgresTenancyAdapter } from "./adapter.js";

export type {
  TenancyClientOptions,
  TenancyDatabaseClient,
  TenancyPoolSettings,
  TenancyReader,
  TenancyTransactionClient,
} from "./client.js";
export {
  AdapterConfigurationError,
  buildDatasourceUrl,
  createTenancyDatabaseClient,
  DATABASE_URL_INVALID,
  FOREIGN_KEY_VIOLATION_CODE,
  isForeignKeyViolation,
  isUniqueViolation,
  POOL_SETTING_INVALID,
  UNIQUE_VIOLATION_CODE,
} from "./client.js";

export type { TenancyTransactions, TransactionTimeouts } from "./transaction.js";
export {
  createTenancyTransactions,
  TRANSACTION_NOT_OPEN,
  TRANSACTION_SCOPE_FOREIGN,
  TRANSACTION_SCOPE_UNKNOWN,
  TransactionScopeError,
} from "./transaction.js";

export {
  UNKNOWN_ORGANIZATION_ROLE,
  UNKNOWN_PRINCIPAL_TIER,
  UNKNOWN_PROJECT_ROLE,
  UnreadableRowError,
} from "./mapping.js";

// WIN-258 T2 — the identity-access half. Only the refusal codes and the factory
// leave this package: a composition root has to be able to recognise a refusal
// without matching on a message, and nothing else here is anyone else's.
export { createIdentityAccessRepository } from "./identity-repository.js";
export {
  EMAIL_NOT_NORMALISED,
  IdentityWriteRefused,
  ROTATION_OVERLAP_INVALID,
  TOKEN_HASH_MALFORMED,
  TOTP_SHAPE_INVALID,
} from "./identity-guards.js";
export {
  INCONSISTENT_AUTHORIZATION_SCOPE,
  UNKNOWN_AUTHORIZATION_SCOPE_KIND,
  UNKNOWN_IDENTITY_PRINCIPAL_TIER,
  UNKNOWN_IDENTITY_PROVIDER,
  UNRESOLVED_SCOPE_ANCESTRY,
} from "./identity-mapping.js";
export {
  BEARER_CREDENTIAL_ABSENT,
  UNKNOWN_BEARER_CREDENTIAL_KIND,
} from "./identity-bearer.js";
