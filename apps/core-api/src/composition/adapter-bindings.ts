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

import type {
  Clock,
  CorrelationSource,
  DurableRuntime,
  EventBus,
  OutboxWriter,
  RequestIdempotency,
} from "@platos/kernel";

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
  AeadCipher,
  EnvironmentVariableRepository,
  Hasher,
  KeyRing,
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
  IdempotencyStore,
  JobsRepository,
} from "@platos/context-jobs/application/ports/index.js";

import type { PostgresTenancyAdapter } from "@platos/adapter-postgres-tenancy";
// WIN-267 T3 — the FIRST value imports this file has ever carried. Every import
// above is a type and erases; these five are the constructors, and they are what
// turn "the one place a port meets its implementation" from a claim about where
// an interface is NAMED into a claim about where an object is BUILT.
//
// `buildPostgresTenancyAdapter` over `createTenancyDatabaseClient`, rather than
// the one-call `createPostgresTenancyAdapter`, for ONE reason: the three-argument
// form is the only one that takes a `CorrelationSource`, and
// `runtime/correlation.ts` says outright that the composition root is what hands
// that object over — "the adapter names the kernel port, the composition root
// hands it this object, and packages/adapters/postgres-tenancy puts the value
// into PostgreSQL's own session state for the transaction". Calling the one-arg
// factory would have left `platos.request_id` unset on every transaction in
// production and made WIN-260's correlation work unreachable from the process
// that ships.
import { buildPostgresTenancyAdapter, createTenancyDatabaseClient } from "@platos/adapter-postgres-tenancy";
import type { OutboxAdapter, OutboxEventStore, OutboxFlush } from "@platos/adapter-outbox";
import { buildOutboxAdapter } from "@platos/adapter-outbox";
import type { DurableRuntimeAdapter } from "@platos/adapter-durable-runtime";
import type { ClickhouseObservabilityAdapter } from "@platos/adapter-clickhouse-observability";
import type { ObjectstoreMinioAdapter } from "@platos/adapter-objectstore-minio";
import type { RedisRatelimitAdapter } from "@platos/adapter-redis-ratelimit";
// WIN-267 A3 — the SIXTH value import, and the first that turns a generated
// placeholder into a constructed object. `redis-ratelimit` left
// `UNIMPLEMENTED_ADAPTERS` in the same commit, which rule (C7) checks against the
// directory's own source in both directions.
import { createRedisRatelimitAdapter } from "@platos/adapter-redis-ratelimit";
import type { RedisCacheAdapter } from "@platos/adapter-redis-cache";
import { createRedisCacheAdapter } from "@platos/adapter-redis-cache";
import type { RedisStreamsAdapter } from "@platos/adapter-redis-streams";
import type { ModelRouterProvidersAdapter } from "@platos/adapter-model-router-providers";
import { createModelRouterProvidersAdapter } from "@platos/adapter-model-router-providers";
import type { ChannelSlackAdapter } from "@platos/adapter-channel-slack";
import type { NotifierEmailAdapter } from "@platos/adapter-notifier-email";
import type { NotifierWebhookAdapter } from "@platos/adapter-notifier-webhook";
import type { KeyringEnvelopeAdapter } from "@platos/adapter-keyring-envelope";
import { buildKeyringEnvelope } from "@platos/adapter-keyring-envelope";

import type { ProvidersConfiguration } from "../config/providers.js";
import type { SecurityConfiguration } from "../config/security.js";
import type { StoresConfiguration } from "../config/stores.js";
import type { Drainable } from "../runtime/shutdown-drain.js";

