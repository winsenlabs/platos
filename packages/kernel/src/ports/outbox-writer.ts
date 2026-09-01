// ADR M0.3 §4 kernel port: OutboxWriter.
//
// ADR M0.3 §1: the Event table is written ONLY by the kernel outbox adapter, an
// infrastructure adapter at the composition root rather than a context. Any
// context may `append()` through this port, which satisfies single-writer while
// keeping the producer's code free of the table.
//
// §7 decision 8: one physical outbox, multiple drains — `observability`
// projects it to the column store, `eventing` routes notifications. Splitting
// the drain later needs no change here.

import type { JsonValue } from "../vo/domain-event.js";
import type { DomainEventDraft } from "../vo/domain-event.js";
import type { EventId } from "../vo/identifier.js";
import type { TransactionScope } from "./unit-of-work.js";

export interface OutboxWriter {
  /**
   * Append an event in the SAME transaction that wrote the state it describes.
   * Passing the transaction is what makes emission atomic with the business
   * write: there is no window in which the row exists and the event does not.
   */
  append<Payload extends JsonValue>(
    event: DomainEventDraft<Payload>,
    transaction: TransactionScope,
  ): Promise<EventId>;
}
