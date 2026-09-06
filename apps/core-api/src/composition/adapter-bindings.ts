// THE ONE PLACE `packages/adapters/*` IS IMPORTED.
//
// ADR M0.3 §5.1 rule (j) `adapters-only-from-core` says only `apps/core-api` may
// import an adapter. That is necessary and not sufficient: "the composition root
// is the one place adapters are bound to ports" is not satisfied by scattering
// twelve imports across a transport tree that happens to live inside core-api.
// `scripts/arch/composition-root.mjs` therefore narrows rule (j) from a package
// to THIS FILE, and fails if any other file under `apps/core-api/` names an
// adapter package. Rule (j) is unchanged; this is an additional, stricter gate.
//
// WHAT THE TYPE LAYER PROVES HERE. Every adapter package publishes an interface
// that EXTENDS the port it implements. `PORT_SATISFACTION` below turns that into
// a compile-time obligation: if an adapter ever stops extending its port, the
// conditional type resolves to `never`, `true` stops being assignable, and
// `pnpm build:v1` fails. That is the binding — checked by the compiler rather
// than asserted in a comment — and it is the strongest statement available while
// the adapters are still declaration-only.
//
// WHAT IS DELIBERATELY ABSENT. No adapter is CONSTRUCTED here. At M2.1b not one
// of the twelve has an implementation: each is an interface extending its port
// (WIN-251's skeleton, untouched by WIN-256). Instances arrive through
// `supplyAdapters`, and the process reports every unsatisfied binding through
// readiness rather than pretending to be ready. WIN-258/259 and their siblings
// fill the registry in; none of them needs to change this file's shape to do it.

import type { DurableRuntime, EventBus, OutboxWriter } from "@platos/kernel";

import type {
  IdentityAccessRepository,
  RateLimiter,
} from "@platos/context-identity-access/application/ports/index.js";
import type {
  EnvironmentAccessKeyRevocationCounter,
  InvitationTokenIssuer,
  OperatorDirectory,
  OperatorSessionRevoker,
  TenancyLocks,
  TenancyRepository,
} from "@platos/context-tenancy/application/ports/index.js";
import type { SkillsRepository } from "@platos/context-skills/application/ports/index.js";
import type { ToolsRepository } from "@platos/context-tools/application/ports/index.js";
import type {
  EnvironmentVariableRepository,
  SecretsRepository,
} from "@platos/context-secrets/application/ports/index.js";
import type {
  AgentsRepository,
  ScaffoldingRepository,
} from "@platos/context-agents/application/ports/index.js";
import type {
  FilesRepository,
  ObjectStore,
} from "@platos/context-files/application/ports/index.js";
import type { PrivacyRepository } from "@platos/context-privacy/application/ports/index.js";
import type {
  ObservabilityRepository,
  ObservabilitySink,
} from "@platos/context-observability/application/ports/index.js";
import type {
  Cache,
  KnowledgeGraphRepository,
  MemoryRepository,
} from "@platos/context-memory/application/ports/index.js";
import type {
  ModelRouter,
  ProvidersRepository,
} from "@platos/context-providers/application/ports/index.js";
import type {
  ChannelAdapter,
  ChannelsRepository,
} from "@platos/context-channels/application/ports/index.js";
import type { NotificationRuleRepository } from "@platos/context-eventing/application/ports/index.js";
import type {
  BudgetRepository,
  Notifier,
} from "@platos/context-cost-monitoring/application/ports/index.js";
import type {
  CriteriaRepository,
  EvalsRepository,
  GoldenSetsRepository,
  RatingsRepository,
  SafetyLedger,
} from "@platos/context-governance/application/ports/index.js";
import type {
  ConversationsErasureStore,
  PostmanRepository,
  ThreadRepository,
  TurnRepository,
} from "@platos/context-conversations/application/ports/index.js";
import type {
  ApprovalsRepository,
  JobsRepository,
} from "@platos/context-jobs/application/ports/index.js";

import type { PostgresTenancyAdapter } from "@platos/adapter-postgres-tenancy";
import type { OutboxAdapter, OutboxEventStore } from "@platos/adapter-outbox";
import type { DurableRuntimeAdapter } from "@platos/adapter-durable-runtime";
import type { ClickhouseObservabilityAdapter } from "@platos/adapter-clickhouse-observability";
import type { ObjectstoreMinioAdapter } from "@platos/adapter-objectstore-minio";
import type { RedisRatelimitAdapter } from "@platos/adapter-redis-ratelimit";
import type { RedisCacheAdapter } from "@platos/adapter-redis-cache";
import type { RedisStreamsAdapter } from "@platos/adapter-redis-streams";
import type { ModelRouterProvidersAdapter } from "@platos/adapter-model-router-providers";
import type { ChannelSlackAdapter } from "@platos/adapter-channel-slack";
import type { NotifierEmailAdapter } from "@platos/adapter-notifier-email";
import type { NotifierWebhookAdapter } from "@platos/adapter-notifier-webhook";

/**
 * The twelve adapter slots, keyed by directory name.
 *
 * The key is the adapter's directory because that is the name every other gate
 * already uses — `scripts/arch/boundary-rules.mjs`, the generator's `ADAPTERS`
 * table and `v1-project-graph.mjs`'s `EXPECTED_ADAPTER_OWNERS` all agree on it,
 * so a mismatch here is mechanically detectable rather than a matter of taste.
 *
 * TWELVE SLOTS, FORTY-FOUR BINDINGS (ADR M0.3 §15). An install wires a
 * DIRECTORY — one process-lifetime object holding one vendor client — so this
 * table stays keyed by directory and keeps twelve entries. What a directory
 * SATISFIES is a different question, and `PORT_SATISFACTION` below answers it
 * per binding.
 */