/**
 * The thirteen adapter slots, keyed by directory name.
 *
 * The key is the adapter's directory because that is the name every other gate
 * already uses — `scripts/arch/boundary-rules.mjs`, the generator's `ADAPTERS`
 * table and `v1-project-graph.mjs`'s `EXPECTED_ADAPTER_OWNERS` all agree on it,
 * so a mismatch here is mechanically detectable rather than a matter of taste.
 *
 * THIRTEEN SLOTS, FORTY-SEVEN BINDINGS (ADR M0.3 §15, amended by WIN-259). An
 * install wires a DIRECTORY — one process-lifetime object holding one vendor
 * client — so this table stays keyed by directory. What a directory SATISFIES is
 * a different question, and `PORT_SATISFACTION` below answers it per binding.
 *
 * TWELVE HELD FOR SEVENTEEN CONSECUTIVE OWNER GRANTS AND THEN MOVED ONCE.
 * Every one of those seventeen added another owner of the rows in the ONE
 * PostgreSQL database, which §15 says is a row on an existing directory rather
 * than a new package. `keyring-envelope` is the case §15 does not reach: it
 * holds no rows and no database client, it holds the AES-256 root keys, and the
 * ORM's own adapter refused all three of its ports because "putting it here
 * would move the keys that decrypt every envelope into the process that holds
 * the database connection, so a single credential leak would yield both halves".
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
  // WIN-259 M2.4 — the THIRTEENTH slot, and the first one added since this table
  // was drawn. It is a slot and not a row on `postgres-tenancy` because an
  // install wires ONE process-lifetime object holding ONE vendor client, and a
  // root key ring is not the ORM's client: it is the AES-256 material that opens
  // every envelope the ORM stores. `secrets-repository.ts` declined all three of
  // its ports on exactly that ground.
  readonly "keyring-envelope": KeyringEnvelopeAdapter;
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
  readonly "redis-cache:Cache": Satisfies<RedisCacheAdapter["cache"], Cache>;
  readonly "redis-cache:IdempotencyStore": Satisfies<RedisCacheAdapter["idempotency"], IdempotencyStore>;
  // WIN-260 (M2.5), the errors-and-idempotency dimension. The THIRD port on this
  // directory and the first kernel port it carries. Indexed through the PROPERTY
  // for the reason the two above it are: the adapter is one object serving three
  // contracts, and `Satisfies<RedisCacheAdapter, RequestIdempotency>` would ask
  // whether the whole adapter is a request-idempotency store, which it is not.
  readonly "redis-cache:RequestIdempotency": Satisfies<
    RedisCacheAdapter["requests"],
    RequestIdempotency
  >;
  readonly "redis-streams:EventBus": Satisfies<RedisStreamsAdapter, EventBus>;
  readonly "model-router-providers:ModelRouter": Satisfies<ModelRouterProvidersAdapter, ModelRouter>;
  readonly "channel-slack:ChannelAdapter": Satisfies<ChannelSlackAdapter, ChannelAdapter>;
  readonly "notifier-email:Notifier": Satisfies<NotifierEmailAdapter, Notifier>;
  readonly "notifier-webhook:Notifier": Satisfies<NotifierWebhookAdapter, Notifier>;
  // WIN-259 M2.4. `secrets`' THREE cryptography ports, every one proven against
  // the ADAPTER rather than through a property: `state`/`handle`, `seal`/`open`
  // and `hash`/`verify` are six names with no collision, so one interface
  // extends all three and nothing forces the indirection `secrets`' two STORE
  // bindings above needed.
  //
  // THREE OBLIGATIONS AND NOT ONE, and the split does for this directory what
  // the §15 key does for the ORM's. Collapse them into `keyring-envelope:KeyRing`
  // alone and the compiler would stop noticing the day `seal` changed shape,
  // because a missing obligation is not a wrong one.
  readonly "keyring-envelope:KeyRing": Satisfies<KeyringEnvelopeAdapter, KeyRing>;
  readonly "keyring-envelope:AeadCipher": Satisfies<KeyringEnvelopeAdapter, AeadCipher>;
  readonly "keyring-envelope:Hasher": Satisfies<KeyringEnvelopeAdapter, Hasher>;
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
  "redis-cache:IdempotencyStore": true,
  "redis-cache:RequestIdempotency": true,
  "redis-streams:EventBus": true,
  "model-router-providers:ModelRouter": true,
  "channel-slack:ChannelAdapter": true,
  "notifier-email:Notifier": true,
  "notifier-webhook:Notifier": true,
  "keyring-envelope:KeyRing": true,
  "keyring-envelope:AeadCipher": true,
  "keyring-envelope:Hasher": true,
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

/**
 * WIN-260 (M2.5). The SECOND obligation this file states rather than binds.
 *
 * `apps/core-api/src/runtime/shutdown-drain.ts` sequences `Drainable`s inside
 * one shutdown budget, and the outbox flush is the first of them. The flush
 * itself lives in `@platos/adapter-outbox` — `scripts/arch/composition-root.mjs`
 * rule (C1) allows exactly ONE importer of an adapter package, which is this
 * file, and the paging contract it implements is outbox knowledge anyway. So the
 * two halves agree STRUCTURALLY, the same way `OutboxEventStore` above does, and
 * the agreement is checked HERE because this is the only file entitled to name
 * both packages. It is not a bound PORT and gets no row in `ADAPTER_BINDINGS`:
 * nothing is wired to it by name, and a row would claim a binding the ADR does
 * not declare.
 */
