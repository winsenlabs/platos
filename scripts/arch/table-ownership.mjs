// ADR M0.3 §5.2 — the canonical-row ownership map.
//
// The ADR's cutting rule is that "every canonical row has exactly ONE context
// permitted to write it". §1's SOLE WRITER column states that rule in prose.
// This module is that column as data, so it can be enforced instead of admired,
// and so `scripts/arch/sole-writer.mjs` and any future enforcer read the same
// source of truth — the property §5.1 asks for and that `boundary-rules.mjs`
// already provides for the import graph.
//
// WHY IT IS NOT AT THE PATH THE ADR NAMES. §5.2 specifies
// `contexts/_meta/table-ownership.ts`. That location is uninhabitable: §5.1 rule
// (l) `unknown-context-directory` requires every directory under
// `packages/contexts/` to be one of the 17 named contexts, and it is judged per
// FILE, so the file would fail the moment it was created. Reproduced:
//
//   $ printf 'export const OWNER = {};\n' > packages/contexts/_meta/table-ownership.ts
//   $ node scripts/arch/arch-boundaries.mjs
//   FAIL [unknown-context-directory] packages/contexts/_meta/table-ownership.ts -> _meta
//
// Rule (l) is right and stays. The map lives here instead, beside
// `boundary-rules.mjs`, which is already the single source of truth for the
// other half of the same ADR section.
//
// SCOPE. This map covers `internal-packages/tenancy-database/prisma/schema.prisma`
// — PostgreSQL, the charter's "canonical operational truth". The legacy
// `internal-packages/database` schema is the durable-runtime adapter's own store;
// ADR M0.3 §7 decision 10 puts the whole of it behind the one `DurableRuntime`
// port, so it has a single blanket owner rather than per-model rows.

