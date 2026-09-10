// The real-Redis harness the integration suites in this directory share.
//
// It FAILS when Docker is absent rather than skipping. A skipped integration
// suite and a passing one look identical in a CI summary, and every claim this
// directory makes — that a resume cursor survives a reconnect, that a trimmed
// position is REFUSED rather than answered, that two processes see one ordering —
// is a claim about a real server or it is nothing.
//
// SEVERAL CONNECTIONS, AND THAT IS THE POINT. "Multi-instance" is not "two
// objects in one process sharing a socket": it is two clients whose commands the
// SERVER interleaves. Every case that says anything about ordering or fan-out
// drives its parties through connections opened separately.

import { RedisContainer, type StartedRedisContainer } from "@testcontainers/redis";

import type { RedisStreamConnection } from "./client.js";
import { createRedisStreamConnection } from "./client.js";
import { STREAM_KEY_PREFIX } from "./journal.js";
import { BUS_KEY_PREFIX } from "./event-bus.js";

export interface RedisStreamsHarness {
  readonly url: string;
  /** A connection this harness will close for you. Call it per party. */
  connect(): RedisStreamConnection;
  /** Remove every key this directory owns, so cases cannot inherit each other's. */
  reset(): Promise<void>;
  stop(): Promise<void>;
}

/**
 * Keys this harness has been asked to forget.
 *
 * A REGISTER RATHER THAN A SCAN, because `SCAN` is deliberately not on
 * `RedisStreamConnection` and `KEYS` never will be — a harness that reached past
 * the interface for either would be the first step towards a store doing the same.
 * The register is fed by the cases, which know the stream ids they used.
 */
export function harnessKeys(streamIds: readonly string[], eventNames: readonly string[]): string[] {
  const keys: string[] = [];
  for (const streamId of streamIds) {
    keys.push(`${STREAM_KEY_PREFIX}:${streamId}`, `${STREAM_KEY_PREFIX}:${streamId}:meta`);
  }
  for (const eventName of eventNames) keys.push(`${BUS_KEY_PREFIX}:${eventName}`);
  return keys;
}

export async function startRedisStreamsHarness(): Promise<RedisStreamsHarness> {
  const container: StartedRedisContainer = await new RedisContainer("redis:7-alpine").start();
  const url = container.getConnectionUrl();
  const opened: RedisStreamConnection[] = [];
  const sweeper = createRedisStreamConnection({ url });
  opened.push(sweeper);
  const seen = new Set<string>();

  return {
    url,
    connect(): RedisStreamConnection {
      const connection = createRedisStreamConnection({ url });
      opened.push(connection);
      // Wrapped so every key any case touches is remembered for `reset`, without
      // asking the cases to keep a list they would forget to add to.
      return new Proxy(connection, {
        get(target, property, receiver) {
          const value = Reflect.get(target, property, receiver) as unknown;
          if (typeof value !== "function") return value;
          return (...args: unknown[]) => {
            if (typeof args[0] === "string" && args[0].startsWith("platos:")) seen.add(args[0]);
            return (value as (...rest: unknown[]) => unknown).apply(target, args);
          };
        },
      });
    },
    async reset(): Promise<void> {
      const keys = [...seen];
      seen.clear();
      await sweeper.remove(keys);
    },
    async stop(): Promise<void> {
      await Promise.all(opened.map((connection) => connection.close()));
      await container.stop();
    },
  };
}