export interface AdapterInstances {
  readonly "postgres-tenancy": PostgresTenancyAdapter;
  readonly outbox: OutboxAdapter;
  readonly "durable-runtime": DurableRuntimeAdapter;
  readonly "clickhouse-observability": ClickhouseObservabilityAdapter;
  readonly "objectstore-minio": ObjectstoreMinioAdapter;
  readonly "redis-ratelimit": RedisRatelimitAdapter;
  readonly "redis-cache": RedisCacheAdapter;
  readonly "redis-streams": RedisStreamsAdapter;
  readonly "model-router-providers": ModelRouterProvidersAdapter;
  readonly "channel-slack": ChannelSlackAdapter;
  readonly "notifier-email": NotifierEmailAdapter;
  readonly "notifier-webhook": NotifierWebhookAdapter;
}

export type AdapterName = keyof AdapterInstances;

/** What an install has actually wired. Absent keys are unsatisfied bindings. */
export type SuppliedAdapters = Partial<AdapterInstances>;

/**
 * The compile-time binding proof.
 *
 * `never` is not assignable to `true`, so an adapter that stops implementing its
 * port breaks the build here — at the composition root, which is where the
 * mistake would otherwise surface as a runtime type error in production.
 * `composition-root.test.mjs` mutates one entry and observes `tsc` reject it,
 * because a compile-time proof nobody has watched fail is not evidence.
 *
 * KEYED `<adapter>:<Port>`, ONE ENTRY PER BINDING (ADR M0.3 §15). It was keyed
 * by directory while every directory had exactly one port, and that key can
 * hold only one obligation per directory: under §15 a two-port directory would
 * have had one binding proven and the other merely asserted, with the compiler
 * unable to notice because a missing obligation is not a wrong one.
 * `composition-root.mjs` now compares these keys against the declared bindings
 * in BOTH directions, so an entry for a pair that was never bound is a failure
 * rather than an extra proof.
 */
type Satisfies<Adapter, Port> = Adapter extends Port ? true : never;

interface PortSatisfaction {
  readonly "postgres-tenancy:TenancyRepository": Satisfies<PostgresTenancyAdapter, TenancyRepository>;
  readonly "postgres-tenancy:IdentityAccessRepository": Satisfies<
    PostgresTenancyAdapter,
    IdentityAccessRepository
  >;
  readonly "postgres-tenancy:ToolsRepository": Satisfies<PostgresTenancyAdapter, ToolsRepository>;
  // WIN-258 T5 (ADR M0.3 §15). `agents` publishes TWO canonical-store ports and
  // both are satisfied by the same directory, for the reason the rows above are:
  // one PostgreSQL database, one client, one adapter directory.
  readonly "postgres-tenancy:AgentsRepository": Satisfies<PostgresTenancyAdapter, AgentsRepository>;
  readonly "postgres-tenancy:ScaffoldingRepository": Satisfies<
    PostgresTenancyAdapter,
    ScaffoldingRepository
  >;
  readonly "postgres-tenancy:BudgetRepository": Satisfies<PostgresTenancyAdapter, BudgetRepository>;
  readonly "postgres-tenancy:ChannelsRepository": Satisfies<
    PostgresTenancyAdapter,
    ChannelsRepository
  >;
  // WIN-258 T5. `governance` publishes FIVE canonical-store ports and every one
  // is proven through the PROPERTY that carries it rather than through the
  // adapter itself — the same shape tenancy's five non-repository ports use
  // below, and for a STRONGER reason. Tenancy's five are properties because a
  // composition root has to hand each one over under its own name; these five
  // are properties because they COLLIDE. `findById` is declared on four of them,
  // `page` on four, and `create`, `update` and `remove` on two apiece, so a flat
  // spread would keep whichever composite came last and answer four ports from
  // one table. Indexing the property is what makes each obligation the true one.
  readonly "postgres-tenancy:SafetyLedger": Satisfies<PostgresTenancyAdapter["safety"], SafetyLedger>;
  readonly "postgres-tenancy:RatingsRepository": Satisfies<
    PostgresTenancyAdapter["ratings"],
    RatingsRepository
  >;
  readonly "postgres-tenancy:CriteriaRepository": Satisfies<
    PostgresTenancyAdapter["criteria"],
    CriteriaRepository
  >;
  readonly "postgres-tenancy:EvalsRepository": Satisfies<
    PostgresTenancyAdapter["evals"],
    EvalsRepository
  >;
  readonly "postgres-tenancy:GoldenSetsRepository": Satisfies<
    PostgresTenancyAdapter["goldenSets"],
    GoldenSetsRepository
  >;
  // WIN-258 M2.3. Tenancy's five NON-REPOSITORY driven ports, proven through the
  // PROPERTY that carries each one rather than through the adapter itself.
  //
  // `Satisfies<PostgresTenancyAdapter, TenancyLocks>` would resolve to `never`
  // and fail a binding that holds: these five are named properties of the
  // adapter, not methods spread into it, because a composition root has to hand
  // each to `TenancyDependencies` under its own name. Indexing the property is
  // what makes the obligation the true one — that `locks` is a `TenancyLocks` —
  // so the day the adapter renames or re-types one, `pnpm build:v1` fails here.
  readonly "postgres-tenancy:TenancyLocks": Satisfies<PostgresTenancyAdapter["locks"], TenancyLocks>;
  readonly "postgres-tenancy:OperatorSessionRevoker": Satisfies<
    PostgresTenancyAdapter["sessionRevoker"],
    OperatorSessionRevoker
  >;
  readonly "postgres-tenancy:EnvironmentAccessKeyRevocationCounter": Satisfies<
    PostgresTenancyAdapter["accessKeyRevocation"],
    EnvironmentAccessKeyRevocationCounter
  >;
  readonly "postgres-tenancy:InvitationTokenIssuer": Satisfies<
    PostgresTenancyAdapter["invitationTokens"],
    InvitationTokenIssuer
  >;
  readonly "postgres-tenancy:OperatorDirectory": Satisfies<
    PostgresTenancyAdapter["operators"],
    OperatorDirectory
  >;
  // WIN-258 T5. `secrets`' two canonical-store ports, proven through the
  // PROPERTY that carries each one — and here that is FORCED rather than
  // stylistic. `SecretsRepository.appendAudit(draft, transaction)` and
  // `ToolsRepository.appendAudit(scope, entry)` are both top-level members with
  // different signatures, so `PostgresTenancyAdapter` cannot extend both ports
  // and `Satisfies<PostgresTenancyAdapter, SecretsRepository>` would resolve to
  // `never` and fail a binding that holds. Indexing the property is what makes
  // the obligation the true one — that `secrets` IS a `SecretsRepository` — so
  // the day the adapter renames or re-types either, `pnpm build:v1` fails here.
  // WIN-258 T5. `providers`' canonical-store port, proven through the ADAPTER
  // rather than through a property: its eighteen method names collide with
  // nothing the adapter already publishes, so it is spread in like the six
  // repository composites above it and `PostgresTenancyAdapter extends
  // ProvidersRepository` resolves directly.
  readonly "postgres-tenancy:ProvidersRepository": Satisfies<
    PostgresTenancyAdapter,
    ProvidersRepository
  >;
  // WIN-258 T5. `files`' canonical-store port, proven through the ADAPTER rather
  // than through a property, for the reason `providers`' is: its fifteen method
  // names collide with nothing this directory already publishes, so it is spread
  // in like the six repository composites and
  // `PostgresTenancyAdapter extends FilesRepository` resolves directly.
  //
  // IT IS THE SECOND BINDING THIS TABLE HOLDS FOR ONE CONTEXT, and the pair is
  // the point rather than an accident. `objectstore-minio:ObjectStore` below is
  // also owned by `files`: a row and a blob are two technologies behind two
  // ports, `domain/destruction.ts` fixes blob-before-row precisely because no
  // transaction spans them, and one adapter holding both would have made that
  // ordering look like an implementation detail it could optimise away.
  readonly "postgres-tenancy:FilesRepository": Satisfies<PostgresTenancyAdapter, FilesRepository>;