/** The one context permitted to WRITE each canonical row. Reads are unrestricted. */
export const OWNER = Object.freeze({
  // ADR §1 row 1. The DAG leaf that kills all three wrong-way auth edges.
  // AccessKeyBootstrapGrant is NOT in ADR §1: WIN-296 added it after the ADR was
  // frozen, to close the credential-free first-install AccessKey bypass.
  AccessKey: "identity-access",
  AccessKeyBootstrapGrant: "identity-access",
  AuthRateLimitBucket: "identity-access",
  EndUser: "identity-access",
  EndUserIdentity: "identity-access",
  EndUserSession: "identity-access",
  ImpersonationAudit: "identity-access",
  MagicLinkToken: "identity-access",
  McpAnonymousSession: "identity-access",
  McpBearerToken: "identity-access",
  McpOidcSession: "identity-access",
  McpToken: "identity-access",
  OAuthAccessToken: "identity-access",
  OAuthAuthorizationCode: "identity-access",
  OAuthClient: "identity-access",
  OAuthConsentTransaction: "identity-access",
  OAuthRefreshToken: "identity-access",
  OperatorIdentity: "identity-access",
  OperatorMfaRecoveryCode: "identity-access",
  OperatorMfaTotp: "identity-access",
  OperatorSession: "identity-access",
  PersonalAccessToken: "identity-access",
  User: "identity-access",

  // ADR §1 row 2. NOTE: Entity hangs off Project, not Environment — the
  // charter's org/project/environment/entity chain is not the schema shape.
  Entity: "tenancy",
  Environment: "tenancy",
  EnvironmentSession: "tenancy",
  Organization: "tenancy",
  OrganizationInvitation: "tenancy",
  OrganizationMembership: "tenancy",
  Project: "tenancy",
  ProjectMembership: "tenancy",

  // ADR §1 row 3. SecretReference is absent — see UNOWNED_ADR_ROWS below.
  Credential: "secrets",
  CredentialAudit: "secrets",
  CredentialSecretVersion: "secrets",
  EnvironmentVariable: "secrets",

  // ADR §1 row 4. Absorbs provider-health, moved out of auth.
  EnvironmentProvider: "providers",
  Model: "providers",
  ModelPrice: "providers",
  ProviderKey: "providers",

  // ADR §1 row 5. AgentSkill per §7 decision 5 (loadout is authoring).
  Agent: "agents",
  AgentBinding: "agents",
  AgentCluster: "agents",
  AgentSkill: "agents",
  AgentVersion: "agents",
  Macro: "agents",
  PostmanTemplate: "agents",

  // ADR §1 row 6.
  EnvironmentSkill: "skills",
  ProjectSkill: "skills",
  Skill: "skills",

  // ADR §1 row 7 — the tool-gateway + mcp-platform merge.
  // ToolCall sits here per §7 decision 4: the executor owns the execution record.
  AgentToolPolicy: "tools",
  EntityMcpClient: "tools",
  EntityMcpConfig: "tools",
  EntityToolPolicy: "tools",
  EnvironmentEntityTool: "tools",
  OrganizationMcpPolicy: "tools",
  Tool: "tools",
  ToolCall: "tools",
  ToolCallAudit: "tools",
  ToolHealth: "tools",

  // ADR §1 row 8.
  Memory: "memory",
  MemoryEntity: "memory",
  MemoryRelationship: "memory",

  // ADR §1 row 9.
  ChannelApp: "channels",
  ChannelAppThread: "channels",
  ChannelConnection: "channels",
  ChannelEventInbox: "channels",
  ChannelInstallation: "channels",
  ChannelThread: "channels",

  // ADR §1 row 10.
  Artifact: "files",
  MessageAttachment: "files",

  // ADR §1 row 12. Its ClickHouse projections are not Prisma rows.
  AdminAudit: "observability",

  // ADR §1 row 13. Finally owns BudgetService, formerly ownerless.
  AlertChannel: "cost-monitoring",
  AlertChannelConfiguration: "cost-monitoring",
  AlertDelivery: "cost-monitoring",
  AlertDeliveryRetry: "cost-monitoring",
  Budget: "cost-monitoring",
  BudgetThresholdEvent: "cost-monitoring",

  // ADR §1 row 14. Implements the kernel SafetyEventSink.
  AgentEval: "governance",
  EvalCriterion: "governance",
  GoldenSet: "governance",
  MessageRating: "governance",
  SafetyEvent: "governance",

  // ADR §1 row 15.
  AgentApproval: "jobs",
  Job: "jobs",

  // ADR §1 row 16. The turn engine: a pure DAG sink.
  PostmanExecution: "conversations",
  Step: "conversations",
  Thread: "conversations",
  Turn: "conversations",

  // ADR §1 row 17. PlatformNotification and PlatformNotificationInteraction
  // are absent — see UNOWNED_ADR_ROWS below.
  NotificationRule: "eventing",

  // ADR §1 row 18. Consumes kernel ErasureTarget[]; imports nobody's internals.
  ErasureOperation: "privacy",
  ErasureTombstone: "privacy",

  // ADR §1 closing note and §7 decision 8: the Event table is written ONLY by
  // the kernel outbox adapter — an infrastructure adapter at the composition
  // root, not a context — so any context may append() through OutboxWriter while
  // single-writer still holds.
  // ObservabilityOutbox is NOT named anywhere in ADR §1, yet it exists in the
  // schema. §7 decision 8 chose ONE physical outbox with multiple drains over the
  // spine's separate observability outbox, so this row is that superseded second
  // outbox. It is given the same owner as Event and is retired into it by WIN-275.
  Event: "<kernel-outbox-adapter>",
  ObservabilityOutbox: "<kernel-outbox-adapter>",
});

/**
 * The canonical schema this map covers. Read at check time so the map cannot
 * silently drift from the tree: a model added without an owner fails.
 */
export const CANONICAL_SCHEMA = "internal-packages/tenancy-database/prisma/schema.prisma";

/**
 * ADR M0.3 §1 assigns these rows to a context, but they are NOT in the canonical
 * schema. They are not oversights in this map — they are places where the frozen
 * ADR and the tree disagree, recorded rather than quietly dropped.
 *
 * Each names where the row actually lives and what already superseded the ADR's
 * assumption. None of them may be given an owner here: the sole-writer rule
 * governs canonical PostgreSQL rows, and these are not among them.
 */
export const UNOWNED_ADR_ROWS = Object.freeze({
  // ADR §1 row 3 lists it under `secrets`. It exists only in the legacy schema
  // (with a cuid key and a provider enum), and docs/model-disposition.md already
  // retired it: "SecretReference -> Credential — Merge secret metadata/reference
  // into one credential record with encrypted material stored behind a provider
  // boundary." The merge has happened; `Credential` is the surviving row.
  SecretReference: "merged into Credential before the ADR was written",

  // ADR §1 row 17 lists both under `eventing`. Both exist only in the legacy
  // schema, so neither is a canonical tenancy row today. `NotificationRule`, the
  // third row on that line, IS canonical and IS owned above.
  PlatformNotification: "legacy schema only; not a canonical tenancy row",
  PlatformNotificationInteraction: "legacy schema only; not a canonical tenancy row",
});

