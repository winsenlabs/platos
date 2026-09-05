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
import type { TenancyRepository } from "@platos/context-tenancy/application/ports/index.js";
import type { ObjectStore } from "@platos/context-files/application/ports/index.js";
import type { ObservabilitySink } from "@platos/context-observability/application/ports/index.js";
import type { Cache } from "@platos/context-memory/application/ports/index.js";
import type { ModelRouter } from "@platos/context-providers/application/ports/index.js";
import type { ChannelAdapter } from "@platos/context-channels/application/ports/index.js";
import type { Notifier } from "@platos/context-cost-monitoring/application/ports/index.js";

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
 * TWELVE SLOTS, THIRTEEN BINDINGS (ADR M0.3 §15). An install wires a
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
 * and adding a row for it would claim a fourteenth binding the ADR does not
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
 * De-duplicated because `ADAPTER_BINDINGS` now holds thirteen rows across
 * twelve directories: a caller iterating this list to construct or close
 * adapters would otherwise build `postgres-tenancy` twice and open two pools
 * over the one database.
 */
export const ADAPTER_NAMES: readonly AdapterName[] = Object.freeze([
  ...new Set(ADAPTER_BINDINGS.map((binding) => binding.adapter)),
]);
