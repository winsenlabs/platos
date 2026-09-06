// The single `TenancyRepository` implementation. The vendor client is imported
// in `./client.js` and nowhere else in the repository.
//
// WHAT THIS FILE IS FOR. `PostgresTenancyAdapter` is the type `apps/core-api`
// binds: `PORT_SATISFACTION` in the composition root resolves
// `Satisfies<PostgresTenancyAdapter, TenancyRepository>` at compile time, so if
// this interface ever stops extending the port the build fails at the place the
// mistake matters. The three repository modules it is assembled from are split
// by concern rather than by method count, and the split is what keeps each of
// them inside ADR M0.3 §6's file budget.
//
// THE UNIT OF WORK SHIPS WITH THE REPOSITORY. They are one adapter because they
// are one connection: the transaction the `UnitOfWork` opens is the transaction
// the repository's writes have to be inside, and handing a caller two objects
// from two factories would make "which pool is this transaction on" a question
// with more than one answer.
//
// AND SO DOES THE IDENTITY-ACCESS REPOSITORY, for exactly that reason widened by
// one context (ADR M0.3 §15). `tenancy` and `identity-access` own rows in the
// SAME PostgreSQL database, so their repositories are the same connection and
// the same transaction. A use case that creates an organization and its first
// owner's session is atomic across both without either context knowing the other
// has a store — and a second adapter package would have made that two pools, two
// transactions and a window in which one half is committed.
//
// AND SO DO TENANCY'S OTHER FIVE PORTS (WIN-258 T3). `TenancyDependencies` names
// six driven ports and only ONE of them is the repository: a row lock and an
// advisory lock, a session revoker, an access-key revocation counter, an
// invitation token issuer and an operator directory. Five of the six are here
// because they are the same connection as the sixth — the lock a use case takes
// has to be held by the transaction its writes are in, and a revocation ordered
// by a role change has to commit or roll back with it. The token issuer is the
// exception that proves the rule: it touches no database at all and is here only
// because a context asked for a port and something has to satisfy it.
//
// AND SO DOES THE `tools` REPOSITORY (WIN-258 T5), for the third time and for
// the same one sentence: `Tool`, `EnvironmentEntityTool`, `ToolHealth`,
// `ToolCall`, `ToolCallAudit`, `AgentToolPolicy`, `EntityToolPolicy`,
// `EntityMcpConfig`, `EntityMcpClient` and `OrganizationMcpPolicy` live in the
// SAME PostgreSQL database behind the SAME client. Its twenty-five names —
// twenty-five methods, no properties — collide with nothing tenancy or
// identity-access publishes, which is what lets the composite be SPREAD in and
// therefore lets `PORT_SATISFACTION` resolve `PostgresTenancyAdapter extends
// ToolsRepository` at compile time. A nested property could not satisfy that.
//
// AND SO DOES THE KERNEL OUTBOX'S `Event` WRITE (WIN-258 T4). `Event` is the one
// canonical row whose owner is an adapter rather than a context, and Amendment
// 15 gives the ORM a single home — so the package that owns the outbox port
// cannot be the package that issues its INSERT. `packages/adapters/outbox` keeps
// every decision that makes an event an event and hands a prepared row of
// primitives across the `OutboxEventStore` seam; the two statements that satisfy
// that seam are `./outbox-store.js`, spread in below.
//
// AND SO DO `agents`' TWO CANONICAL-STORE PORTS (WIN-258 T5). The seven rows of
// ADR M0.3 §1 row 5 are in the same PostgreSQL database as the other thirty-one,
// so by Amendment 15 they are written from the same directory behind the same
// client. Both are SPREAD IN, for the reason every composite above is: the
// composition root resolves `Satisfies<PostgresTenancyAdapter, AgentsRepository>`
// and `Satisfies<PostgresTenancyAdapter, ScaffoldingRepository>` at compile time,
// and a nested property could satisfy neither. The two ports are disjoint from
// each other by construction and share no method name with tenancy's,
// identity-access's, tools' or the outbox's.
//
// AND SO DO `governance`'s FIVE CANONICAL-STORE PORTS (WIN-258 T5). `SafetyEvent`,
// `MessageRating`, `EvalCriterion`, `AgentEval` and `GoldenSet` are in that same
// database behind that same client, so by Amendment 15 they are written from this
// directory too — the SIXTH owner delegated to it. They are the one delegation
// here that CANNOT be spread in: the five ports collide with each other on
// `findById`, `page`, `create`, `update` and `remove`, so they arrive as five
// named properties and `PORT_SATISFACTION` proves each through the property that
// carries it, exactly as it does for tenancy's five non-repository ports. The
// context's other five ports are deliberately absent: `read-seams.ts` declares
// three READERS of rows four OTHER contexts own, `judge.ts` is a provider
// transport, and `eval-run-queue.ts` is durable work whose own refusal code
// exists to stay separable from a store outage.
//
// AND SO DO `secrets`' TWO CANONICAL-STORE PORTS (WIN-258 T5) — but as
// PROPERTIES rather than as spread-in methods, and that is the one exception in
// this file that was FORCED rather than chosen. `SecretsRepository.appendAudit`
// and `ToolsRepository.appendAudit` are both top-level members, with different
// signatures, so `PostgresTenancyAdapter extends ToolsRepository,
// SecretsRepository` is a TypeScript error — "cannot simultaneously extend" —
// and a spread would have let whichever composite came last silently win. Named
// properties are what tranche 3 already does for tenancy's five
// non-repository ports, and the composition root proves each binding by indexing
// the property that carries it rather than the adapter itself.
//
// AND SO DOES `cost-monitoring`'s `BudgetRepository` (WIN-258 T5). Its six rows
// are in that same database behind that same client, so by Amendment 15 they
// are written from this directory too — the FIFTH owner delegated to it. Its
// twenty-two method names collide with nothing above, so it is spread in like
// the rest and `PORT_SATISFACTION` can resolve
// `Satisfies<PostgresTenancyAdapter, BudgetRepository>` at compile time. The
// context's three OTHER ports are deliberately not here: `SpendLedger` is an
// expiring counter keyspace, `BudgetCapCache` is the cache ADR M0.3 §7 chose so
// the pre-spend guard would not read the canonical store on the hot path, and
// `Notifier` is a transport bound to the two notifier packages.
//
// AND SO DOES `channels`' `ChannelsRepository` (WIN-258 T5). The six rows of ADR
// M0.3 §1 row 9 are in that same database behind that same client — the SIXTH
// owner delegated to this directory — so Amendment 15 puts them here rather than
// in a thirteenth package holding a second client. Its seventeen method names
// collide with nothing above, so it is spread in like the rest and
// `PORT_SATISFACTION` can resolve
// `Satisfies<PostgresTenancyAdapter, ChannelsRepository>` at compile time. The
// context's four OTHER ports are deliberately not here and
// `channels-repository.ts` says why for each: `ChannelAdapter` and
// `ChannelAdapterRegistry` are the provider seam §5.1(h) pins to
// `packages/adapters/channel-slack`, `ChannelCredentialReader` reads a vault
// this directory holds no grant for, `AgentDirectory` is a peer read across an
// edge the §1 DAG does not grant, and `ChannelEventCipher` is the key that opens
// every inbox row — which is the one thing the process that stores them must not
// hold.
//
// AND SO DO `memory`'s TWO CANONICAL-STORE PORTS (WIN-258 T5) — the TWELFTH owner
// delegated to this directory, and the SECOND whose ports are PROPERTIES because
// a name collided. `Memory`, `MemoryEntity` and `MemoryRelationship` are in the
// same database behind the same client, so Amendment 15 puts them here; but
// `KnowledgeGraphRepository.findEntity(subject, agentIds, entityId)` and
// `TenancyRepository.findEntity(entityId)` are one name with two signatures, so
// this interface cannot extend both and the two ports arrive under
// `MemoryDependencies`' own slot names instead. The context's four OTHER ports
// are deliberately absent and `memory-repository.ts` says why for each: `Cache`
// is ADR M0.3 §13's named assignment to this context with Redis as the
// implementation detail, `EmbeddingModel` and `ExtractionJudge` are priced
// provider calls, and `ContentDigest` is a synchronous host hash with no failure
// channel and no row.
//
// AND SO DOES `files`' `FilesRepository` (WIN-258 T5). `MessageAttachment` and
// `Artifact` are in that same database behind that same client — the THIRTEENTH
// owner delegated to this directory — so Amendment 15 puts them here rather than
// in a fourteenth package holding a second client. Its fifteen method names
// collide with nothing above, so it is SPREAD IN like the six repository
// composites and `PORT_SATISFACTION` resolves `PostgresTenancyAdapter extends
// FilesRepository` at compile time, which a nested property could not.
//
// THE CONTEXT'S OTHER PORT IS NOT HERE AND HAS AN ADAPTER OF ITS OWN.
// `ObjectStore` is `files`' adapter-facing port (ADR M0.3 §13) and
// `objectstore-minio` satisfies it; `files` is therefore the one context this
// layout reaches from TWO adapter directories, one for its rows and one for its
// bucket. That split is load-bearing rather than tidy: `domain/destruction.ts`
// fixes blob-before-row precisely because no transaction spans the two systems,
// and a store that held both would have made that ordering look like an
// implementation detail it could optimise away.

