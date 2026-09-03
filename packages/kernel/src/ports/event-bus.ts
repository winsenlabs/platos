// ADR M0.3 §4 kernel port: EventBus.
//
// The transient fan-out seam, distinct from the durable outbox. The outbox is
// the record; the bus is the delivery. ADR M0.3 §3 uses it for the reverse-edge
// inversions — a channel adapter subscribes to an outbound-message event rather
// than importing `conversations`.
//
// The charter's data rule applies: this is transient coordination and never
// unacknowledged canonical truth. Anything that must survive a crash is appended
// through `OutboxWriter` first and published from the drain.

import type { DomainEvent, JsonValue } from "../vo/domain-event.js";

/** Idempotent. Calling it twice is not an error. */
export type Unsubscribe = () => void;

export interface EventBus {
  publish<Payload extends JsonValue>(event: DomainEvent<Payload>): Promise<void>;
  /**
   * Subscribe to one event name. The handler must be idempotent: delivery is
   * at-least-once, so a redelivery after a partial failure is normal operation.
   */
  subscribe(eventName: string, handler: (event: DomainEvent) => Promise<void>): Unsubscribe;
}
