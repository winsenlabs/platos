// The connections the suites in this directory drive the limiter through.
//
// THREE OF THEM, AND EACH ONE EXISTS TO MAKE A DIFFERENT CLAIM FALSIFIABLE:
//
//   `countingConnection`  a Map behind the SAME single verb the real connection
//                         publishes. It proves the wiring — that the count the
//                         server returns is the count the bucket carries, and
//                         that the key changes exactly when the window does. It
//                         proves NOTHING about atomicity: a Map in one process
//                         cannot exhibit the race, which is why the integration
//                         suite exists and why this one does not pretend to.
//
//   `deadConnection`      every command rejects, which is what a caller sees
//                         when Redis is gone. It is the only way to reach the
//                         refusal path without stopping a container mid-suite.
//
//   `startRedisHarness`   a real server in a container. It FAILS when Docker is
//                         absent rather than skipping: a skipped integration
//                         suite and a passing one look identical in a CI
//                         summary, and "two processes cannot both take the last
//                         token" is a claim about a real server or it is nothing.
//
// TWO CONNECTIONS PER CONTENDER, AND THAT IS THE POINT. The atomicity property
// is not "one call in this process wins": it is "one call wins when several
// callers ask at once", and a single connection with a single command queue
// cannot exhibit the difference. `connect()` hands out a fresh one per contender
// so the ordering is the server's rather than one client's.

import { RedisContainer, type StartedRedisContainer } from "@testcontainers/redis";

import type { RateLimitConnection } from "./client.js";
import { createRateLimitConnection } from "./client.js";

export interface CountingConnection extends RateLimitConnection {
  /** Every key this connection has been asked about, and its counter. */
  readonly counters: Map<string, number>;
  /** Every `(key, ttlMs)` pair, in order, so a TTL claim is checkable. */
  readonly calls: { key: string; ttlMs: number }[];
}

/**
 * `INCR`, and the expiry decision, over a Map.
 *
 * It models the SERVER's contract rather than the client's: the counter starts
 * at 1 on a key it has not seen, and the TTL is recorded on the first request of
 * a key and never afterwards — which is what the Lua script does and is the only
 * observable difference between "sets a lifetime" and "extends one".
 */
export function countingConnection(): CountingConnection {
  const counters = new Map<string, number>();
  const ttls = new Map<string, number>();
  const calls: { key: string; ttlMs: number }[] = [];
  return {
    counters,
    calls,
    async foldIntoWindow(key: string, ttlMs: number): Promise<number> {
      calls.push({ key, ttlMs });
      const next = (counters.get(key) ?? 0) + 1;
      counters.set(key, next);
      if (next === 1) ttls.set(key, ttlMs);
      return next;
    },
    async close(): Promise<void> {},
  };
}

/** The connection a process holds while its Redis is unreachable. */
export function deadConnection(message = "connect ECONNREFUSED 127.0.0.1:6379"): RateLimitConnection {
  return {
    async foldIntoWindow(): Promise<number> {
      throw new Error(message);
    },
    async close(): Promise<void> {},
  };
}

export interface RedisHarness {
  readonly url: string;
  /** A connection this harness will close for you. Call it per contender. */
  connect(): RateLimitConnection;
  /** How many keys the limiter's namespace holds, and each one's TTL. */
  inspect(): Promise<{ keys: string[]; ttlMs: Map<string, number> }>;
  /** Drop the limiter's namespace, so cases cannot inherit each other's counters. */
  reset(): Promise<void>;
  stop(): Promise<void>;
}

/** The prefix every key this directory writes begins with (ADR M0.3 §4). */
const NAMESPACE = "platos:identity:ratelimit:";

export async function startRedisHarness(): Promise<RedisHarness> {
  const container: StartedRedisContainer = await new RedisContainer("redis:7-alpine").start();
  const url = container.getConnectionUrl();
  const opened: RateLimitConnection[] = [];

  // THE INSPECTOR IS A SEPARATE CLIENT AND IT IS NOT `RateLimitConnection`.
  // `client.ts` publishes ONE verb on purpose — a suite that could `GET` and
  // `SET` through the adapter's own seam would be one edit away from proving
  // atomicity against a read-modify-write. So the observation half of these
  // suites reaches the server through the container's own client instead, and
  // the adapter's interface stays as narrow in the tests as it is in production.
  const observe = async (command: string, ...args: string[]): Promise<string> => {
    const reply: unknown = await container.executeCliCmd(command, args);
    // `@testcontainers/redis` has returned both a bare string and an
    // `{ output }` record across its 10.x line. Reading both shapes here keeps
    // the suites' evidence independent of which one is installed, and a THIRD
    // shape fails loudly rather than silently observing "".
    if (typeof reply === "string") return reply.trim();
    if (reply !== null && typeof reply === "object" && "output" in reply) {
      return String((reply as { output: unknown }).output).trim();
    }
    throw new TypeError("the redis container CLI returned an unrecognised reply shape");
  };

  const inspect = async (): Promise<{ keys: string[]; ttlMs: Map<string, number> }> => {
    const listed = await observe("keys", `${NAMESPACE}*`);
    const keys = listed.length === 0 ? [] : listed.split("\n").map((line) => line.trim()).filter(Boolean);
    const ttlMs = new Map<string, number>();
    for (const key of keys) ttlMs.set(key, Number(await observe("pttl", key)));
    return { keys, ttlMs };
  };

  return {
    url,
    connect(): RateLimitConnection {
      const connection = createRateLimitConnection({ url });
      opened.push(connection);
      return connection;
    },
    inspect,
    async reset(): Promise<void> {
      const { keys } = await inspect();
      for (const key of keys) await observe("del", key);
    },
    async stop(): Promise<void> {
      for (const connection of opened) await connection.close();
      await container.stop();
    },
  };
}
