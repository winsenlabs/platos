// TWO kernel ports over ONE Redis client.
//
// ADR M0.3 §15 amendment: one vendor client is one adapter DIRECTORY, and a
// directory may satisfy more than one port when the ports sit behind the same
// client. `postgres-tenancy` applies that rule seventeen times and `redis-cache`
// four; this is the third directory it applies to, and the argument is the one
// §15 states — `EventBus` and `StreamJournal` are the same connection, the same
// server and the same primitive, so a sixteenth directory would have been a
// second Redis client for one Redis.
//
// THE PORTS ARE PROPERTIES, NOT A SPREAD, and here that is load-bearing rather
// than stylistic: both ports have an append and a read, and a flat spread would
// have silently given one port's verb to the other. `bus.publish` lets the server
// number and `journal.append` refuses a number that does not increase — the exact
// pair of behaviours that must never be reachable through one name.
//
// THE DIRECTORY'S DECLARED BINDING WAS `EventBus` ALONE UNTIL WIN-272, and adding
// `StreamJournal` beside it is what took this directory off
// `UNIMPLEMENTED_ADAPTERS`: rule (C7) reads that list back and joins it to the
// filesystem in both directions, so a directory that gained a `create*Adapter`
// and stayed on the list fails, and one dropped from it without gaining a factory
// fails too.

import type { EventBus, StreamJournal } from "@platos/kernel";

import type { RedisStreamConnection, RedisStreamConnectionOptions } from "./client.js";
import { createRedisStreamConnection } from "./client.js";
import type { RedisEventBus, RedisEventBusOptions } from "./event-bus.js";
import { createRedisEventBus, DEFAULT_BUS_OPTIONS } from "./event-bus.js";
import type { RedisStreamJournal, RedisStreamJournalOptions } from "./journal.js";
import { createRedisStreamJournal, DEFAULT_JOURNAL_OPTIONS } from "./journal.js";

/**
 * The adapter.
 *
 * IT EXTENDS `EventBus` AND CARRIES `journal` AS A PROPERTY, which looks
 * asymmetric and is not an accident: `ADAPTER_BINDINGS` already declares
 * `redis-streams:EventBus` against the whole adapter type, and `PORT_SATISFACTION`
 * proves that binding by asking whether `RedisStreamsAdapter` extends `EventBus`.
 * Narrowing it to a property would have moved an EXISTING binding row, which is a
 * change to a declared contract rather than an addition to it. The new port is the
 * one that arrives as a named slot.
 */
export interface RedisStreamsAdapter extends EventBus {
  readonly adapterName: "redis-streams";
  /** The kernel `StreamJournal` port — the resumable half. */
  readonly journal: StreamJournal;
  /** Stop every live subscription. */
  stop(): void;
  /** Release the connection. The composition root owns this adapter's lifetime. */
  close(): Promise<void>;
}

export interface RedisStreamsAdapterOptions extends RedisStreamConnectionOptions {
  readonly bus?: RedisEventBusOptions;
  readonly journal?: RedisStreamJournalOptions;
}

/**
 * Build the adapter over an ALREADY-OPEN connection.
 *
 * Separate from `createRedisStreamsAdapter` for the reason
 * `buildRedisCacheAdapter` is separate from its opener: a suite supplies a
 * connection it built against a container and still exercises the real store.
 */
export function buildRedisStreamsAdapter(
  connection: RedisStreamConnection,
  options: { readonly bus?: RedisEventBusOptions; readonly journal?: RedisStreamJournalOptions } = {},
): RedisStreamsAdapter {
  const bus: RedisEventBus = createRedisEventBus(connection, options.bus ?? DEFAULT_BUS_OPTIONS);
  const journal: RedisStreamJournal = createRedisStreamJournal(
    connection,
    options.journal ?? DEFAULT_JOURNAL_OPTIONS,
  );
  return {
    adapterName: "redis-streams",
    publish: bus.publish.bind(bus),
    subscribe: bus.subscribe.bind(bus),
    journal,
    stop: () => bus.stop(),
    close: async () => {
      // SUBSCRIPTIONS FIRST, THEN THE SOCKET. A poll loop still running when the
      // connection closes issues a command against a disconnected client and
      // reports a fault nobody can act on, on the way out of a process that has
      // already decided to stop.
      bus.stop();
      await connection.close();
    },
  };
}

/** Open the connection and build the adapter over it. */
export function createRedisStreamsAdapter(options: RedisStreamsAdapterOptions): RedisStreamsAdapter {
  const { bus, journal, ...connection } = options;
  return buildRedisStreamsAdapter(createRedisStreamConnection(connection), { bus, journal });
}
