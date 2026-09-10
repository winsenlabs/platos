// The published surface of `@platos/adapter-redis-streams`.
//
// Only `apps/core-api` may import it (`adapters-only-from-core`), and it imports
// no other adapter (`adapter-is-self-contained`). What it publishes is what the
// composition root needs to bind TWO kernel ports and to close one connection —
// and the connection seam, so a suite can drive both stores against a container
// without this package deciding how a test reaches one.

export type { RedisStreamsAdapter, RedisStreamsAdapterOptions } from "./adapter.js";
export { buildRedisStreamsAdapter, createRedisStreamsAdapter } from "./adapter.js";
export type {
  AppendReport,
  RedisStreamConnection,
  RedisStreamConnectionOptions,
  StreamEntry,
} from "./client.js";
export { createRedisStreamConnection, ENTRY_FIELD, entryId, sequenceOf } from "./client.js";
export type { BusDeliveryFault, RedisEventBus, RedisEventBusOptions } from "./event-bus.js";
export {
  busKey,
  createRedisEventBus,
  decodeEvent,
  DEFAULT_BUS_OPTIONS,
  encodeEvent,
} from "./event-bus.js";
export type { RedisStreamJournal, RedisStreamJournalOptions } from "./journal.js";
export {
  createRedisStreamJournal,
  DEFAULT_JOURNAL_OPTIONS,
  STREAM_KEY_PREFIX,
  streamKey,
  streamMetaKey,
} from "./journal.js";