// AND SO DOES `observability`'s `ObservabilityRepository` (WIN-258 T5) — the
// THIRTEENTH owner delegated here, and the one whose port the real database
// proves it cannot fully honour. `AdminAudit` is ADR M0.3 §1 row 12's single
// Prisma row, in the same database behind the same client, so Amendment 15 puts
// it here; but the initial migration makes that table APPEND-ONLY — a rule on
// UPDATE, on DELETE and on TRUNCATE, plus the matching privileges withdrawn from
// PUBLIC — so `clearAdminAuditActor`, which the port defines as an UPDATE
// returning rows changed, can only ever return zero or refuse.
// `observability-audit.ts` sends the statement and maps the database's refusal
// under its own code rather than inventing a count, and the two halves of that
// behaviour are named cases rather than prose. The context's three other driven
// ports are absent for reasons `observability-repository.ts` gives one by one.

// AND SO DOES `providers`' `ProvidersRepository` (WIN-258 T5). The four rows of
// ADR M0.3 §1 row 4 — `ProviderKey`, `EnvironmentProvider`, `Model` and
// `ModelPrice` — are in that same database behind that same client, so Amendment
// 15 puts them here rather than in a thirteenth package holding a second client.
// Its eighteen method names collide with nothing above, so it is spread in like
// the rest and `PORT_SATISFACTION` can resolve
// `Satisfies<PostgresTenancyAdapter, ProvidersRepository>` at compile time.
//
// IT IS ALSO WHAT MAKES `register-provider-key.ts` ATOMIC. That use case creates
// a credential through `secrets` and then writes the `ProviderKey` that points
// at it, and `ProviderKey_credential_provider_integrity` RE-READS that
// credential from inside the key's own INSERT. `secrets` resolves to this same
// directory, so both halves are the same client and the same transaction; two
// pools would have had the rule looking for a row still uncommitted on the
// other connection.
//
// The context's two OTHER ports are deliberately not here: `ModelRouter` is the
// provider SDK boundary §5.1 rule (h) pins to
// `packages/adapters/model-router-providers`, and `ProviderProbeCache` is a
// five-minute memo of what a provider said — backing it with the canonical store
// would put a provider's transient answers into the database the port exists to
// keep them out of.
//
// AND SO DOES `privacy`'s `PrivacyRepository` (WIN-258 T5). The two rows of ADR
// M0.3 §1 row 18 — `ErasureOperation` and `ErasureTombstone` — are in that same
// database behind that same client, so Amendment 15 puts them here rather than in
// a thirteenth package holding a second one. Its ten method names collide with
// nothing above, so it is spread in like the rest and `PORT_SATISFACTION` can
// resolve `Satisfies<PostgresTenancyAdapter, PrivacyRepository>` at compile time.
//
// IT IS THE ENTRY THAT MAKES A MULTI-CONTEXT ERASURE ATOMIC AT ALL, which is a
// sharper argument than any other owner in this file has. `run-erasure-pass.ts`
// opens ONE unit of work and asks every injected `ErasureTarget` to carry out its
// plan inside it, then writes this context's own progress row. Those targets are
// `conversations`' erasure store, `memory`'s two stores, `governance`'s ledger
// and `skills`' anonymiser — every one of them already in this directory, on this
// `TenancyTransactions`. A separate package for `privacy` would have minted the
// `TransactionScope` on a second ambient frame, and every target would have
// refused it `scope_unknown`: the erasure would not have been non-atomic, it
// would not have run.
//
// The context's THREE other ports are deliberately absent and
// `privacy-repository.ts` says why for each: `SubjectDirectory` reads
// `identity-access`' identity graph, which this directory can physically read and
// this port is not entitled to; `SubjectHasher` is a synchronous salted digest
// whose secret has no business behind a database client; and `LegalHoldRegister`
// is installation configuration with no canonical row in the schema at all.
//
// AND SO DOES `skills`' `SkillsRepository` (WIN-258 T5). The three rows of ADR
// M0.3 §1 row 6 — `Skill`, `ProjectSkill` and `EnvironmentSkill` — are in that
// same database behind that same client, so Amendment 15 puts them here rather
// than in a thirteenth package holding a second one. It is a PROPERTY and not a
// spread, and that is the SECOND collision this file has had to arbitrate rather
// than a preference: `SkillsRepository.findInstallation(scope, skillId)` and
// `ChannelsRepository.findInstallation(installationId)` are both top-level
// members with different signatures, so `PostgresTenancyAdapter` cannot extend
// both ports — exactly the shape `secrets` produced on `appendAudit`. The
// composition root proves it by indexing the property that carries it. The
// context's THREE other ports are deliberately absent and
// `skills-repository.ts` says why for each: `SkillSourceFetcher` is an
// SSRF-defence contract over sockets this package does not open,
// `SkillSandbox` is the confined runtime ADR M0.3 §7 decision 10 puts behind
// `durable-runtime`, and `EnvironmentKeyDirectory` reads `EnvironmentVariable`,
// which §1 row 3 gives to `secrets` — a row this directory can physically read
// and this port is not entitled to.

