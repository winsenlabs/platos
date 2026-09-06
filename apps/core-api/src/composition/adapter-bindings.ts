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
import type { ObjectStore } from "@platos/context-files/application/ports/index.js";
import type { ObservabilitySink } from "@platos/context-observability/application/ports/index.js";
import type { Cache } from "@platos/context-memory/application/ports/index.js";
import type { ModelRouter } from "@platos/context-providers/application/ports/index.js";
import type {
  ChannelAdapter,
  ChannelsRepository,
} from "@platos/context-channels/application/ports/index.js";
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
 * TWELVE SLOTS, THIRTY-ONE BINDINGS (ADR M0.3 §15). An install wires a
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
  readonly "postgres-tenancy:SecretsRepository": Satisfies<
    PostgresTenancyAdapter["secrets"],
    SecretsRepository
  >;
  readonly "postgres-tenancy:EnvironmentVariableRepository": Satisfies<
    PostgresTenancyAdapter["secretsVariables"],
    EnvironmentVariableRepository
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
  "postgres-tenancy:SecretsRepository": true,
  "postgres-tenancy:EnvironmentVariableRepository": true,
  "postgres-tenancy:SkillsRepository": true,
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
  // the NINTH owner of the one PostgreSQL client. ONE row and not three, because
  // `skills` publishes ONE canonical-store port over its three tables: a
  // catalogue entry, the project adoption of one and the environment binding of
  // that adoption are one aggregate with one uniqueness key, and the port's own
  // header says there is deliberately no generic `save(row)` through which
  // another context could reach any of them from the side.
  Object.freeze({ adapter: "postgres-tenancy", port: "SkillsRepository", owner: "skills" }),
  // WIN-258 M2.3 — TENANCY'S FIVE NON-REPOSITORY PORTS, the SIXTEENTH through
  // TWENTIETH bindings of the same directory.
  //
  // They are a different KIND of binding from the seven above and that is why
  // they sit together at the end rather than beside `TenancyRepository`: each of
  // the seven above is a whole repository composite SPREAD INTO the adapter, and
  // each of these five is a single named PROPERTY on it. The ordinals above stay
  // true because nothing was inserted before them.
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
  Object.freeze({ adapter: "outbox", port: "OutboxWriter", owner: "kernel" }),
  Object.freeze({ adapter: "durable-runtime", port: "DurableRuntime", owner: "kernel" }),
  Object.freeze({ adapter: "clickhouse-observability", port: "ObservabilitySink", owner: "observability" }),
  Object.freeze({ adapter: "objectstore-minio", port: "ObjectStore", owner: "files" }),
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
 * De-duplicated because `ADAPTER_BINDINGS` now holds thirty-one rows across
 * twelve directories: a caller iterating this list to construct or close
 * adapters would otherwise build `postgres-tenancy` TWENTY times and open
 * twenty pools over the one database.
 */
export const ADAPTER_NAMES: readonly AdapterName[] = Object.freeze([
  ...new Set(ADAPTER_BINDINGS.map((binding) => binding.adapter)),
]);
