// The real-Redis harness the integration suites share.
//
// It FAILS when Docker is absent rather than skipping. A skipped integration
// suite and a passing one look identical in a CI summary, and the whole claim
// this directory makes — that two identical requests racing produce ONE
// execution — is a claim about a real server or it is nothing.
//
// TWO CONNECTIONS, AND THAT IS THE POINT. The reserve-once property is not "one
// call in this process wins": it is "one call wins when several processes ask at
// once", and a single connection with a single command queue cannot exhibit the
// difference. Every racing case below drives its contenders through connections
// opened separately, so the ordering is the server's rather than one client's.

import { RedisContainer, type StartedRedisContainer } from "@testcontainers/redis";

import type { RedisConnection } from "./client.js";
import { createRedisConnection } from "./client.js";

export interface RedisHarness {
  readonly url: string;
  /** A connection this harness will close for you. Call it per contender. */
  connect(): RedisConnection;
  /** Remove every key, so cases cannot inherit each other's reservations. */
  reset(): Promise<void>;
  stop(): Promise<void>;
}

export async function startRedisHarness(): Promise<RedisHarness> {
  const container: StartedRedisContainer = await new RedisContainer("redis:7-alpine").start();
  const url = container.getConnectionUrl();
  const opened: RedisConnection[] = [];
  const sweeper = createRedisConnection({ url });
  opened.push(sweeper);

  return {
    url,
    connect(): RedisConnection {
      const connection = createRedisConnection({ url });
      opened.push(connection);
      return connection;
    },
    async reset(): Promise<void> {
      // Through `scanPrefix` and `remove` rather than `FLUSHDB`, because
      // `FLUSHDB` is deliberately not on `RedisConnection` — a harness that
      // reached past the interface to call it would be the first step towards a
      // store doing the same.
      let cursor = "0";
      do {
        const [next, keys] = await sweeper.scanPrefix(cursor, "*", 512);
        cursor = next;
        await sweeper.remove(keys);
      } while (cursor !== "0");
    },
    async stop(): Promise<void> {
      await Promise.all(opened.map((connection) => connection.close()));
      await container.stop();
    },
  };
}