export const OUTBOX_FLUSH_SATISFACTION: Satisfies<OutboxFlush, Drainable> = true;

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
  // WIN-260 (M2.5). The SECOND binding on this directory, and the FIRST time the
  // §15 amendment has been applied outside `postgres-tenancy`. `Cache` and
  // `IdempotencyStore` sit behind ONE Redis connection, so they are one
  // directory; a thirteenth would have been a second client for one server.
  //
  // The claim the `jobs` rows above make is now discharged. They say
  // `IdempotencyStore` is "a reserve-once keyspace — an atomic claim-or-report,
  // a TTL the store enforces, and an update that must not resurrect an expired
  // key — none of which PostgreSQL has, and all of which `redis-cache` below
  // does". Until this row, "does" was a promise about a placeholder.
  Object.freeze({ adapter: "redis-cache", port: "Cache", owner: "memory" }),
  Object.freeze({ adapter: "redis-cache", port: "IdempotencyStore", owner: "jobs" }),
  // WIN-260 (M2.5), the errors-and-idempotency dimension. The THIRD row on this
  // directory and the FORTY-SIXTH binding. `RequestIdempotency` is M0.4 §2's
  // `Idempotency-Key` envelope — the header a transport reads, the reservation
  // that makes a replay possible, and the one-time-secret mints that REQUIRE
  // both. Its owner is `kernel` and not `jobs`: `jobs`' `IdempotencyStore`
  // reserves a job EXECUTION keyed by an `ExecutionRequestId` and settles with a
  // `JobExecutionErrorCode`, while this reserves an HTTP REQUEST keyed by a
  // caller's header and settles with the bytes that went on the wire. All
  // seventeen contexts have side-effecting operations the rule covers and none
  // of them decides anything with the key, which is the test `CorrelationSource`
  // passed to become a kernel port.
  Object.freeze({ adapter: "redis-cache", port: "RequestIdempotency", owner: "kernel" }),
  Object.freeze({ adapter: "redis-streams", port: "EventBus", owner: "kernel" }),
  Object.freeze({ adapter: "model-router-providers", port: "ModelRouter", owner: "providers" }),
  Object.freeze({ adapter: "channel-slack", port: "ChannelAdapter", owner: "channels" }),
  Object.freeze({ adapter: "notifier-email", port: "Notifier", owner: "cost-monitoring" }),
  Object.freeze({ adapter: "notifier-webhook", port: "Notifier", owner: "cost-monitoring" }),
  // WIN-259 M2.4. The three bindings of the thirteenth directory. They sit at the
  // END so every ordinal above stays true, exactly as the seventeen owner rows of
  // `postgres-tenancy` were appended rather than interleaved.
  Object.freeze({ adapter: "keyring-envelope", port: "KeyRing", owner: "secrets" }),
  Object.freeze({ adapter: "keyring-envelope", port: "AeadCipher", owner: "secrets" }),
  Object.freeze({ adapter: "keyring-envelope", port: "Hasher", owner: "secrets" }),
] as const satisfies readonly AdapterBinding[]);

/**
 * Every DIRECTORY that carries a binding, each once and in declaration order.
 *
 * De-duplicated because `ADAPTER_BINDINGS` now holds FORTY-NINE rows across
 * thirteen directories: a caller iterating this list to construct or close
 * adapters would otherwise build `postgres-tenancy` THIRTY-THREE times and
 * open thirty-three pools over the one database.
 */
export const ADAPTER_NAMES: readonly AdapterName[] = Object.freeze([
  ...new Set(ADAPTER_BINDINGS.map((binding) => binding.adapter)),
]);