// AND SO DO `jobs`' TWO CANONICAL-STORE PORTS (WIN-258 T5) — the THIRTEENTH
// owner delegated to this directory, and the THIRD whose ports are PROPERTIES
// because a name collided. `Job` and `AgentApproval` are in the same PostgreSQL
// database behind the same client, so Amendment 15 puts them here; but
// `ApprovalsRepository` declares a top-level `list`, `resolve` and `erase`, and
// `ConversationsErasureStore` already publishes an `erase` with a different
// signature — so this interface cannot extend both ports and a spread would have
// let whichever composite came last answer both. The two arrive under
// `JobsDependencies`' own slot names, `jobs` and `approvals`. The context's two
// OTHER ports are deliberately absent and `jobs-repository.ts` says why for
// each: `IdempotencyStore` is a reserve-once keyspace whose three properties
// PostgreSQL does not have, and `JobHandlerRuntime` is the isolate that runs
// untrusted handler source, which ADR M0.3 §7 decision 10 puts behind
// `packages/adapters/durable-runtime`.
//
// AND SO DOES `eventing`'s `NotificationRuleRepository` (WIN-258 T5). ONE row —
// `NotificationRule`, ADR M0.3 §1 row 17's only canonical member — in that same
// database behind that same client, so Amendment 15 puts it here rather than in
// an eighteenth package holding a second one. The row COUNT is what makes this
// entry look small and does not change the argument: without it
// `ownerDirectories("eventing")` is the context alone, and §2 forbids that
// package from importing the ORM, so the one package permitted to write the row
// would be the one package unable to.
//
// It is SPREAD rather than nested, and unlike `skills`, `secrets`, `memory`,
// `governance` and `conversations` above there was nothing to arbitrate: its
// nine method names collide with nothing this directory already publishes across
// sixteen owners, so `PORT_SATISFACTION` resolves
// `Satisfies<PostgresTenancyAdapter, NotificationRuleRepository>` against the
// adapter itself, exactly as it does for `ProvidersRepository`.
//
// The context's TWO other ports are deliberately absent and
// `eventing-repository.ts` says why for each: `DestinationScreen` is the SSRF
// boundary, whose contract is DNS resolution and a pinned socket — obligations a
// package that opens no sockets cannot meet — and `NotificationQueue` is a
// DELAYED hand-off whose `availableAt` asks for the durable schedule ADR M0.3 §7
// decision 10 puts behind `durable-runtime`.

