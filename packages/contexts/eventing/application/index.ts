// The `eventing` application layer.
//
// Use cases, one per file, each a plain function over a frozen dependency
// bundle. There is no service class and no framework: a use case is invokable in
// memory against the in-memory doubles in `application/testing/`, and every one
// of them returns the kernel's `Result` rather than throwing.
//
// This is the shape the legacy `McpEventsService` did not have. That class held
// the matcher, the CRUD, the Redis queue, the BRPOP loop, the retry timer and
// the outbound HTTP calls behind one `@Injectable()`, which is why none of its
// rules could be tested without a Redis and a Postgres. Each of those concerns
// is now either a pure function in `domain/`, a use case here, or a port.
//
// May import this context's `domain/`, its own `application/ports/`, its own
// `contracts/`, and the published `contracts/` of the one peer ADR M0.3 §1
// grants it (`tenancy`). Never an adapter, never a framework, never a vendor SDK.
export * from "./ports/index.js";
export * from "./dependencies.js";
export * from "./views.js";
export * from "./screen-destination.js";
export * from "./register-notification-rule.js";
export * from "./update-notification-rule.js";
export * from "./read-notification-rules.js";
export * from "./route-observed-event.js";
export * from "./test-notification-rule.js";
export * from "./record-delivery-failure.js";
export * from "./eventing-erasure-target.js";
export * from "./eventing-contract.js";

import type { TenancyContract } from "@platos/context-tenancy";

import type { EventingContract } from "../contracts/index.js";
import type { EventingDependencies } from "./dependencies.js";
import type { NotificationRuleRepository } from "./ports/index.js";

/**
 * The wiring shape `apps/core-api` builds at the composition root: the driven
 * ports going in, the driving contract coming out.
 *
 * Retained under its generated name so no sibling placeholder breaks.
 */
export interface EventingUseCases {
  readonly repository: NotificationRuleRepository;
  readonly dependencies: EventingDependencies;
  readonly contract: EventingContract;
  /**
   * The one cross-context edge ADR M0.3 §1 grants eventing
   * (`eventing -> tenancy`), held as the published contract type and NOTHING
   * else — this file and `dependencies.ts` are the only places in the context
   * that name it.
   *
   * It is deliberately opaque. The resolved `EnvironmentScope` arrives on every
   * command, having been established by the context that owns the tree, so no
   * rule here depends on tenancy's runtime behaviour and every rule stays
   * exercisable in memory.
   */
  readonly tenancy: TenancyContract;
}
