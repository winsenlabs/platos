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

// WIN-258 T5 — `channels`' canonical store. The factory leaves the package for
// the reason `cost-monitoring`'s does: a composition root that wanted this
// repository WITHOUT tenancy's — an inbox poller, say — has to be able to build
// one over the same transactions, and it takes the transactions rather than a
// client so there is no second `AsyncLocalStorage` frame to build.
//
// THE REFUSAL CODES LEAVE IT BECAUSE THEY ARE DECISIONS, not messages. Three of
// them are distinctions a caller ACTS on and cannot make any other way:
// `scope_ancestry_forged` separates a caller lying about a tenant from
// `unknown_environment`, which is a deleted one; `thread_link_race_lost`
// separates a genuine concurrent loser — whose winning thread this store cannot
// name, because the database has already aborted the transaction that would read
// it — from the ordinary conflict, which names it; and `turn_already_linked`
// separates two events made to share one turn from a redelivery, which the
// in-memory double cannot tell apart at all.
//
// The four stores behind the composite add nothing here, deliberately, for the
// reason cost-monitoring's three do not: building one alone would give it a
// `TenancyTransactions` of its own, and a lease claimed on one ambient frame
// would then be invisible to a completion serialised on another.
export { createChannelsRepository } from "./channels-repository.js";
export {
  CHANNELS_SCOPE_FORGED,
  CHANNELS_SCOPE_UNKNOWN,
} from "./channels-connections.js";
export { CLAIM_LIMIT_INVALID, TURN_ALREADY_LINKED } from "./channels-inbox.js";
export { THREAD_LINK_RACE_LOST } from "./channels-links.js";
//
// TWO OF THEM ARE ALIASED HERE, and the collision is real rather than
// cosmetic. `cost-monitoring` already publishes an `IDENTIFIER_NOT_UUID` and
// `identity-access` an `UNRESOLVED_SCOPE_ANCESTRY`, and the three pairs are
// DIFFERENT strings for different tables: cost's reads `cost.write.
// identifier_not_uuid` while this one is the bare `identifier_not_uuid` that
// travels inside `${operation}:${code}:${field}`. Exporting both under one name
// is not possible and would not be honest if it were, so the newcomer takes the
// prefix its context already puts on every error code it mints.
export {
  DISTRIBUTION_UNKNOWN,
  EVENT_LEASE_INCOHERENT,
  EVENT_STATUS_UNKNOWN,
  GENERATION_NEGATIVE,
  IDENTIFIER_NOT_UUID as CHANNELS_IDENTIFIER_NOT_UUID,
  INSTALLATION_STATUS_UNKNOWN,
  PROVIDER_UNKNOWN,
  REFRESH_FENCE_INCOHERENT,
  REFRESH_STATE_UNKNOWN,
  ROUTING_NOT_ARRAY,
  ROUTING_RULE_MALFORMED,
  ROUTING_TOO_MANY_RULES,
  SEALED_PAYLOAD_INVALID,
  TEXT_LIST_INVALID,
  THREAD_KEY_INVALID,
} from "./channels-guards.js";
export {
  UNREADABLE_EVENT_STATUS,
  UNREADABLE_INSTALLATION_STATUS,
  UNREADABLE_REFRESH_STATE,
  UNREADABLE_ROUTING,
  UNRESOLVED_SCOPE_ANCESTRY as CHANNELS_UNRESOLVED_SCOPE_ANCESTRY,
} from "./channels-rows.js";