import type { ChannelsRepository } from "@platos/context-channels/application/ports/index.js";
import type { NotificationRuleRepository } from "@platos/context-eventing/application/ports/index.js";
import type {
  ConversationsErasureStore,
  PostmanRepository,
  ThreadRepository,
  TurnRepository,
} from "@platos/context-conversations/application/ports/index.js";
import type {
  KnowledgeGraphRepository,
  MemoryRepository,
} from "@platos/context-memory/application/ports/index.js";
import type {
  AgentsRepository,
  ScaffoldingRepository,
} from "@platos/context-agents/application/ports/index.js";
import type { BudgetRepository } from "@platos/context-cost-monitoring/application/ports/index.js";
import type { FilesRepository } from "@platos/context-files/application/ports/index.js";
import type {
  CriteriaRepository,
  EvalsRepository,
  GoldenSetsRepository,
  RatingsRepository,
  SafetyLedger,
} from "@platos/context-governance/application/ports/index.js";
import type { IdentityAccessRepository } from "@platos/context-identity-access/application/ports/index.js";
import type {
  ApprovalsRepository,
  JobsRepository,
} from "@platos/context-jobs/application/ports/index.js";
import type { PrivacyRepository } from "@platos/context-privacy/application/ports/index.js";
import type { ObservabilityRepository } from "@platos/context-observability/application/ports/index.js";
import type { ProvidersRepository } from "@platos/context-providers/application/ports/index.js";
import type {
  EnvironmentVariableRepository,
  SecretsRepository,
} from "@platos/context-secrets/application/ports/index.js";
import type { SkillsRepository } from "@platos/context-skills/application/ports/index.js";
import type { ToolsRepository } from "@platos/context-tools/application/ports/index.js";
import type {
  EnvironmentAccessKeyRevocationCounter,
  InvitationTokenIssuer,
  OperatorDirectory,
  OperatorSessionRevoker,
  TenancyLocks,
  TenancyRepository,
  UnitOfWork,
} from "@platos/context-tenancy/application/ports/index.js";

import { createAccessKeyRevocationCounter } from "./access-key-revocation.js";
import { createAgentsRepository } from "./agents-repository.js";
import { createScaffoldingRepository } from "./agents-scaffolding.js";
import type { TenancyClientOptions, TenancyDatabaseClient } from "./client.js";
import { createTenancyDatabaseClient } from "./client.js";
import { createChannelsRepository } from "./channels-repository.js";
import { createConversationsStores } from "./conversations-repository.js";
import { createNotificationRuleRepository } from "./eventing-repository.js";
import { createCostMonitoringRepository } from "./cost-repository.js";
import { createFilesRepository } from "./files-repository.js";
import { createGovernanceStores } from "./governance-repository.js";
import { createIdentityAccessRepository } from "./identity-repository.js";
import { createInvitationRepository } from "./invitation.js";
import { createInvitationTokenIssuer } from "./invitation-token.js";
import { createJobsStores } from "./jobs-repository.js";
import { createTenancyLocks } from "./locks.js";
import { createMemoryStores } from "./memory-repository.js";
import { createMembershipRepository } from "./membership.js";
import { createOperatorDirectory, createOperatorSessionRevoker } from "./operator-peers.js";
import type { OutboxEventStorePort } from "./outbox-store.js";
import { createOutboxEventStore } from "./outbox-store.js";
import { createPrivacyRepository } from "./privacy-repository.js";
import { createObservabilityStores } from "./observability-repository.js";
import { createProvidersRepository } from "./providers-repository.js";
import {
  createEnvironmentVariableRepository,
  createSecretsRepository,
} from "./secrets-repository.js";
import { createSkillsRepository } from "./skills-repository.js";
import type { TenancyTransactions, TransactionTimeouts } from "./transaction.js";
import { createTenancyTransactions } from "./transaction.js";
import { createToolsRepository } from "./tools-repository.js";
import { createTreeRepository } from "./tree.js";

