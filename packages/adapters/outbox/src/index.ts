// The published surface of the kernel outbox adapter.
//
// `OutboxEventStore` is exported alongside the adapter because the composition
// root is the one place entitled to name both this package and the canonical
// PostgreSQL store, and it needs the type to prove — at compile time, in
// `apps/core-api/src/composition/adapter-bindings.ts` — that the store it is
// about to wire in actually satisfies this seam.

export type { OutboxAdapter, OutboxAdapterOptions, OutboxDrainPage } from "./adapter.js";
export { buildOutboxAdapter, DRAIN_LIMIT_INVALID, OutboxDrainError } from "./adapter.js";

export type {
  OutboxCursor,
  OutboxEventStore,
  OutboxInsert,
  OutboxStoredRow,
} from "./store.js";

export type { DrainedEvent } from "./envelope.js";
export {
  decodeEnvelope,
  encodeEnvelope,
  environmentOf,
  ENVELOPE_FIELD_UNREADABLE,
  ENVELOPE_MARKER,
  ENVELOPE_VERSION,
  ENVELOPE_VERSION_UNKNOWN,
  EVENT_NAME_PATTERN,
  NAME_INVALID,
  OutboxEnvelopeError,
  PAYLOAD_NOT_SERIALISABLE,
  ROW_PAYLOAD_NOT_OBJECT,
  SCHEMA_VERSION_INVALID,
  SCOPE_NOT_ENVIRONMENT,
  toStorableJson,
} from "./envelope.js";

export type { EventIdMinter, MintedEventId, RandomBytes } from "./event-id.js";
export { COUNTER_LIMIT, createEventIdMinter } from "./event-id.js";

// The shutdown flush (WIN-260 M2.5). `OutboxFlush` is exported because the
// composition root is the one place entitled to name both this package and
// `apps/core-api`'s `Drainable`, and it needs the type to prove — at compile
// time, in `apps/core-api/src/composition/adapter-bindings.ts` — that this
// package's flush is the shape the shutdown sequence drains.
export type {
  OutboxFlush,
  OutboxFlushHandler,
  OutboxFlushOptions,
  OutboxFlushOutcome,
  OutboxFlushSource,
} from "./flush.js";
export {
  createOutboxFlush,
  DEFAULT_MAX_PAGES,
  FLUSH_BUDGET_SPENT,
  FLUSH_PAGE_INVALID,
  FLUSH_SOURCE_FAULTED,
  OutboxFlushError,
} from "./flush.js";

export type { InMemoryOutbox } from "./in-memory.js";
export {
  createInMemoryOutbox,
  EVENT_ID_TAKEN,
  InMemoryOutboxError,
  TRANSACTION_NOT_OPEN,
  TRANSACTION_SCOPE_FOREIGN,
  TRANSACTION_SCOPE_UNKNOWN,
} from "./in-memory.js";

export type {
  ConformanceObservation,
  ConformanceScenario,
  EnvironmentMap,
  ScenarioRow,
  ScenarioStep,
} from "./conformance.js";
export { runOutboxConformance } from "./conformance.js";