  // WIN-258 T5. `eventing`'s ONE canonical-store port, proven through the
  // ADAPTER rather than through a property, like `ProvidersRepository` above:
  // its nine method names collide with nothing this adapter already publishes
  // across the sixteen owners above it, so it is spread in and
  // `PostgresTenancyAdapter extends NotificationRuleRepository` resolves
  // directly. The day the adapter drops `anonymizeRulesForSubject` or re-types
  // `findRule`, `pnpm build:v1` fails HERE — at the composition root, which is
  // the only place that knows the port and the adapter are meant to meet.
  readonly "postgres-tenancy:NotificationRuleRepository": Satisfies<
    PostgresTenancyAdapter,
    NotificationRuleRepository
  >;
  readonly "postgres-tenancy:SecretsRepository": Satisfies<
    PostgresTenancyAdapter["secrets"],
    SecretsRepository
  >;
  readonly "postgres-tenancy:EnvironmentVariableRepository": Satisfies<
    PostgresTenancyAdapter["secretsVariables"],
    EnvironmentVariableRepository
  >;
  // WIN-258 T5. `conversations`' four canonical-store ports, proven through the
  // PROPERTY that carries each one. The reason is the middle of the three this
  // file now carries: they do not collide with each other the way governance's
  // five do, and they are not blocked from spreading the way `secrets`' two are
  // — `ConversationsDependencies` simply names FOUR SLOTS, and a composition
  // root has to hand each port over under its own name. A flat spread would give
  // a root twenty-eight loose methods and no way to assemble that bundle without
  // guessing which method belongs to which slot.
  //
  // `conversationsErasure` is the one renamed slot: the bundle calls it
  // `erasureStore`, which is not a name a directory serving nine owners can give
  // to one of them, and this is the row that puts the two names back together.
  readonly "postgres-tenancy:ThreadRepository": Satisfies<
    PostgresTenancyAdapter["threads"],
    ThreadRepository
  >;
  readonly "postgres-tenancy:TurnRepository": Satisfies<
    PostgresTenancyAdapter["turns"],
    TurnRepository
  >;
  readonly "postgres-tenancy:PostmanRepository": Satisfies<
    PostgresTenancyAdapter["postman"],
    PostmanRepository
  >;
  readonly "postgres-tenancy:ConversationsErasureStore": Satisfies<
    PostgresTenancyAdapter["conversationsErasure"],
    ConversationsErasureStore
  >;

  // WIN-258 T5. `skills`' one canonical-store port, proven through the PROPERTY
  // that carries it — forced by the SECOND name collision this table has had to
  // arbitrate. `SkillsRepository.findInstallation(scope, skillId)` and
  // `ChannelsRepository.findInstallation(installationId)` are both top-level
  // members with different signatures, so `PostgresTenancyAdapter` cannot extend
  // both ports and `Satisfies<PostgresTenancyAdapter, SkillsRepository>` would
  // resolve to `never` and fail a binding that holds. Indexing the property makes
  // the obligation the true one — that `skills` IS a `SkillsRepository` — so the
  // day the adapter renames or re-types it, `pnpm build:v1` fails here.
  readonly "postgres-tenancy:SkillsRepository": Satisfies<
    PostgresTenancyAdapter["skills"],
    SkillsRepository
  >;