// ---------------------------------------------------------------------------
// WIN-267 T3 — CONSTRUCTION. The half this file did not have.
//
// Everything above DECLARES. `PORT_SATISFACTION` proves at COMPILE TIME that
// each of the forty-nine bindings is satisfiable, and until this section existed
// that proof was the whole of the wiring: `startCoreApi({configuration})` was
// handed no adapters, `reportAdapterSupply({})` therefore answered `0/49`, and
// `/readyz` was 503 in EVERY configuration BY CONSTRUCTION rather than because
// anything about an install was wrong. A readiness endpoint that cannot report
// anything but red is not a readiness endpoint.
//
// WHAT DECIDES WHETHER A DIRECTORY IS CONSTRUCTED. Two different questions, and
// keeping them apart is the whole value of the report below:
//
//   CONFIGURATION — the install did not declare the group this directory needs.
//   `stores.postgres` absent means no database URL, so there is no pool to open.
//   That is an operator's answer and it is fixed by setting a variable.
//
//   IMPLEMENTATION — the directory has no constructor to call. EIGHT of the
//   thirteen are still WIN-251's generated skeleton: `src/adapter.ts` holds an
//   interface extending the port and nothing else. No amount of configuration
//   reaches them, and `UNIMPLEMENTED_ADAPTERS` below names them so readiness can
//   say which of the two an operator is looking at.
//
// A READINESS LINE THAT SAID ONLY "unsatisfied" WOULD CONFLATE THOSE, and the
// operator response differs completely: one is a variable, the other is work
// that has not happened. So every directory this function declines to build
// carries a CAUSE and a REASON, and both reach `/readyz`.
// ---------------------------------------------------------------------------

/**
 * The directories `packages/adapters/` publishes as a TYPE and nothing else.
 *
 * These are not omissions of this file's: each one's `src/adapter.ts` is the
 * generated placeholder `scripts/arch/gen-v1-skeleton.mjs` emits — an interface
 * extending the port, carrying the adapter's own name, exporting no factory. A
 * composition root cannot construct an interface, so naming them here is the
 * honest statement of why eight directories, and the bindings on them, can never
 * be satisfied in this build.
 *
 * IT IS NOT A LIST THIS FILE IS TRUSTED WITH. `scripts/arch/composition-root.mjs`
 * rule (C7) reads it back and JOINS IT TO THE FILESYSTEM: every directory named
 * here must export no `create*Adapter`/`build*Adapter`, and every directory NOT
 * named here must export one. BOTH DIRECTIONS, so the list cannot go stale in
 * either — an adapter that gains an implementation and is left on this list
 * fails, and one dropped from the list without gaining an implementation fails
 * too. That is the join this programme's first lesson is about: the assertion is
 * against the adapter packages' own source, never against another number this
 * file wrote.
 */
export const UNIMPLEMENTED_ADAPTERS: readonly AdapterName[] = Object.freeze([
  "durable-runtime",
  "clickhouse-observability",
  "objectstore-minio",
  // WIN-267 A3 — `redis-ratelimit` LEFT THIS LIST. It is the first directory
  // ever to do so, and rule (C7) is what makes the removal honest rather than
  // optimistic: it reads this list back and joins it to the filesystem, so a
  // directory dropped from here without gaining a `create*Adapter` fails, and
  // one that gained a factory and stayed here fails too.
  "redis-streams",
  "channel-slack",
  "notifier-email",
  "notifier-webhook",
]);

/** Why one adapter directory holds no object. One row per directory NOT built. */
export interface UnwiredAdapter {
  readonly adapter: AdapterName;
  /**
   * `configuration` is fixed by setting a variable; `implementation` is not
   * fixed by anything an operator can do. See the two-questions note above.
   */
  readonly cause: "configuration" | "implementation";
  /** Operator-facing, and it names the VARIABLE or the FILE, never a value. */
  readonly reason: string;
}

/**
 * What an install hands the constructor, narrowed to what it actually reads.
 *
 * THREE of the six validated sections and two kernel ports — not the whole
 * `PlatformConfiguration`. The `core` section is the process's own (port, host,
 * log level, timeouts) and no adapter reads it; `channels` and `durable` belong
 * to two of the eight directories that have no constructor to hand them to.
 * Taking the whole object would have made this signature claim it consumed
 * things it does not.
 */
