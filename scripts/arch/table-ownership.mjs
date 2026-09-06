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
 * The ADAPTER that holds each owner's canonical PostgreSQL store.
 *
 * WHY THIS MAP HAS TO EXIST. The sole-writer rule says a canonical row has one
 * writing CONTEXT. ADR M0.3 §2 says a context's `domain/` and `application/` may
 * not import the ORM. Those two sentences are both right and, taken literally
 * together, they forbid the row from ever being written: the only package
 * allowed to write it is the only package not allowed to hold a client. The
 * missing third sentence is ADR M0.3 §4's own note on the adapter directory —
 * "the tenancy-database client; per-context repositories, owner-tagged" — which
 * says the owner's PostgreSQL adapter writes on the owner's behalf.
 *
 * WHY IT IS NOT "ANY ADAPTER WHOSE OWNER MATCHES". `redis-ratelimit` is owned by
 * `identity-access` and `notifier-email` by `cost-monitoring`; neither has any
 * business writing a canonical row, and a rule derived from the adapter table's
 * owner column would have granted both. Only a CANONICAL-STORE adapter is
 * listed, and it is listed by hand, so granting one is a decision somebody made
 * rather than a consequence of an unrelated table.
 *
 * THE OUTBOX PSEUDO-OWNER IS PRESENT, and it was not until WIN-258 T4. The note
 * that used to sit here said it needed no delegation "because it is already an
 * adapter: it resolves through `ownerDirectory`". That was true of the DIRECTORY
 * and false of the WRITE. `packages/adapters/outbox` may not hold the ORM — ADR
 * M0.3 §15 gives the client exactly one home and `tenancy-prisma-only` in
 * scripts/arch/boundary-rules.mjs enforces it — so the directory the pseudo-owner
 * resolves to is a directory that cannot issue an INSERT, and `Event` was in
 * exactly the position every other canonical row was in before this map existed:
 * owned by a package unable to write it. The delegation below is that same
 * amendment applied to the one owner that is an adapter rather than a context.
 */