  // WIN-258 T5. `memory`'s two canonical-store ports, proven through the
  // PROPERTY that carries each one — and, like `secrets`' pair above, FORCED
  // rather than stylistic. `KnowledgeGraphRepository.findEntity(subject,
  // agentIds, entityId)` and `TenancyRepository.findEntity(entityId)` are both
  // top-level members with one name and two signatures, so
  // `PostgresTenancyAdapter` cannot extend both ports and
  // `Satisfies<PostgresTenancyAdapter, KnowledgeGraphRepository>` would resolve
  // to `never` and fail a binding that holds. `MemoryRepository` is indexed the
  // same way for the same reason: the two arrive together under
  // `MemoryDependencies`' own slot names, and a root that took one from a
  // property and the other from the adapter would be describing one store two
  // ways.
  readonly "postgres-tenancy:MemoryRepository": Satisfies<
    PostgresTenancyAdapter["memory"],
    MemoryRepository
  >;
  readonly "postgres-tenancy:KnowledgeGraphRepository": Satisfies<
    PostgresTenancyAdapter["memoryGraph"],
    KnowledgeGraphRepository
  >;
  // WIN-258 T5. `privacy`'s ONE canonical-store port, proven through the adapter
  // ITSELF rather than through a property — the shape `tools`, `agents`,
  // `cost-monitoring`, `channels` and `providers` have, and the shape `secrets`,
  // `skills` and `memory` were denied by a name collision. `PrivacyRepository` is
  // one interface extending `OperationRepository` and `TombstoneRepository`, and
  // its ten method names collide with nothing the adapter already publishes
  // across twelve owners, so the adapter EXTENDS the port and this resolves
  // directly.
  readonly "postgres-tenancy:PrivacyRepository": Satisfies<
    PostgresTenancyAdapter,
    PrivacyRepository
  >;

  // WIN-258 T5. `jobs`' two canonical-store ports, proven through the PROPERTY
  // that carries each one — and, like `secrets`' pair and `memory`'s, FORCED
  // rather than stylistic. `ApprovalsRepository.erase(selector, transaction)`
  // and `ConversationsErasureStore.erase(plan, transaction)` are both top-level
  // members with one name and two signatures, so `PostgresTenancyAdapter` cannot
  // extend both ports and `Satisfies<PostgresTenancyAdapter,
  // ApprovalsRepository>` would resolve to `never` and fail a binding that
  // holds. `JobsRepository` is indexed the same way for the same reason
  // `MemoryRepository` is: the two arrive together under `JobsDependencies`' own
  // slot names, and a root that took one from a property and the other from the
  // adapter would be describing one store two ways.
  readonly "postgres-tenancy:JobsRepository": Satisfies<
    PostgresTenancyAdapter["jobs"],
    JobsRepository
  >;
  readonly "postgres-tenancy:ApprovalsRepository": Satisfies<
    PostgresTenancyAdapter["approvals"],
    ApprovalsRepository
  >;

  // WIN-258 T5. `observability`'s one canonical-store port, proven through the
  // PROPERTY that carries it. Indexed like `skills`', `secrets`' and `memory`'s
  // rather than through the adapter as a whole, because the adapter's slot is
  // named for its OWNER — `ObservabilityDependencies` calls the slot
  // `repository`, which is not a name a directory serving seventeen owners can
  // give to one of them — and indexing the property makes the obligation the
  // true one: that `PostgresTenancyAdapter["observability"]` IS an
  // `ObservabilityRepository`. The day the adapter renames or re-types it,
  // `pnpm build:v1` fails here.
  readonly "postgres-tenancy:ObservabilityRepository": Satisfies<
    PostgresTenancyAdapter["observability"],
    ObservabilityRepository
  >;
  readonly "outbox:OutboxWriter": Satisfies<OutboxAdapter, OutboxWriter>;
  readonly "durable-runtime:DurableRuntime": Satisfies<DurableRuntimeAdapter, DurableRuntime>;
  readonly "clickhouse-observability:ObservabilitySink": Satisfies<
    ClickhouseObservabilityAdapter,
    ObservabilitySink
  >;
  readonly "objectstore-minio:ObjectStore": Satisfies<ObjectstoreMinioAdapter, ObjectStore>;
  readonly "redis-ratelimit:RateLimiter": Satisfies<RedisRatelimitAdapter, RateLimiter>;
  readonly "redis-cache:Cache": Satisfies<RedisCacheAdapter, Cache>;
  readonly "redis-streams:EventBus": Satisfies<RedisStreamsAdapter, EventBus>;
  readonly "model-router-providers:ModelRouter": Satisfies<ModelRouterProvidersAdapter, ModelRouter>;
  readonly "channel-slack:ChannelAdapter": Satisfies<ChannelSlackAdapter, ChannelAdapter>;
  readonly "notifier-email:Notifier": Satisfies<NotifierEmailAdapter, Notifier>;
  readonly "notifier-webhook:Notifier": Satisfies<NotifierWebhookAdapter, Notifier>;
}