export interface AdapterConstructionInput {
  readonly stores: StoresConfiguration;
  readonly security: SecurityConfiguration;
  readonly providers: ProvidersConfiguration;
  /** Injected, never ambient: the outbox stamps every event's time from it. */
  readonly clock: Clock;
  /**
   * The request-id seam WIN-260 built and nothing wired.
   *
   * `null` is legitimate — a suite constructing adapters outside a request has
   * no correlation to stamp — and it is not an oversight: both adapters that
   * take one treat null as "whatever the producer named stands".
   */
  readonly correlation: CorrelationSource | null;
}

export interface AdapterConstruction {
  readonly adapters: SuppliedAdapters;
  /** One row per directory NOT built, with its cause. Reaches `/readyz`. */
  readonly unwired: readonly UnwiredAdapter[];
  /**
   * Configuration that parsed as a string and is not usable as a key ring, a
   * connection or a retry policy.
   *
   * SEPARATE FROM `unwired`, because they are opposite failures. An ABSENT group
   * is an install part-way through wiring and the process must serve and say so;
   * a PRESENT group that cannot be turned into an adapter is a misconfiguration
   * no restart fixes, and `main.ts` answers it with EX_CONFIG.
   */
  readonly faults: readonly string[];
  /**
   * Release every pool and connection this call opened, in reverse order.
   *
   * The composition root owns each adapter's lifetime — both `close()` doc
   * comments in the two directories that hold a vendor client say exactly that —
   * and this is the handle that makes the sentence true. Without it a process
   * that shut its listener cleanly would still hold a PostgreSQL pool and a
   * Redis socket until the orchestrator killed it.
   */
  release(): Promise<void>;
}

/**
 * Build every adapter this configuration declares, and say why for the rest.
 *
 * PURE OVER ITS INPUT in the sense that matters: it reads no environment, takes
 * its clock and its correlation seam as arguments, and returns the same report
 * for the same configuration. It is not pure in the sense of opening no sockets
 * — that is the one thing it exists to do.
 *
 * ORDER IS LOAD-BEARING IN EXACTLY ONE PLACE. `outbox` is built OVER
 * `postgres-tenancy`, because ADR M0.3 §15 gives the ORM one home and the
 * canonical `Event` row is written from it: the outbox package owns every
 * decision that makes an event an event and hands a prepared row across the
 * `OutboxEventStore` seam. So an install with no database gets no outbox either,
 * and the reason it gets back says THAT rather than naming a variable which
 * would not have helped.
 */