/**
 * ADR M0.3 §7 decision 10: the durable-runtime adapter owns the ENTIRE vendor
 * database behind one kernel port, so that schema needs no per-model rows. This
 * blanket entry is what makes "no domain context touches it" checkable.
 */
export const BLANKET_OWNER = Object.freeze({
  schema: "internal-packages/database/prisma/schema.prisma",
  owner: "packages/adapters/durable-runtime",
  reason: "ADR M0.3 §7 decision 10 — full encapsulation behind the DurableRuntime port",
});

/** Prisma delegate methods that WRITE. Reads are deliberately unrestricted. */
export const MUTATING_DELEGATE_METHODS = Object.freeze([
  "create",
  "createMany",
  "createManyAndReturn",
  "update",
  "updateMany",
  "updateManyAndReturn",
  "upsert",
  "delete",
  "deleteMany",
]);

/**
 * Prisma delegate methods that only READ. §1 restricts WRITES, so these are
 * exempt by design.
 *
 * This list is EXHAUSTIVE on purpose, and is the counterpart to
 * `MUTATING_DELEGATE_METHODS` rather than its complement. Before WIN-256's
 * defect close-out the lint treated "not in the mutating list" as a read, which
 * made every method it had never heard of — including a computed one — silently
 * safe. A delegate method in neither list is now INDETERMINATE and fails, so a
 * new Prisma API cannot arrive as a hole.
 */
export const READ_DELEGATE_METHODS = Object.freeze([
  "aggregate",
  "aggregateRaw",
  "count",
  "findFirst",
  "findFirstOrThrow",
  "findMany",
  "findRaw",
  "findUnique",
  "findUniqueOrThrow",
  "groupBy",
]);

/**
 * Client-level raw-SQL entry points. These are NOT delegate methods — they hang
 * off the client, not off `db.<model>` — which is why they are a separate list
 * rather than entries in `MUTATING_DELEGATE_METHODS`. They are the second door
 * into every table: `$executeRawUnsafe("INSERT INTO ...")` writes a row that no
 * delegate call ever names, and `$queryRaw` is read-SHAPED but not read-ONLY.
 *
 * All four are judged identically, and deliberately: by the SQL, not by the
 * method's reputation. A statically visible statement is attributed to the
 * owner of the table it names; a statement assembled at runtime cannot be
 * attributed at all and fails. Splitting them into "execute writes / query
 * reads" would have been a distinction the evidence does not support —
 * `$queryRaw\`INSERT INTO …\`` writes, and it was one of the six probes that
 * got through.
 */
export const RAW_SQL_METHODS = Object.freeze([
  "$executeRaw",
  "$executeRawUnsafe",
  "$queryRaw",
  "$queryRawUnsafe",
]);

/**
 * SQL statements that write. Matched against whitespace-normalised, lowercased
 * text, with the table identifier captured so the statement can be attributed
 * to an owner exactly as a delegate call is.
 *
 * `do update` (the `ON CONFLICT` tail) and `for update` (row locking on a
 * SELECT) are excluded by lookbehind: both are followed by something that is
 * not a table, and both would otherwise report a false mutation.
 */
export const MUTATING_SQL_STATEMENT =
  /(?<!\bdo )(?<!\bfor )\b(insert into|update|delete from|truncate table|truncate|merge into|alter table|drop table|create table)\s+([^\s(;,]+)/gu;

/** Every context named as an owner, plus the outbox adapter pseudo-owner. */
export function owners() {
  return [...new Set(Object.values(OWNER))].sort();
}

/** Lower-camel Prisma delegate name for a model, e.g. OAuthClient -> oAuthClient. */
export function delegateName(model) {
  return model.charAt(0).toLowerCase() + model.slice(1);
}

/** Model name for a delegate, or null when no canonical model claims it. */
export function modelForDelegate(delegate) {
  for (const model of Object.keys(OWNER)) {
    if (delegateName(model) === delegate) return model;
  }
  return null;
}