export const PORT_SATISFACTION: PortSatisfaction = Object.freeze({
  "postgres-tenancy:TenancyRepository": true,
  "postgres-tenancy:IdentityAccessRepository": true,
  "postgres-tenancy:ToolsRepository": true,
  "postgres-tenancy:AgentsRepository": true,
  "postgres-tenancy:ScaffoldingRepository": true,
  "postgres-tenancy:BudgetRepository": true,
  "postgres-tenancy:ChannelsRepository": true,
  "postgres-tenancy:SafetyLedger": true,
  "postgres-tenancy:RatingsRepository": true,
  "postgres-tenancy:CriteriaRepository": true,
  "postgres-tenancy:EvalsRepository": true,
  "postgres-tenancy:GoldenSetsRepository": true,
  "postgres-tenancy:TenancyLocks": true,
  "postgres-tenancy:OperatorSessionRevoker": true,
  "postgres-tenancy:EnvironmentAccessKeyRevocationCounter": true,
  "postgres-tenancy:InvitationTokenIssuer": true,
  "postgres-tenancy:OperatorDirectory": true,
  "postgres-tenancy:ProvidersRepository": true,
  "postgres-tenancy:FilesRepository": true,
  "postgres-tenancy:SecretsRepository": true,
  "postgres-tenancy:EnvironmentVariableRepository": true,
  "postgres-tenancy:ThreadRepository": true,
  "postgres-tenancy:TurnRepository": true,
  "postgres-tenancy:PostmanRepository": true,
  "postgres-tenancy:ConversationsErasureStore": true,
  "postgres-tenancy:SkillsRepository": true,
  "postgres-tenancy:MemoryRepository": true,
  "postgres-tenancy:KnowledgeGraphRepository": true,
  "postgres-tenancy:PrivacyRepository": true,
  "postgres-tenancy:JobsRepository": true,
  "postgres-tenancy:ApprovalsRepository": true,
  "postgres-tenancy:ObservabilityRepository": true,
  "postgres-tenancy:NotificationRuleRepository": true,
  "outbox:OutboxWriter": true,
  "durable-runtime:DurableRuntime": true,
  "clickhouse-observability:ObservabilitySink": true,
  "objectstore-minio:ObjectStore": true,
  "redis-ratelimit:RateLimiter": true,
  "redis-cache:Cache": true,
  "redis-streams:EventBus": true,
  "model-router-providers:ModelRouter": true,
  "channel-slack:ChannelAdapter": true,
  "notifier-email:Notifier": true,
  "notifier-webhook:Notifier": true,
});

/**
 * WIN-258 T4 — the ONE cross-adapter obligation, proven where composition happens.
 *
 * The kernel outbox adapter is the single writer of the `Event` row and holds no
 * vendor client: ADR M0.3 §15 gives the ORM one home, so the row's INSERT lives
 * in `postgres-tenancy` and the outbox reaches it through the `OutboxEventStore`
 * seam it declares. Rule (j2) `adapter-is-self-contained` forbids either package
 * from importing the other, so the two halves of that seam agree STRUCTURALLY —
 * and a structural agreement nothing checks is an agreement that drifts.
 *
 * This file is the one place entitled to name both packages, which makes it the
 * one place the agreement can be checked. `never` is not assignable to `true`,
 * so the day `postgres-tenancy` changes a parameter or a return type of either
 * method, `pnpm build:v1` fails HERE — at the composition root, which is where
 * the mistake would otherwise surface as a runtime type error in production.
 *
 * IT IS DELIBERATELY NOT AN ENTRY IN `PORT_SATISFACTION`. That table is checked
 * against `ADAPTER_BINDINGS` in both directions by
 * `scripts/arch/composition-root.mjs`, and `OutboxEventStore` is not a bound
 * PORT: no context and not the kernel owns it, nothing is wired to it by name,
 * and adding a row for it would claim a thirty-second binding the ADR does not
 * declare. It is an obligation between two adapters, so it is stated as one.
 */
export const OUTBOX_STORE_SATISFACTION: Satisfies<PostgresTenancyAdapter, OutboxEventStore> = true;

/** Who owns the port an adapter implements: a context, or the kernel itself. */
export interface AdapterBinding {
  readonly adapter: AdapterName;
  readonly port: string;
  readonly owner: string;
}

/**
 * The declared bindings, in ADR M0.3 §4/§13 order.
 *
 * This table is the runtime shadow of `PORT_SATISFACTION` above, and
 * `composition-root.mjs` asserts the two agree with the generator's `ADAPTERS`
 * table on all three of name, port and owner. Three independently maintained
 * statements of the same fact, cross-checked, is what stops the composition root
 * silently disagreeing with the architecture it composes.
 */