export function constructAdapters(input: AdapterConstructionInput): AdapterConstruction {
  const adapters: { -readonly [Name in AdapterName]?: AdapterInstances[Name] } = {};
  const unwired: UnwiredAdapter[] = [];
  const faults: string[] = [];
  const closers: (() => Promise<void>)[] = [];

  const decline = (adapter: AdapterName, cause: UnwiredAdapter["cause"], reason: string): void => {
    unwired.push(Object.freeze({ adapter, cause, reason }));
  };

  const postgres = input.stores.postgres;
  if (postgres === null) {
    decline(
      "postgres-tenancy",
      "configuration",
      "PLATOS_STORE_POSTGRES_URL is not set, so the stores.postgres group is undeclared",
    );
  } else {
    try {
      const client = createTenancyDatabaseClient({
        databaseUrl: postgres.url,
        connectionLimit: postgres.poolMax,
        statementTimeoutMs: postgres.statementTimeoutMs,
      });
      const adapter = buildPostgresTenancyAdapter(client, {}, input.correlation);
      adapters["postgres-tenancy"] = adapter;
      closers.push(() => adapter.close());
    } catch (error) {
      // The NAME and the CODE, never the URL. `config/load.ts` promises a
      // startup diagnostic never echoes a connection string, and the failure
      // path would be a poor place to break that promise:
      // `AdapterConfigurationError` carries a code and a sentence about a pool
      // setting, and both are safe to print.
      faults.push(`postgres-tenancy could not be constructed: ${describeConstructionFault(error)}`);
    }
  }

  const outboxStore: OutboxEventStore | undefined = adapters["postgres-tenancy"];
  if (outboxStore === undefined) {
    decline(
      "outbox",
      "configuration",
      "the OutboxEventStore it appends through is postgres-tenancy (ADR M0.3 §15: one ORM home), which is not constructed",
    );
  } else {
    adapters.outbox = buildOutboxAdapter({
      store: outboxStore,
      clock: input.clock,
      ...(input.correlation === null ? {} : { correlation: input.correlation }),
    });
  }

  const redis = input.stores.redis;
  if (redis === null) {
    decline(
      "redis-cache",
      "configuration",
      "PLATOS_STORE_REDIS_URL is not set, so the stores.redis group is undeclared",
    );
    // WIN-267 A3 — the SAME variable declines BOTH Redis directories, and they
    // are two declines rather than one because they are two objects. ADR M0.3 §4
    // gives `redis-ratelimit` its own directory with "one namespaced keyspace,
    // one owner": the limiter holds `platos:identity:ratelimit:` and the cache
    // holds `platos:jobs:idem:` and `platos:http:idem:`, and an install that
    // wired one and not the other would be a state this table has to be able to
    // report.
    decline(
      "redis-ratelimit",
      "configuration",
      "PLATOS_STORE_REDIS_URL is not set, so the stores.redis group is undeclared",
    );
  } else {
    const adapter = createRedisCacheAdapter({ url: redis.url });
    adapters["redis-cache"] = adapter;
    closers.push(() => adapter.close());
    // A SECOND CLIENT AGAINST THE SAME URL, DELIBERATELY. Sharing one connection
    // between the two directories would make `adapter-is-self-contained` a
    // sentence nobody could check — the limiter would hold an object built by
    // another adapter — and it would tie two lifetimes together, so closing the
    // cache would silently disarm authentication rate limiting.
    const limiter = createRedisRatelimitAdapter({ url: redis.url });
    adapters["redis-ratelimit"] = limiter;
    closers.push(() => limiter.close());
  }

  const encryption = input.security.encryption;
  if (encryption === null) {
    decline(
      "keyring-envelope",
      "configuration",
      "PLATOS_SECURITY_ENCRYPTION_KEY is not set, so the security.encryption group is undeclared",
    );
  } else {
    // A ring that will not parse is EX_CONFIG and NOT a degraded readiness: the
    // key material was supplied and is unusable, so every credential in the
    // vault is unreadable and no amount of waiting changes that.
    const ring = buildKeyringEnvelope({
      activeVersion: encryption.rootKeyVersion,
      keys: { [String(encryption.rootKeyVersion)]: encryption.rootKey },
    });
    if (ring.ok) adapters["keyring-envelope"] = ring.value;
    else faults.push(`keyring-envelope could not be constructed: ${ring.error.code}`);
  }

  if (input.providers.modelRouter === null) {
    decline(
      "model-router-providers",
      "configuration",
      "PLATOS_PROVIDERS_DEFAULT_MODEL is not set, so the providers.modelRouter group is undeclared",
    );
  } else {
    const router = createModelRouterProvidersAdapter({});
    if (router.ok) adapters["model-router-providers"] = router.value;
    else faults.push(`model-router-providers could not be constructed: ${router.error.code}`);
  }

  for (const adapter of UNIMPLEMENTED_ADAPTERS) {
    decline(
      adapter,
      "implementation",
      `packages/adapters/${adapter}/src/adapter.ts is a generated interface and exports no constructor`,
    );
  }

  return Object.freeze({
    adapters: Object.freeze({ ...adapters }),
    unwired: Object.freeze([...unwired]),
    faults: Object.freeze([...faults]),
    async release(): Promise<void> {
      // REVERSE ORDER, AND EVERY ONE IS CALLED. A close that throws must not
      // strand the sockets behind it: a leaked PostgreSQL pool outlives the
      // process's usefulness, and the orchestrator's SIGKILL is a worse way to
      // discover it. The rejection is swallowed here and nowhere else, because
      // by this point there is no caller left to hand it to.
      for (const close of [...closers].reverse()) {
        try {
          await close();
        } catch {
          // Intentionally ignored; see above.
        }
      }
    },
  });
}

/** A thrown value rendered for a log line, carrying no configuration value. */
function describeConstructionFault(error: unknown): string {
  if (error instanceof Error) {
    const code = (error as { readonly code?: unknown }).code;
    return typeof code === "string" ? `${error.name} ${code}` : error.name;
  }
  return "unknown";
}
