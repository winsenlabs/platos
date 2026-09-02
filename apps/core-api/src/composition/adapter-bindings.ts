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

import type { RateLimiter } from "@platos/context-identity-access/application/ports/index.js";
import type { TenancyRepository } from "@platos/context-tenancy/application/ports/index.js";
import type { ObjectStore } from "@platos/context-files/application/ports/index.js";
import type { ObservabilitySink } from "@platos/context-observability/application/ports/index.js";
import type { Cache } from "@platos/context-memory/application/ports/index.js";
import type { ModelRouter } from "@platos/context-providers/application/ports/index.js";
import type { ChannelAdapter } from "@platos/context-channels/application/ports/index.js";
import type { Notifier } from "@platos/context-cost-monitoring/application/ports/index.js";

import type { PostgresTenancyAdapter } from "@platos/adapter-postgres-tenancy";
import type { OutboxAdapter } from "@platos/adapter-outbox";
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
 */
type Satisfies<Adapter, Port> = Adapter extends Port ? true : never;

interface PortSatisfaction {
  readonly "postgres-tenancy": Satisfies<PostgresTenancyAdapter, TenancyRepository>;
  readonly outbox: Satisfies<OutboxAdapter, OutboxWriter>;
  readonly "durable-runtime": Satisfies<DurableRuntimeAdapter, DurableRuntime>;
  readonly "clickhouse-observability": Satisfies<ClickhouseObservabilityAdapter, ObservabilitySink>;
  readonly "objectstore-minio": Satisfies<ObjectstoreMinioAdapter, ObjectStore>;
  readonly "redis-ratelimit": Satisfies<RedisRatelimitAdapter, RateLimiter>;
  readonly "redis-cache": Satisfies<RedisCacheAdapter, Cache>;
  readonly "redis-streams": Satisfies<RedisStreamsAdapter, EventBus>;
  readonly "model-router-providers": Satisfies<ModelRouterProvidersAdapter, ModelRouter>;
  readonly "channel-slack": Satisfies<ChannelSlackAdapter, ChannelAdapter>;
  readonly "notifier-email": Satisfies<NotifierEmailAdapter, Notifier>;
  readonly "notifier-webhook": Satisfies<NotifierWebhookAdapter, Notifier>;
}

export const PORT_SATISFACTION: PortSatisfaction = Object.freeze({
  "postgres-tenancy": true,
  outbox: true,
  "durable-runtime": true,
  "clickhouse-observability": true,
  "objectstore-minio": true,
  "redis-ratelimit": true,
  "redis-cache": true,
  "redis-streams": true,
  "model-router-providers": true,
  "channel-slack": true,
  "notifier-email": true,
  "notifier-webhook": true,
});

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

export const ADAPTER_NAMES: readonly AdapterName[] = Object.freeze(
  ADAPTER_BINDINGS.map((binding) => binding.adapter),
);
