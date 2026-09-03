// The domain-event envelope.
//
// ADR M0.3 §3: producers append events through the kernel `OutboxWriter` inside
// their own unit of work, and the single kernel outbox adapter is the only
// physical writer of the Event table. `observability` and `eventing` are
// drain-side consumers. The envelope is therefore self-describing: a drain must
// be able to route and version an event without importing the context that
// produced it.
//
// M0.4 §1.1: the version is a property of the contract. Every envelope carries
// its own schema version so a drain can decode an event minted by an older
// binary, and readers ignore unknown fields and unknown event names.

import type { EventId, RequestId } from "./identifier.js";
import type { TenantScope } from "./scope.js";

/** JSON that survives a round-trip through the canonical store. */
export type JsonValue = string | number | boolean | null | JsonValue[] | { readonly [key: string]: JsonValue };

export interface DomainEvent<Payload extends JsonValue = JsonValue> {
  readonly eventId: EventId;
  /**
   * Dotted, stable, lower-case name — `identity.session.started`. The first
   * segment is the owning context. Renaming one is a breaking change (M0.4 §1.3).
   */
  readonly name: string;
  /** Envelope schema version for this event name. Additive changes do not bump it. */
  readonly schemaVersion: number;
  readonly occurredAt: Date;
  readonly scope: TenantScope;
  /** Correlates the event to the request that produced it. */
  readonly requestId: RequestId | null;
  readonly payload: Payload;
}

/** What a producer supplies; the outbox adapter stamps the rest. */
export type DomainEventDraft<Payload extends JsonValue = JsonValue> = Omit<
  DomainEvent<Payload>,
  "eventId" | "occurredAt"
>;
