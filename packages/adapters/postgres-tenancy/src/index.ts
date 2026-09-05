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

// WIN-258 T3 — tenancy's other five ports add NOTHING to this entry point, and
// that is the decision rather than an omission. All five leave through
// `PostgresTenancyAdapter`'s own properties, because a composition root that
// built one of them itself would give it a second `TenancyTransactions` and get
// a lock on one ambient frame with the write it serializes on another. Nothing
// else about them is anyone else's: the advisory-lock key, the token prefix and
// the two narrow peer-port aliases are used by their own siblings and by this
// package's suites, and `apps/core-api/src/app.module.ts` says why an entry
// point nothing imports is dead surface rather than optionality.

// WIN-258 T4 — the canonical `Event` row, written on the kernel outbox adapter's
// behalf (ADR M0.3 §1 closing note, §15). The two refusal codes leave the
// package because a composition root has to tell "already appended" from "no
// such environment" without reading a message; the row types leave it because
// the composition root proves, at compile time, that this adapter satisfies the
// `OutboxEventStore` seam the outbox package declares.
export type {
  OutboxEventStorePort,
  OutboxInsertRow,
  OutboxReadCursor,
  OutboxReadRow,
} from "./outbox-store.js";
export {
  createOutboxEventStore,
  ENVIRONMENT_UNKNOWN,
  EVENT_ID_TAKEN,
  OutboxStoreError,
} from "./outbox-store.js";

// WIN-258 T5 — `cost-monitoring`'s canonical store. The factory and the refusal
// codes leave the package for the reason tranche 2's do: a composition root has
// to be able to recognise a refusal without matching on a message, and a
// composition root that wanted this repository WITHOUT tenancy's — a background
// dispatcher, say — has to be able to build one over the same transactions.
//
// The three store composites behind it add nothing here, deliberately. Building
// one alone would give it a `TenancyTransactions` of its own, and a claim issued
// on one ambient frame would then be invisible to a fan-out serialised on
// another; `createCostMonitoringRepository` is the only door, and it takes the
// transactions rather than a client so there is no second one to build.
export { createCostMonitoringRepository } from "./cost-repository.js";
export {
  BUDGET_LIMIT_OUT_OF_RANGE,
  BUDGET_THRESHOLDS_INVALID,
  CHANNEL_DEDUPE_SHAPE_INVALID,
  CHANNEL_NAME_INVALID,
  CHANNEL_TOPICS_EMPTY,
  CROSSING_SPEND_NOT_REPRESENTABLE,
  CROSSING_VALUES_INVALID,
  CostWriteRefused,
  DELIVERY_KIND_SHAPE_INVALID,
  DELIVERY_STATE_INCOHERENT,
  IDENTIFIER_NOT_UUID,
  RETRY_RECORD_INVALID,
} from "./cost-guards.js";
export {
  CHANNEL_CONFIGURATION_ABSENT,
  CHANNEL_CONFIGURATION_INCOHERENT,
  UNKNOWN_BUDGET_PERIOD,
  UNREADABLE_ALERT_THRESHOLDS,
  UNREADABLE_CROSSING_SPEND,
} from "./cost-rows.js";

// WIN-258 T5 — `governance`'s five canonical stores. The factory leaves the
// package for the reason `createCostMonitoringRepository` does: a composition
// root that wanted these five WITHOUT tenancy's — an erasure worker, say — has
// to be able to build them over the same transactions. The refusal codes leave
// it because a root has to tell a value the schema will not hold from a row this
// binary cannot read, without matching on a message.
//
// The five stores behind it add nothing here, deliberately. Building one alone
// would give it a `TenancyTransactions` of its own, and a plan counted on one
// ambient frame would then be invisible to the erasure serialised on another;
// `createGovernanceStores` is the only door, and it takes the transactions
// rather than a client so there is no second one to build.
export type { GovernanceStores } from "./governance-repository.js";
export { createGovernanceStores, createInstantSource } from "./governance-repository.js";
export {
  CRITERION_SCALE_NOT_REPRESENTABLE,
  EVAL_COST_NOT_REPRESENTABLE,
  EVAL_LATENCY_INVALID,
  EVAL_SCORE_NOT_FINITE,
  GOVERNANCE_IDENTIFIER_NOT_UUID,
  GovernanceWriteRefused,
  RATING_OUTSIDE_SCHEMA_RANGE,
  RATING_REVISION_INVALID,
  SAFETY_METADATA_RESERVED,
} from "./governance-guards.js";
export {
  SAFETY_METADATA_MARKER,
  UNKNOWN_SAFETY_ACTION,
  UNKNOWN_SAFETY_DETECTOR,
  UNKNOWN_SAFETY_SEVERITY,
  UNREADABLE_CRITERION_SNAPSHOT,
  UNREADABLE_EVAL_COST,
  UNREADABLE_SAFETY_METADATA,
} from "./governance-rows.js";