export const ADAPTER_BINDINGS: readonly AdapterBinding[] = Object.freeze([
  Object.freeze({ adapter: "postgres-tenancy", port: "TenancyRepository", owner: "tenancy" }),
  // WIN-258 T2 (ADR M0.3 §15). The SECOND binding of the same directory. It is
  // a row here, not a thirteenth adapter package, because there is one
  // PostgreSQL database behind one client and sixteen adapter packages would be
  // sixteen homes for that client — which would make `tenancy-prisma-only`, the
  // rule that pins the ORM to one directory, unwritable as a single-home rule.
  Object.freeze({
    adapter: "postgres-tenancy",
    port: "IdentityAccessRepository",
    owner: "identity-access",
  }),
  // WIN-258 T5. The THIRD binding of the same directory, and the argument is
  // unchanged by the count: `tools` owns ten canonical rows in the one
  // PostgreSQL database, so its repository is the one client, the one pool and
  // the one transaction. `CANONICAL_STORE_ADAPTERS` in
  // scripts/arch/table-ownership.mjs grants exactly those ten rows and no more.
  Object.freeze({ adapter: "postgres-tenancy", port: "ToolsRepository", owner: "tools" }),
  // WIN-258 T5 (ADR M0.3 §15). The FOURTH and FIFTH bindings of the same
  // directory. They are two rows and not one because `agents` publishes two
  // ports: `AgentsRepository` carries the version/binding invariant that every
  // one of its methods has to respect, and `ScaffoldingRepository` carries the
  // two rows a SURFACE writes on its own behalf — a macro that outlives every
  // version of every agent, and a saved request that is not part of an agent's
  // configuration. Folding them into one port is what would let a future method
  // acquire an invariant it has no business having.
  Object.freeze({ adapter: "postgres-tenancy", port: "AgentsRepository", owner: "agents" }),
  Object.freeze({ adapter: "postgres-tenancy", port: "ScaffoldingRepository", owner: "agents" }),
  // WIN-258 T5 (ADR M0.3 §15). The SIXTH binding of the same directory, and the
  // fifth owner of the one PostgreSQL client. `cost-monitoring` is sole writer
  // of six rows in the same database as tenancy's and identity-access's, so a
  // separate adapter package for them would be a second home for a client the
  // architecture gives exactly one.
  Object.freeze({
    adapter: "postgres-tenancy",
    port: "BudgetRepository",
    owner: "cost-monitoring",
  }),
  // WIN-258 T5 (ADR M0.3 §15). The SEVENTH canonical-store binding of the same
  // directory, and the sixth CONTEXT owner of the one PostgreSQL client.
  // `channels` is sole writer of six rows in the same database as tenancy's,
  // identity-access's, tools', agents' and cost-monitoring's, so a separate
  // adapter package for them would be a second home for a client the
  // architecture gives exactly one.
  //
  // IT SITS HERE, BEFORE THE M2.3 BLOCK, because the block below is about a
  // different KIND of binding and its own comment counts from the end of this
  // group. A repository composite added after it would have made that comment's
  // ordinals wrong, which is the drift the ordinals exist to make visible.
  Object.freeze({
    adapter: "postgres-tenancy",
    port: "ChannelsRepository",
    owner: "channels",
  }),
  // WIN-258 T5 (ADR M0.3 §15). The EIGHTH through TWELFTH bindings of the same
  // directory, and the SEVENTH owner of the one PostgreSQL client. They are FIVE
  // rows and not one because `governance` publishes five separate ports over
  // five separate rows, and folding them into one composite is precisely what
  // would let a method acquire an invariant it has no business having: an eval
  // is APPEND-ONLY and a criterion is edited, a rating FLIPS in place and a
  // safety event is never touched again, and a golden set is a pinned sample
  // that shares no invariant with any of them.
  //
  // The context's other five ports get no row here, and that is a claim rather
  // than an omission: `read-seams.ts` declares three READERS of rows
  // `conversations`, `tools` and `jobs` own, `judge.ts` is a provider transport,
  // and `eval-run-queue.ts` is durable work whose own refusal code exists to
  // stay separable from a store outage.
  Object.freeze({ adapter: "postgres-tenancy", port: "SafetyLedger", owner: "governance" }),
  Object.freeze({ adapter: "postgres-tenancy", port: "RatingsRepository", owner: "governance" }),
  Object.freeze({ adapter: "postgres-tenancy", port: "CriteriaRepository", owner: "governance" }),
  Object.freeze({ adapter: "postgres-tenancy", port: "EvalsRepository", owner: "governance" }),
  Object.freeze({ adapter: "postgres-tenancy", port: "GoldenSetsRepository", owner: "governance" }),
  // WIN-258 T5 (ADR M0.3 §15). The THIRTEENTH and FOURTEENTH bindings of the
  // same directory, and the eighth owner of the one PostgreSQL client. They are two
  // rows and not one because `secrets` publishes two ports:
  // `SecretsRepository` carries the credential, its envelopes and the
  // append-only evidence of both, and `EnvironmentVariableRepository` carries
  // the configuration row that POINTS at a credential. Their own port file says
  // why — "so the two aggregates keep separate vocabularies, and so a
  // composition root may back them with different stores without either port
  // growing a conditional".
  Object.freeze({ adapter: "postgres-tenancy", port: "SecretsRepository", owner: "secrets" }),
  Object.freeze({
    adapter: "postgres-tenancy",
    port: "EnvironmentVariableRepository",
    owner: "secrets",
  }),
  // WIN-258 T5 (ADR M0.3 §15). The FIFTEENTH binding of the same directory, and
  // the NINTH owner of the one PostgreSQL client. `providers` is sole writer of
  // four rows — `ProviderKey`, `EnvironmentProvider`, `Model` and `ModelPrice` —
  // in the same database as the other thirty-nine, so a separate adapter package
  // for them would be a second home for a client the architecture gives exactly
  // one. It is ONE row and not two because `providers` publishes ONE
  // canonical-store port over all four.
  //
  // IT SITS AT THE END OF THE REPOSITORY GROUP rather than beside `channels`,
  // and that is the placement the ordinals force: the five rows below count from
  // the end of this group, so a repository composite inserted anywhere ABOVE
  // would have made their ordinals wrong. Adding one here moves exactly one
  // number — theirs — which the block's own comment now states.
  //
  // The context's TWO OTHER ports get no row here, and that is a claim rather
  // than an omission: `ModelRouter` already has one, bound to
  // `model-router-providers` at the bottom of this table by ADR M0.3 §5.1 rule
  // (h), and `ProviderProbeCache` is a five-minute memo of what a provider said
  // — §13's map has no home for it and no canonical store should hold it.
  Object.freeze({ adapter: "postgres-tenancy", port: "ProvidersRepository", owner: "providers" }),
  // WIN-258 T5 (ADR M0.3 §15). The SIXTEENTH through NINETEENTH bindings of the
  // same directory, and the TENTH owner of the one PostgreSQL client. They are
  // FOUR rows and not one because `conversations` publishes four separate ports
  // over four separate lifetimes: a THREAD is opened, forked, compacted and
  // archived; a TURN and its STEPS settle together and are never edited again; a
  // POSTMAN EXECUTION outlives the turn it produced, which is what makes it an
  // audit row; and the ERASURE half is the only surface in the context that
  // deletes anything, kept apart so that every use case does not hold a
  // `deleteAll` it has no business holding.
  //
  // AND THERE IS NOTHING TO SKIP HERE, which is unusual enough in this table to
  // be worth saying: this context declares FOUR driven ports and all four are
  // canonical stores. Its own `application/ports/index.ts` says why — "FOUR
  // PORTS AND NOT ONE MORE" — because every other collaborator a turn needs is
  // reached through a peer context's published contract, so there is no
  // `ModelPort` and no `ToolExecutorPort` for an adapter to satisfy. The
  // inference seam is `providers`' `ModelRouter`, bound below.
  Object.freeze({ adapter: "postgres-tenancy", port: "ThreadRepository", owner: "conversations" }),
  Object.freeze({ adapter: "postgres-tenancy", port: "TurnRepository", owner: "conversations" }),
  Object.freeze({ adapter: "postgres-tenancy", port: "PostmanRepository", owner: "conversations" }),
  Object.freeze({
    adapter: "postgres-tenancy",
    port: "ConversationsErasureStore",
    owner: "conversations",
  }),
  // WIN-258 T5 (ADR M0.3 §15). The TWENTIETH binding of the same directory, and
  // the ELEVENTH owner of the one PostgreSQL client. ONE row and not three, because
  // `skills` publishes ONE canonical-store port over its three tables: a
  // catalogue entry, the project adoption of one and the environment binding of
  // that adoption are one aggregate with one uniqueness key, and the port's own
  // header says there is deliberately no generic `save(row)` through which
  // another context could reach any of them from the side.
  Object.freeze({ adapter: "postgres-tenancy", port: "SkillsRepository", owner: "skills" }),
  // WIN-258 M2.3 — TENANCY'S FIVE NON-REPOSITORY PORTS, the TWENTY-FIRST through
  // TWENTY-FIFTH bindings of the same directory.
  //
  // They are a different KIND of binding from the twenty above and that is why
  // they sit together at the end rather than beside `TenancyRepository`: each of
  // those is a whole repository composite spread into the adapter or a named
  // store slot on it, and each of these five is a single named PROPERTY. The
  // ordinals above stay true because every addition has gone in FRONT of this
  // block rather than into it.
  //
  // WHY THEY GET SLOTS AT ALL. This table is the surface that proves every port
  // has a satisfying adapter — `composition-root.mjs` compares it against the
  // generator's table in BOTH directions and against `PORT_SATISFACTION` in both
  // directions. A port that is satisfied but not declared is invisible to all
  // four comparisons, so leaving these five out did not make a smaller claim: it
  // silently narrowed the completeness property to the ports that happened to be
  // listed. `reportAdapterSupply` can now say an install has not wired the
  // session revoker, which before this it could not.
  Object.freeze({ adapter: "postgres-tenancy", port: "TenancyLocks", owner: "tenancy" }),
  Object.freeze({ adapter: "postgres-tenancy", port: "OperatorSessionRevoker", owner: "tenancy" }),
  Object.freeze({
    adapter: "postgres-tenancy",
    port: "EnvironmentAccessKeyRevocationCounter",
    owner: "tenancy",
  }),
  Object.freeze({ adapter: "postgres-tenancy", port: "InvitationTokenIssuer", owner: "tenancy" }),
  Object.freeze({ adapter: "postgres-tenancy", port: "OperatorDirectory", owner: "tenancy" }),
  // WIN-258 T5 (ADR M0.3 §15). The TWENTY-SIXTH and TWENTY-SEVENTH bindings of
  // the same directory, and the TWELFTH owner of the one PostgreSQL client.
  //
  // THEY SIT AFTER TENANCY'S FIVE RATHER THAN BESIDE `secrets`' PAIR, and that
  // is a decision rather than an accident. Every block above counts its own
  // ordinals from the end of the block before it, so inserting two rows in the
  // middle would silently make three comments wrong; appending keeps every
  // ordinal above true. They also belong here on their own merits: like the five
  // they follow, and unlike the seven composites at the top, each of these is a
  // single named PROPERTY on the adapter rather than a spread-in composite.
  //
  // They are TWO rows and not one because `memory` publishes two ports over
  // three rows, and the split is the one its own port file argues for: the
  // memory store is on the write path of every remembered fact and the graph is
  // on the write path of extraction and the read path of fused retrieval, "so an
  // installation can stand one of them up against a different technology without
  // the other's methods coming along".
  //
  // The context's other four ports get no row here, and that is a claim rather
  // than an omission: `Cache` is bound below to `redis-cache`, which ADR M0.3
  // §13 names while assigning the PORT to this context; `EmbeddingModel` and
  // `ExtractionJudge` are priced provider calls; and `ContentDigest` is a
  // synchronous host hash with no failure channel and no row.
  Object.freeze({ adapter: "postgres-tenancy", port: "MemoryRepository", owner: "memory" }),
  Object.freeze({
    adapter: "postgres-tenancy",
    port: "KnowledgeGraphRepository",
    owner: "memory",
  }),
  // WIN-258 T5 (ADR M0.3 §15). The TWENTY-EIGHTH binding of the same directory,
  // and the THIRTEENTH owner of the one PostgreSQL client. ONE row and not two,
  // because `privacy` publishes ONE canonical-store port over its two tables:
  // `PrivacyRepository` is `OperationRepository` and `TombstoneRepository`
  // composed, and the port's own header says there is deliberately no generic
  // `save(row)` or `query(where)` "through which another context could reach the
  // tables sideways".
  //
  // IT APPENDS, like `memory`'s pair above it, so every ordinal already stated in
  // this table stays true.
  //
  // The context's THREE other ports get no row here, and that is a claim rather
  // than an omission. `SubjectDirectory` resolves a handle into every scope and
  // alias a person occupies by reading `identity-access`' identity graph — rows
  // this directory can physically read and that port is not entitled to, because
  // its own header says it is the COMPOSITION ROOT, not the adapter, that is
  // allowed to know identity-access exists. `SubjectHasher` is a synchronous
  // salted digest whose secret has no business behind a database client, and
  // `LegalHoldRegister` is installation configuration with no canonical row in
  // the schema at all.
  Object.freeze({ adapter: "postgres-tenancy", port: "PrivacyRepository", owner: "privacy" }),
  // WIN-258 T5 — `jobs`' TWO canonical-store ports, on that same directory, and
  // the FOURTEENTH owner of the one PostgreSQL client. Appended after `privacy`'s
  // row for the reason that row was appended after memory's pair: every block
  // above counts its ordinals from the end of the block before it, so inserting
  // in the middle would silently make four comments wrong.
  //
  // They are TWO rows and not one because `jobs` publishes two ports over two
  // rows, and the split is the one `domain/index.ts` argues for: "They share an
  // owner and a scope and nothing else, so they are two aggregates rather than
  // one. A `Job` outlives every run of it; an `Approval` is born and dies inside
  // a single turn."
  //
  // The context's other two ports get no row here, and that is a claim rather
  // than an omission. `IdempotencyStore` is a reserve-once keyspace — an atomic
  // claim-or-report, a TTL the store enforces, and an update that must not
  // resurrect an expired key — none of which PostgreSQL has, and all of which
  // `redis-cache` below does. `JobHandlerRuntime` is the isolate that runs
  // untrusted handler source, which ADR M0.3 §7 decision 10 puts behind
  // `durable-runtime`; it writes no row.
  Object.freeze({ adapter: "postgres-tenancy", port: "JobsRepository", owner: "jobs" }),
  Object.freeze({ adapter: "postgres-tenancy", port: "ApprovalsRepository", owner: "jobs" }),
  Object.freeze({ adapter: "outbox", port: "OutboxWriter", owner: "kernel" }),
  Object.freeze({ adapter: "durable-runtime", port: "DurableRuntime", owner: "kernel" }),
  Object.freeze({ adapter: "clickhouse-observability", port: "ObservabilitySink", owner: "observability" }),
  // WIN-258 T5 (ADR M0.3 §15). The FIFTEENTH owner of the one PostgreSQL
  // directory: `files`' two canonical rows, `MessageAttachment` and `Artifact`.
  // It sits beside the `ObjectStore` row below rather than replacing it, because
  // this context owns TWO ports over two technologies.
  Object.freeze({ adapter: "postgres-tenancy", port: "FilesRepository", owner: "files" }),
  Object.freeze({ adapter: "objectstore-minio", port: "ObjectStore", owner: "files" }),
  // and the SIXTEENTH owner of the one PostgreSQL client. Appended for the
  // reason `memory`'s pair was: every block above counts its ordinals from the
  // end of the block before it, so a row inserted in the middle would silently
  // make four comments wrong.
  //
  // ONE row for a context ADR M0.3 §1 row 12 credits with FIVE tables, and the
  // arithmetic is the interesting part rather than a shortfall. Four of those
  // five are the analytical projections, which are not Prisma rows at all and
  // are bound below to `clickhouse-observability`; `AdminAudit` is the one that
  // is, and this is it.
  //
  // The context's two remaining driven ports get no row here and that is a claim
  // rather than an omission. `ProjectionOutbox` settles `ObservabilityOutbox`,
  // whose only writer is the kernel outbox adapter (§1's closing note, §7
  // decision 8) — this context decides the outcome and does not write the row.
  // `ErasedSubjectRegister` and `SubjectLocatorSource` read `privacy`'s
  // tombstones and `conversations`' threads, and their own headers say the
  // composition root resolves them by asking those owners.
  Object.freeze({
    adapter: "postgres-tenancy",
    port: "ObservabilityRepository",
    owner: "observability",
  }),
  // WIN-258 T5 (ADR M0.3 §15). The SEVENTEENTH and LAST owner of the one
  // PostgreSQL client, which completes ADR M0.3 §1. ONE row —
  // `NotificationRule` — which is the smallest grant this table has made, and
  // the argument for it is the same as for the sixteen owners above: without the
  // delegation the one package permitted to write the row is the one package §2
  // forbids from importing the ORM.
  //
  // IT SITS AT THE END, like `memory`'s pair and tenancy's five before it, so
  // every ordinal above stays true. Unlike those seven it is a SPREAD rather
  // than a named property: nothing it publishes collides.
  //
  // The context's TWO OTHER ports get no row here, and that is a claim rather
  // than an omission. `DestinationScreen` is the SSRF boundary — its contract is
  // DNS resolution and a socket pinned to the address that resolved, and its own
  // header says the adapter satisfying it is "the sole holder of the resolver";
  // a PostgreSQL client opens no sockets. `NotificationQueue` is a DELAYED
  // hand-off whose `availableAt` exists because the legacy in-process timer
  // "loses every scheduled retry if the process restarts inside the window",
  // which asks for the durable schedule ADR M0.3 §7 decision 10 puts behind
  // `durable-runtime`. Neither is a store.
  Object.freeze({
    adapter: "postgres-tenancy",
    port: "NotificationRuleRepository",
    owner: "eventing",
  }),
  Object.freeze({ adapter: "redis-ratelimit", port: "RateLimiter", owner: "identity-access" }),
  Object.freeze({ adapter: "redis-cache", port: "Cache", owner: "memory" }),
  Object.freeze({ adapter: "redis-streams", port: "EventBus", owner: "kernel" }),
  Object.freeze({ adapter: "model-router-providers", port: "ModelRouter", owner: "providers" }),
  Object.freeze({ adapter: "channel-slack", port: "ChannelAdapter", owner: "channels" }),
  Object.freeze({ adapter: "notifier-email", port: "Notifier", owner: "cost-monitoring" }),
  Object.freeze({ adapter: "notifier-webhook", port: "Notifier", owner: "cost-monitoring" }),
] as const satisfies readonly AdapterBinding[]);

/**
 * Every DIRECTORY that carries a binding, each once and in declaration order.
 *
 * De-duplicated because `ADAPTER_BINDINGS` now holds FORTY-FOUR rows across
 * twelve directories: a caller iterating this list to construct or close
 * adapters would otherwise build `postgres-tenancy` THIRTY-THREE times and
 * open thirty-three pools over the one database.
 */
export const ADAPTER_NAMES: readonly AdapterName[] = Object.freeze([
  ...new Set(ADAPTER_BINDINGS.map((binding) => binding.adapter)),
]);