export interface PostgresTenancyAdapter
  extends TenancyRepository,
    IdentityAccessRepository,
    ToolsRepository,
    AgentsRepository,
    ScaffoldingRepository,
    BudgetRepository,
    ChannelsRepository,
    ProvidersRepository,
    FilesRepository,
    NotificationRuleRepository,
    PrivacyRepository,
    OutboxEventStorePort {
  readonly adapterName: "postgres-tenancy";
  /** The transaction boundary every write of this repository must run inside. */
  readonly unitOfWork: UnitOfWork;
  /**
   * WIN-258 T3 — tenancy's five driven ports that are NOT the repository.
   *
   * They are properties rather than spread-in methods, because unlike
   * `IdentityAccessRepository`'s ten stores they are five SEPARATE ports on
   * `TenancyDependencies` and a composition root has to hand each one to the
   * context under its own name. The names below are those names exactly, so the
   * bundle a root builds is this adapter's own keys and cannot be assembled with
   * one port in another's slot.
   */
  readonly locks: TenancyLocks;
  readonly sessionRevoker: OperatorSessionRevoker;
  readonly accessKeyRevocation: EnvironmentAccessKeyRevocationCounter;
  readonly invitationTokens: InvitationTokenIssuer;
  readonly operators: OperatorDirectory;
  /**
   * WIN-258 T5 — `governance`'s FIVE canonical-store ports.
   *
   * Properties rather than spread-in methods, and unlike tenancy's five that is
   * FORCED rather than preferred: these five ports collide with each other.
   * `findById` is declared on four of them, `page` on four, and `create`,
   * `update` and `remove` on two apiece — so a flat spread would keep whichever
   * composite came last and answer four ports from one table. The names are
   * `GovernanceDependencies`' own slot names, so the bundle a composition root
   * assembles is these keys and cannot put one port in another's slot.
   */
  readonly safety: SafetyLedger;
  readonly ratings: RatingsRepository;
  readonly criteria: CriteriaRepository;
  readonly evals: EvalsRepository;
  readonly goldenSets: GoldenSetsRepository;

  /**
   * WIN-258 T5 — `secrets`' two canonical-store ports.
   *
   * PROPERTIES, and for a harder reason than tenancy's five above. Those are
   * separate ports on a dependency bundle and could have been spread if their
   * names had been free; these two CANNOT be spread at all, because
   * `SecretsRepository.appendAudit(draft, transaction)` collides by name and
   * differs by signature with `ToolsRepository.appendAudit(scope, entry)`, which
   * this adapter already publishes. The names below are `SecretsDependencies`'
   * own two slots — `repository` and `variables` — spelled with the owner in
   * front, because `repository` alone is not a name a directory serving eight
   * owners can give to one of them.
   */
  readonly secrets: SecretsRepository;
  readonly secretsVariables: EnvironmentVariableRepository;
  /**
   * WIN-258 T5 — `conversations`' FOUR canonical-store ports.
   *
   * PROPERTIES, like `governance`'s five and `secrets`' two, and for the middle
   * reason of the three this file now carries. They do not collide with each
   * other the way governance's do, and they could not have been spread the way
   * `secrets`' cannot: `ConversationsDependencies` names FOUR SEPARATE SLOTS —
   * `threads`, `turns`, `postman`, `erasureStore` — and a composition root has
   * to hand each port over under its own name. A flat spread would give the root
   * twenty-eight loose methods and no way to assemble that bundle without
   * guessing which method belongs to which slot.
   *
   * `conversationsErasure` is the one rename. `erasureStore` is not a name a
   * directory serving twelve owners can give to one of them; see
   * `conversations-repository.ts`.
   */
  readonly threads: ThreadRepository;
  readonly turns: TurnRepository;
  readonly postman: PostmanRepository;
  readonly conversationsErasure: ConversationsErasureStore;

  /**
   * WIN-258 T5 — `skills`' one canonical-store port.
   *
   * A PROPERTY, and forced by the same kind of collision `secrets` produced.
   * `SkillsRepository.findInstallation(scope, skillId)` and
   * `ChannelsRepository.findInstallation(installationId)` are both top-level
   * members with different signatures, so an interface cannot extend both ports
   * and a spread would have let whichever composite came last answer BOTH — a
   * channel installation resolved out of `EnvironmentSkill`, or the reverse,
   * with every type in the file still checking. The name is
   * `SkillsDependencies`' own slot spelled with its owner in front, because
   * `repository` alone is not a name a directory serving twelve owners can give to
   * one of them.
   */
  readonly skills: SkillsRepository;

  /**
   * WIN-258 T5 — `memory`'s two canonical-store ports.
   *
   * PROPERTIES, and forced by the same kind of collision `secrets` hit rather
   * than by preference. `KnowledgeGraphRepository.findEntity(subject, agentIds,
   * entityId)` and `TenancyRepository.findEntity(entityId)` are both top-level
   * members with one name and two signatures, so `PostgresTenancyAdapter extends
   * TenancyRepository, KnowledgeGraphRepository` is a TypeScript error — "cannot
   * simultaneously extend" — and a spread would have let whichever composite
   * came last silently answer both. The names below are `MemoryDependencies`'
   * own two slots — `repository` and `graph` — spelled with the owner in front,
   * because `repository` alone is not a name a directory serving twelve owners can
   * give to one of them.
   */
  readonly memory: MemoryRepository;
  readonly memoryGraph: KnowledgeGraphRepository;

  /**
   * WIN-258 T5 — `jobs`' two canonical-store ports.
   *
   * PROPERTIES, and the first half is FORCED by the third name collision this
   * file has had to arbitrate. `ApprovalsRepository.erase(selector, transaction)`
   * and `ConversationsErasureStore.erase(...)` are both top-level members with
   * different signatures, and `ApprovalsRepository.list` and `.resolve` are two
   * more names a directory serving thirteen owners cannot give away once — so
   * `PostgresTenancyAdapter` cannot extend this port and a spread would have let
   * whichever composite came last answer both. The second half is the reason
   * `conversations`' four are properties: `JobsDependencies` names TWO SLOTS and
   * a composition root has to hand each port over under its own name. The names
   * below are those two slots exactly.
   */
  readonly jobs: JobsRepository;
  readonly approvals: ApprovalsRepository;

  /**
   * WIN-258 T5 — `observability`'s one canonical-store port.
   *
   * A PROPERTY, and forced by the same sentence `skills` and `memory` stand on:
   * `ObservabilityDependencies`' slot for it is called `repository`, and
   * `repository` alone is not a name a directory serving SEVENTEEN owners can
   * give to one of them. The owner is spelled in front so a composition root
   * hands the port to the context under its own name rather than out of a bundle
   * assembled from key order.
   *
   * The context's THREE other driven ports are deliberately absent and
   * `observability-repository.ts` says why for each: `ObservabilitySink` is the
   * four analytical tables, which are not Prisma rows and already have an
   * adapter; `ProjectionOutbox` settles a row whose only writer is the kernel
   * outbox adapter; and `ErasedSubjectRegister` and `SubjectLocatorSource` read
   * `privacy`'s and `conversations`' tables, which this directory answering
   * under `observability`'s name would be the sideways access §5.2 forbids.
   */
  readonly observability: ObservabilityRepository;
  /** Release the pool. The composition root owns this adapter's lifetime. */
  close(): Promise<void>;
}