export const CANONICAL_STORE_ADAPTERS = Object.freeze({
  // WIN-258. The PostgreSQL TenancyRepository. `tenancy-prisma-only` in
  // scripts/arch/boundary-rules.mjs names the same directory as the ORM's one
  // home, so the package permitted to write these rows and the package permitted
  // to hold the client are the same package by construction.
  tenancy: "packages/adapters/postgres-tenancy",

  // WIN-258 T2. The PostgreSQL IdentityAccessRepository — the SAME directory,
  // because there is one PostgreSQL database behind one client and ADR M0.3 §15
  // makes that one adapter directory rather than one per context.
  //
  // TWO OWNERS RESOLVING TO ONE DIRECTORY IS NOT THE SAME AS ONE OWNER LOSING
  // ITS BOUNDARY. Ownership here is carried by the owner TAG on the row, and
  // `checkSoleWriter` still asks, per WRITE, whether the file's directory is one
  // of `ownerDirectories(OWNER[model])`. A write to `Memory` from this package
  // still fails, because `memory` has no entry in this map; what this entry
  // grants is exactly the 23 rows `identity-access` owns.
  //
  // It is also what makes `AccessKeyStore` implementable at all.
  // `Environment.accessKeyRevocationVersion` — the fence a rotation and a
  // revoke race over — is a column on `Environment`, which `tenancy` owns. A
  // thirteenth adapter package holding only identity-access's repositories
  // could not have bumped it without writing a row it does not own; the shared
  // directory can, because it is already `tenancy`'s delegate.
  "identity-access": "packages/adapters/postgres-tenancy",

  // WIN-258 T4. The kernel outbox adapter's canonical store — the SAME
  // directory again, and for the same reason: `Event` lives in the one
  // PostgreSQL database, behind the one client, in the one file that imports it.
  //
  // WHAT THIS GRANTS, EXACTLY. `ownerDirectories("<kernel-outbox-adapter>")` now
  // returns the outbox adapter's own directory AND this one, and nothing else.
  // The outbox adapter keeps every decision that makes an event an event — the
  // ordered identifier, the instant, the envelope, the refusals — and this
  // directory holds the statement. A write to `Event` from any third place still
  // fails, and a write to any row this owner does not own still fails from here:
  // ownership is carried by the owner TAG on the row and `checkSoleWriter` asks
  // per WRITE, so this entry grants exactly the two rows the pseudo-owner owns,
  // `Event` and the superseded `ObservabilityOutbox`.
  "<kernel-outbox-adapter>": "packages/adapters/postgres-tenancy",

  // WIN-258 T5. The PostgreSQL `ToolsRepository` — the SAME directory for the
  // fourth time, and for the same sentence: one PostgreSQL database behind one
  // client is one adapter DIRECTORY (ADR M0.3 §15), not one package per context.
  //
  // WHAT THIS GRANTS, EXACTLY. The ten rows ADR M0.3 §1 row 7 gives `tools`:
  // `Tool`, `EnvironmentEntityTool`, `ToolHealth`, `ToolCall`, `ToolCallAudit`,
  // `AgentToolPolicy`, `EntityToolPolicy`, `EntityMcpConfig`, `EntityMcpClient`
  // and `OrganizationMcpPolicy`. Nothing wider. `checkSoleWriter` still asks, per
  // WRITE, whether the file's directory is one of `ownerDirectories(OWNER[model])`,
  // so a write to `Memory` or to `Budget` from this package still fails — the
  // ownership is carried by the owner TAG on the row and this entry moves no tag.
  //
  // IT IS ALSO WHAT MAKES `replaceExposures` IMPLEMENTABLE. That method is a
  // DELETE and two set-writes on `EnvironmentEntityTool` that must commit or roll
  // back together, and the transaction they run in is `TenancyTransactions` — the
  // one this directory already holds. A thirteenth adapter package holding only
  // this context's repository would have had its own pool, so a use case that
  // registered an entity's tools and bumped its environment's access-key fence
  // would have been two transactions with a window between them.
  tools: "packages/adapters/postgres-tenancy",

  // WIN-258 T5. The PostgreSQL `AgentsRepository` and `ScaffoldingRepository` —
  // the SAME directory a fifth time, and for the fourth time for the same
  // reason: one PostgreSQL database behind one client is one adapter directory
  // (ADR M0.3 §15), not one directory per context.
  //
  // WHAT THIS GRANTS, EXACTLY. The seven rows of ADR M0.3 §1 row 5 — `Agent`,
  // `AgentBinding`, `AgentCluster`, `AgentSkill`, `AgentVersion`, `Macro` and
  // `PostmanTemplate` — and nothing else. `ownerDirectories("agents")` now
  // returns `packages/contexts/agents` AND this one; every other owner is
  // unmoved, so a write to `Tool` or `Memory` from here still fails, and a write
  // to `Agent` from any third directory still fails.
  //
  // IT DOES NOT GRANT WHAT `agents` NEEDS AND DOES NOT OWN, and that turned out
  // to matter. `AgentSkill.environmentSkillId` is a foreign key into
  // `EnvironmentSkill`, which ADR M0.3 §1 row 6 gives to `skills`; `skills` has
  // no entry here, so this directory cannot create the row its own loadout write
  // depends on. The integration fixture seeds that chain as SQL applied by
  // `prisma db execute`, which is honest about the fact that the row belongs to
  // a context whose store does not exist yet, rather than reaching for a
  // permission the map deliberately withholds.
  agents: "packages/adapters/postgres-tenancy",

  // WIN-258 T5. The FIFTH context to resolve to this directory, and the reason
  // is unchanged from T2's: one PostgreSQL database is one client is one adapter
  // DIRECTORY (ADR M0.3 §15), and `tenancy-prisma-only` in
  // scripts/arch/boundary-rules.mjs names that directory as the ORM's only home.
  // A thirteenth adapter package holding `cost-monitoring`'s repositories would
  // have to import the client too, and the single-home rule would stop being
  // writable as a single-home rule.
  //
  // WHAT THIS GRANTS, EXACTLY: the SIX rows `cost-monitoring` owns — `Budget`,
  // `BudgetThresholdEvent`, `AlertChannel`, `AlertChannelConfiguration`,
  // `AlertDelivery` and `AlertDeliveryRetry`. Nothing else. `checkSoleWriter`
  // asks per WRITE whether the file's directory is one of
  // `ownerDirectories(OWNER[model])`, so a write to `Memory` or to `Turn` from
  // this package still fails, and a write to any of these six from anywhere else
  // still fails. Three owners resolving to one directory is not one owner losing
  // its boundary: the boundary is the owner TAG on the row.
  //
  // IT IS ALSO WHAT MAKES `BudgetRepository` IMPLEMENTABLE AT ALL. Without this
  // entry `ownerDirectories("cost-monitoring")` is `packages/contexts/cost-monitoring`
  // alone — and ADR M0.3 §2 forbids that package's `domain/` and `application/`
  // from importing the ORM, so the one package permitted to write these six rows
  // would be the one package unable to.
  "cost-monitoring": "packages/adapters/postgres-tenancy",

  // WIN-258 T5. The SIXTH context to resolve to this directory, and the reason
  // has not changed since T2's: one PostgreSQL database is one client is one
  // adapter DIRECTORY (ADR M0.3 §15), and `tenancy-prisma-only` in
  // scripts/arch/boundary-rules.mjs names that directory as the ORM's only home.
  //
  // WHAT THIS GRANTS, EXACTLY: the SIX rows `channels` owns — `ChannelApp`,
  // `ChannelAppThread`, `ChannelConnection`, `ChannelEventInbox`,
  // `ChannelInstallation` and `ChannelThread`. Nothing else. `checkSoleWriter`
  // asks per WRITE whether the file's directory is one of
  // `ownerDirectories(OWNER[model])`, so a write to `Thread` or to `Turn` from
  // this package still fails — `conversations` has no entry here — and a write
  // to any of these six from anywhere else still fails. Six owners resolving to
  // one directory is not six owners losing their boundaries: the boundary is the
  // owner TAG on the row, and this entry moves no tag.
  //
  // IT DOES NOT GRANT WHAT `channels` NEEDS AND DOES NOT OWN, and here that is
  // the interesting half. Every thread link is a foreign key into `Thread`,
  // which ADR M0.3 §1 row 16 gives to `conversations`; `Credential` belongs to
  // `secrets` and `Agent` to `agents`; none of the three has an entry here. So
  // this directory cannot create the rows its own link write depends on, and the
  // integration fixture seeds that chain as SQL applied by `prisma db execute` —
  // which is honest about the fact that the rows belong to contexts whose stores
  // do not exist yet, rather than reaching for a permission the map deliberately
  // withholds.
  channels: "packages/adapters/postgres-tenancy",

  // WIN-258 T5. The SEVENTH context to resolve to this directory, on the sentence
  // that has not changed since T2: one PostgreSQL database is one client is one
  // adapter DIRECTORY (ADR M0.3 §15), and `tenancy-prisma-only` in
  // scripts/arch/boundary-rules.mjs names that directory as the ORM's only home.
  //
  // WHAT THIS GRANTS, EXACTLY: the FIVE rows `governance` owns — `SafetyEvent`,
  // `MessageRating`, `EvalCriterion`, `AgentEval` and `GoldenSet`. Nothing else.
  // `checkSoleWriter` asks per WRITE whether the file's directory is one of
  // `ownerDirectories(OWNER[model])`, so a write to `Turn` or to `Thread` from
  // this package still fails — and those two matter here, because three of these
  // five rows hang off a `Thread` and `governance` reads all three through the
  // inverted read-seam ports in `application/ports/read-seams.ts` rather than
  // through a store of its own. The entry moves no owner TAG.
  //
  // IT IS ALSO WHAT MAKES THE ERASURE TARGET ATOMIC. `governance-erasure-target.ts`
  // counts a subject's safety events and ratings, then ANONYMISES the first and
  // DESTROYS the second, and the port signatures put both mutations in the
  // caller's `TransactionScope`. Those two tables are written by the same client
  // in the same transaction only because they resolve to the same directory; a
  // thirteenth adapter package holding `governance`'s five repositories would
  // have had its own pool, and an erasure that failed between the two halves
  // would have left the ledger anonymised and the votes intact.
  governance: "packages/adapters/postgres-tenancy",

  // WIN-258 T5. The EIGHTH context to resolve to this directory, on the sentence
  // every entry above stands on: one PostgreSQL database is one client is one
  // adapter DIRECTORY (ADR M0.3 §15), and `tenancy-prisma-only` in
  // scripts/arch/boundary-rules.mjs names that directory as the ORM's only home.
  //
  // WHAT THIS GRANTS, EXACTLY: the FOUR rows `secrets` owns — `Credential`,
  // `CredentialSecretVersion`, `CredentialAudit` and `EnvironmentVariable`.
  // Nothing else. `checkSoleWriter` asks per WRITE whether the file's directory
  // is one of `ownerDirectories(OWNER[model])`, so a write to `Memory` or to
  // `ProviderKey` from this package still fails, and a write to any of these
  // four from anywhere else still fails. `SecretReference` is NOT granted and
  // could not be: `UNOWNED_ADR_ROWS` above records that the ADR's fifth row for
  // this context does not exist in the canonical schema at all.
  //
  // IT IS ALSO WHAT MAKES THE `EnvironmentVariable` SEAM IMPLEMENTABLE.
  // `setEnvironmentVariable` seals a credential, writes its envelope, points the
  // credential at it, writes the variable row and appends two audit records, and
  // `enforce_win124_credential_kind` re-reads the credential from INSIDE the
  // variable's write to check it is unrevoked and already has an active version.
  // A thirteenth adapter package holding only this context's repositories would
  // have had its own pool: the credential would be uncommitted on one connection
  // while the rule that has to see it ran on another, and the rule would refuse
  // a row that is correct.
  //
  // THE CONVERSE IS ALSO TRUE AND IS WHY `ProviderKey` IS NOT GRANTED HERE. The
  // extraction source writes `ProviderKey` inside its secret store; ADR M0.3 §1
  // row 4 gives that row to `providers`, and `domain/credential.ts` records that
  // those three methods were deliberately not extracted for exactly that reason.
  // The `providers` entry below grants that row to its own owner — which is the
  // split the ADR describes and not a widening of this one: `secrets` still owns
  // the credential and its envelope, `providers` still owns the row that points
  // at them, and `checkSoleWriter` still asks per WRITE which owner a row has.
  secrets: "packages/adapters/postgres-tenancy",

  // WIN-258 T5. The NINTH context to resolve to this directory, on the sentence
  // the eight above stand on: one PostgreSQL database is one client is one
  // adapter DIRECTORY (ADR M0.3 §15), and `tenancy-prisma-only` in
  // scripts/arch/boundary-rules.mjs names that directory as the ORM's only home.
  //
  // WHAT THIS GRANTS, EXACTLY: the FOUR rows `providers` owns —
  // `EnvironmentProvider`, `Model`, `ModelPrice` and `ProviderKey`. Nothing
  // else. `checkSoleWriter` asks per WRITE whether the file's directory is one of
  // `ownerDirectories(OWNER[model])`, so a write to `Memory` or to `Turn` from
  // this package still fails, and a write to any of these four from anywhere
  // else still fails. Nine owners resolving to one directory is not nine owners
  // losing their boundaries: the boundary is the owner TAG on the row, and this
  // entry moves no tag.
  //
  // IT IS THE ENTRY THE COMMENT ON `secrets` ABOVE SAID WAS MISSING, and the
  // sentence it closes is worth keeping rather than deleting. That comment
  // records that the extraction source writes `ProviderKey` inside its secret
  // store, that ADR M0.3 §1 row 4 gives the row to `providers`, and that
  // `providers` "has no entry here, so this directory cannot write it" — which
  // is why `secrets/domain/credential.ts` records three methods as deliberately
  // not extracted. With this entry the directory CAN write it, and the split is
  // now the one the ADR describes: `secrets` owns the credential and its
  // envelope, `providers` owns the row that points at them, and both halves of
  // `register-provider-key.ts` are the same client and the same transaction.
  //
  // AND THAT IS WHAT MAKES `ProviderKey` WRITABLE AT ALL. `ProviderKey_credential
  // _provider_integrity` is a BEFORE INSERT OR UPDATE rule that RE-READS the
  // `Credential` from inside the key's own write, demanding one in the same
  // environment whose `provider` and `name` match the key's. A thirteenth adapter
  // package holding only `providers`' repository would have had its own pool: the
  // credential would be uncommitted on the `secrets` connection while the rule
  // that has to see it ran on this one, and the rule would refuse a row that is
  // correct. It is the `EnvironmentVariable` seam one tranche back, one table
  // over.
  //
  // IT DOES NOT GRANT WHAT `providers` NEEDS AND DOES NOT OWN. `AgentVersion`,
  // `AgentBinding` and `Agent` are `agents`' rows and `Credential` is `secrets`',
  // and this store READS all four — `countAgentVersionsPinning` walks the first
  // three to answer how many executable versions pin a key. Reads are
  // unrestricted by design (§1 restricts WRITES), and the integration fixture
  // seeds the versions it needs as SQL applied by `prisma db execute`, which is
  // honest about the fact that those rows belong to another context.
  providers: "packages/adapters/postgres-tenancy",

  // WIN-258 T5. The TENTH context to resolve to this directory, on the sentence
  // every entry above stands on: one PostgreSQL database is one client is one
  // adapter DIRECTORY (ADR M0.3 §15), and `tenancy-prisma-only` in
  // scripts/arch/boundary-rules.mjs names that directory as the ORM's only home.
  //
  // WHAT THIS GRANTS, EXACTLY: the FOUR rows `conversations` owns — `Thread`,
  // `Turn`, `Step` and `PostmanExecution`. Nothing else. `checkSoleWriter` asks
  // per WRITE whether the file's directory is one of
  // `ownerDirectories(OWNER[model])`, so a write to `Memory`, to `Artifact` or to
  // `ToolCallAudit` from this package still fails, and a write to any of these
  // four from anywhere else still fails.
  //
  // IT CLOSES A HOLE THE OTHER EIGHT ENTRIES HAD TO WORK AROUND. Until now
  // `conversations` had NO entry here, and three sibling harnesses said so in as
  // many words: `governance-harness.ts` seeds its `Thread` and `Turn` peers
  // through `prisma db execute` because "sole-writer.mjs refuses a write to
  // either from this directory, correctly", and the `channels` entry above
  // records the same for its thread links. Those fixtures are unchanged and stay
  // unchanged: this entry moves no owner TAG, so a `Thread` written from
  // `channels-links.ts` is still refused — what it grants is that
  // `conversations-threads.ts`, in the same directory, may write one.
  //
  // AND IT IS WHAT MAKES THE FOUR PORTS IMPLEMENTABLE AT ALL. Without it
  // `ownerDirectories("conversations")` is `packages/contexts/conversations`
  // alone, and ADR M0.3 §2 forbids that package's `domain/` and `application/`
  // from importing the ORM — so the one package permitted to write these four
  // rows would be the one package unable to.
  //
  // IT DOES NOT GRANT WHAT `conversations` NEEDS AND DOES NOT OWN, and here the
  // list is long because a turn touches everything: `Agent` and `AgentVersion`
  // are `agents`' (§1 row 5), `EndUser` is `identity-access`' (row 1),
  // `PostmanTemplate` is `agents`', `User` is `identity-access`' and `ModelPrice`
  // is `providers`' (row 4). `providers` has no entry here at all, and
  // `Step_price_snapshot` makes that bite: a priced step's four rates must match
  // a real `ModelPrice` row exactly, and this directory cannot create one. The
  // integration fixture seeds that chain as SQL applied by `prisma db execute`,
  // which is honest about the fact that the rows belong to contexts whose stores
  // do not exist yet, rather than reaching for a permission the map withholds.
  conversations: "packages/adapters/postgres-tenancy",
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