export type PostgresTenancyOptions = TenancyClientOptions & TransactionTimeouts;

/**
 * Build the adapter over an ALREADY-OPEN client.
 *
 * Separate from `createPostgresTenancyAdapter` so a test can supply a client it
 * built against a container and still exercise the real repository. `close()`
 * here disconnects the client it was given, because the caller that opened it is
 * the caller that asked for the adapter.
 */
export function buildPostgresTenancyAdapter(
  client: TenancyDatabaseClient,
  timeouts: TransactionTimeouts = {},
): PostgresTenancyAdapter {
  const transactions: TenancyTransactions = createTenancyTransactions(client, timeouts);
  // WIN-258 T3. Built ONCE and referenced twice: `operators` and
  // `sessionRevoker` below are handed narrow `Pick<>`s of these very stores, so
  // tenancy's two edges into identity-access resolve to the SAME objects the
  // identity-access half of this adapter publishes — one connection, one ambient
  // transaction, and no second implementation of `User` or `OperatorSession` to
  // keep in step. Building a second `createIdentityAccessRepository()` here
  // would have been two of everything over one database, which is the arrangement
  // ADR M0.3 §15 exists to refuse.
  const identity = createIdentityAccessRepository(transactions);
  return {
    adapterName: "postgres-tenancy",
    unitOfWork: transactions.unitOfWork,
    locks: createTenancyLocks(transactions),
    sessionRevoker: createOperatorSessionRevoker(transactions, identity.operatorSessions),
    accessKeyRevocation: createAccessKeyRevocationCounter(transactions),
    invitationTokens: createInvitationTokenIssuer(),
    operators: createOperatorDirectory(identity.users),
    // WIN-258 T5 (ADR M0.3 §15). The SIXTH owner delegated to this directory.
    // Built from the same `transactions` as everything above, so the erasure
    // target that counts a subject's safety events and ratings and then
    // anonymises the first and destroys the second is ONE transaction.
    ...createGovernanceStores(transactions),
    // WIN-258 T5. Built from the SAME `transactions` as everything else here,
    // so a `setEnvironmentVariable` that seals a credential, writes an envelope,
    // points the credential at it, writes the variable row and appends two audit
    // records is ONE transaction — and the `countReferences` that decides
    // whether to revoke sees the row the same transaction just wrote.
    secrets: createSecretsRepository(transactions),
    secretsVariables: createEnvironmentVariableRepository(transactions),
    // WIN-258 T5. Built from the SAME `transactions` as everything else here, so
    // an install — a `ProjectSkill` adoption and the `EnvironmentSkill` binding
    // that hangs off its id — is ONE transaction across two tables, and a
    // failure on the second leaves no adoption behind that nothing points at.
    skills: createSkillsRepository(transactions),
    // WIN-258 T5 (ADR M0.3 §15). The TWELFTH owner delegated to this directory.
    // Built from the same `transactions` as everything above, so an extraction
    // that writes a memory, the entities pulled out of it and the edges between
    // them is ONE transaction — and so an erasure that counts a subject's
    // memories, nodes and edges and then destroys all three cannot leave the
    // graph standing over a person whose memories are gone.
    ...createMemoryStores(transactions),
    // WIN-258 T5 (ADR M0.3 §15). The THIRTEENTH owner delegated to this
    // directory. Built from the same `transactions` as everything above, so
    // `resolve-approval.ts` — which records a human's decision and then resumes
    // the run parked on a `DurableRuntime` suspension — is ONE transaction, and
    // so `privacy`'s erasure counts and destroys a subject's approvals through a
    // `TransactionScope` this ambient frame minted rather than a second one that
    // would refuse it as `scope_unknown`.
    ...createJobsStores(transactions),
    // WIN-258 T5 (ADR M0.3 §15). The SIXTEENTH owner delegated to this
    // directory. Built from the same `transactions` as everything above, which
    // is the whole reason `record-admin-action.ts` is safe to place inside an
    // admin action's own unit of work: the action and the row that says who
    // performed it commit together or neither does, and an audit trail that can
    // disagree with what actually happened is worse than no audit trail.
    ...createObservabilityStores(transactions),
    async close(): Promise<void> {
      await client.$disconnect();
    },
    ...createTreeRepository(transactions),
    ...createMembershipRepository(transactions),
    ...createInvitationRepository(transactions),
    // WIN-258 T2 (ADR M0.3 §15). The identity-access composite is SPREAD in
    // beside tenancy's methods rather than nested under a property, because the
    // adapter type must EXTEND both ports for `PORT_SATISFACTION` in the
    // composition root to resolve — and `IdentityAccessRepository` is itself ten
    // named store properties, so there is no name collision to arbitrate: its
    // ten keys and tenancy's thirty-one are disjoint.
    ...identity,
    // WIN-258 T5. The `tools` repository, spread in for the reason the
    // identity-access composite is: the composition root proves
    // `PostgresTenancyAdapter extends ToolsRepository` at compile time, and a
    // nested property could not satisfy that. It is built from the same
    // `transactions` as everything else here, so a use case that registers an
    // entity's tools and bumps its environment's fence is ONE transaction.
    ...createToolsRepository(transactions),
    // WIN-258 T5 (ADR M0.3 §15). The FIFTH owner in this directory, on the same
    // argument the second was: `cost-monitoring`'s six rows are in the one
    // PostgreSQL database, behind the one client, so a thirteenth adapter
    // package holding only its repositories would be a second home for that
    // client and would make `tenancy-prisma-only` unwritable as a single-home
    // rule. Its twenty-two method names are disjoint from tenancy's thirty-one,
    // identity-access's ten store properties, tools' twenty-five and agents'
    // thirty-five, so there is nothing to arbitrate; the spread is what lets
    // `PORT_SATISFACTION` in the composition root resolve
    // `PostgresTenancyAdapter extends BudgetRepository` at compile time, which a
    // nested property could not.
    ...createCostMonitoringRepository(transactions),
    // WIN-258 T4. The canonical `Event` row, written on the kernel outbox
    // adapter's behalf. It is spread in here rather than exposed as a separate
    // object for the reason the identity-access composite is: the composition
    // root proves `PostgresTenancyAdapter extends OutboxEventStore` at compile
    // time, and a nested property could not satisfy that. Its two method names
    // collide with nothing — `insertOutboxEvent` and `readOutboxEventsAfter`
    // are the only members any of the three spread-in composites has that begin
    // with those words.
    ...createOutboxEventStore(transactions),
    // WIN-258 T5. `agents`' two canonical-store ports, SPREAD IN for the reason
    // the identity-access composite is: `PORT_SATISFACTION` in the composition
    // root resolves `Satisfies<PostgresTenancyAdapter, AgentsRepository>` and
    // `Satisfies<PostgresTenancyAdapter, ScaffoldingRepository>` at compile time,
    // and a nested property could not satisfy either. Their method names collide
    // with nothing: the two ports are disjoint from each other by construction —
    // `Macro` and `PostmanTemplate` are the rows a SURFACE writes on its own
    // behalf, and they share no invariant with a version history — and neither
    // has a name in common with tenancy's thirty-one, identity-access's ten
    // store properties, or the outbox's two.
    ...createAgentsRepository(transactions),
    ...createScaffoldingRepository(transactions),
    // WIN-258 T5 (ADR M0.3 §15). The SIXTH owner in this directory, on the same
    // argument every owner above it stands on: `channels`' six rows are in the
    // one PostgreSQL database, behind the one client, so a thirteenth adapter
    // package holding only its repository would be a second home for that client
    // and would make `tenancy-prisma-only` unwritable as a single-home rule. Its
    // seventeen method names are disjoint from tenancy's thirty-one,
    // identity-access's ten store properties, tools' twenty-five, agents'
    // thirty-five, cost-monitoring's twenty-two and the outbox's two, so there is
    // nothing to arbitrate; the spread is what lets `PORT_SATISFACTION` in the
    // composition root resolve `PostgresTenancyAdapter extends ChannelsRepository`
    // at compile time, which a nested property could not.
    ...createChannelsRepository(transactions),
    // WIN-258 T5 (ADR M0.3 §15). The NINTH owner in this directory, on the same
    // argument every owner above it stands on: `providers`' four rows are in the
    // one PostgreSQL database, behind the one client. Its eighteen method names
    // are disjoint from tenancy's thirty-one, identity-access's ten store
    // properties, tools' twenty-five, agents' thirty-five, cost-monitoring's
    // twenty-two, channels' seventeen and the outbox's two, so there is nothing
    // to arbitrate; the spread is what lets `PORT_SATISFACTION` resolve
    // `PostgresTenancyAdapter extends ProvidersRepository` at compile time.
    //
    // Built from the SAME `transactions` as `secrets` above, which is what makes
    // "create the credential, then write the key that points at it" one
    // transaction — and therefore what lets the rule that re-reads the
    // credential from inside the key's INSERT see it.
    ...createProvidersRepository(transactions),
    // WIN-258 T5 (ADR M0.3 §15). The TENTH owner in this directory. Built from
    // the SAME `transactions` as everything else here, which is what makes three
    // separate things true at once: a turn sequence allocated under a
    // `FOR UPDATE` on the thread row is serialised against the insert that uses
    // it; a settlement writes `Turn.costCents` and replaces its `Step` rows in
    // one unit of work, so the rollup never disagrees with its own parts; and
    // `privacy`'s erasure counts, deletes and anonymises through a
    // `TransactionScope` minted by THIS ambient frame rather than by a second
    // one that would refuse it as `scope_unknown`.
    ...createConversationsStores(transactions),
    // WIN-258 T5 (ADR M0.3 §15). The THIRTEENTH owner in this directory, and the
    // one whose correctness depends on the shared `transactions` more than any
    // other above it. `run-erasure-pass.ts` opens ONE unit of work, asks every
    // injected `ErasureTarget` to erase inside it, and writes this context's own
    // progress row in the same breath. Four of those targets — `conversations`',
    // `memory`'s, `governance`'s and `skills`' — are spread into this very
    // object, so the `TransactionScope` the pass mints is a token THIS ambient
    // frame issued and every one of them accepts. A second pool would have made
    // it `scope_unknown` at each target in turn.
    ...createPrivacyRepository(transactions),
    // WIN-258 T5 (ADR M0.3 §15). The FIFTEENTH owner in this directory. Built
    // from the SAME `transactions` as everything else here, which is what makes
    // this context's erasure one unit of work: `files-erasure-target.ts` removes
    // a subject's attachment ROWS one at a time — the blob beside each one is
    // destroyed first, outside any transaction, because no transaction spans a
    // bucket and a database — and then deletes every artifact revision the
    // subject authored in a single statement. The two row halves commit or roll
    // back together only because they are the same client on the same
    // connection.
    ...createFilesRepository(transactions),
    // smallest grant the map has made: ONE row. Built from the SAME
    // `transactions` as everything above, which is the whole reason it is here
    // rather than in a package of its own — `privacy` opens ONE unit of work and
    // hands the same `TransactionScope` to every `ErasureTarget` in the array,
    // so this context's `createdBy` scrub commits or rolls back with
    // `governance`'s and `memory`'s. A second ambient frame would have refused
    // that scope as `scope_unknown` — the right fact under the wrong cause.
    ...createNotificationRuleRepository(transactions),
  };
}

/** Open a pool and build the adapter over it. */
export function createPostgresTenancyAdapter(
  options: PostgresTenancyOptions,
): PostgresTenancyAdapter {
  const { transactionTimeoutMs, maxWaitMs, ...clientOptions } = options;
  const timeouts: TransactionTimeouts = {
    ...(transactionTimeoutMs === undefined ? {} : { transactionTimeoutMs }),
    ...(maxWaitMs === undefined ? {} : { maxWaitMs }),
  };
  return buildPostgresTenancyAdapter(createTenancyDatabaseClient(clientOptions), timeouts);
}
