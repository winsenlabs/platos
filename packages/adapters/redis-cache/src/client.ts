// THE one file in this directory that names the Redis client.
//
// ADR M0.3 §5.1(h) is SDK containment and §4 gives an adapter directory one
// vendor client: a second `ioredis` import anywhere here would make "the sole
// holder of its vendor client" a claim nobody could check by reading. The rest
// of the package is written against `RedisConnection` below.
//
// THE INTERFACE IS NAMED BY INTENT, NOT BY COMMAND, and that is the whole reason
// it exists rather than the vendor type being passed around. `SET key value EX
// ttl NX` and `SET key value EX ttl` differ by two characters and by everything
// that matters: the first claims a key or reports that it could not, and the
// second overwrites whatever is there. An idempotency store that lost its `NX`
// would still compile, still pass a single-threaded test, and duplicate every
// side effect under contention. Here the two are `claim` and `write`, they
// cannot be confused for one another, and the mapping to commands happens once.
//
// It is also what keeps `KEYS` and `FLUSHDB` out of reach. `KEYS` blocks the
// single-threaded server for the length of the whole keyspace and `FLUSHDB`
// would destroy every other owner's namespace — neither is on this interface, so
// no file in this directory can reach one.

// The NAMED export, not the default. `ioredis` publishes both and they are the
// same class, but the V1 solution compiles under NodeNext module resolution
// where the CommonJS default is the module namespace object and is not
// constructable. `apps/agent` uses the default form and builds, because it
// compiles under a different module setting — a difference worth a line here,
// since the two files otherwise look interchangeable.
import { Redis } from "ioredis";

/** How the adapter reaches its server. One place, so the pool is one decision. */
export interface RedisConnectionOptions {
  /** `redis://host:port/db`, or a full URL with credentials. */
  readonly url: string;
  /**
   * Milliseconds a command may wait before it is abandoned.
   *
   * There is no unbounded wait. `execute-job.ts` reserves BEFORE it runs a
   * handler, so a reservation that hangs holds the request that asked for it and
   * an unbounded wait here is an unbounded wait for every job in the environment.
   */
  readonly commandTimeoutMs?: number;
}

/** What this directory does to Redis, expressed as what it means. */
export interface RedisConnection {
  read(key: string): Promise<string | null>;
  /** `SET key value EX ttl NX` — claim it, or report that somebody else has. */
  claim(key: string, value: string, ttlSeconds: number): Promise<boolean>;
  /** `SET key value EX ttl XX` — overwrite an EXISTING key, never create one. */
  overwrite(key: string, value: string, ttlSeconds: number): Promise<boolean>;
  /** `SET key value EX ttl` — write it whether or not it was there. */
  write(key: string, value: string, ttlSeconds: number): Promise<void>;
  /** How many of `keys` were removed. */
  remove(keys: readonly string[]): Promise<number>;
  /** One `SCAN` round: the next cursor, and the keys this round matched. */
  scanPrefix(cursor: string, pattern: string, count: number): Promise<[string, readonly string[]]>;
  close(): Promise<void>;
}

/** Open the one connection this directory holds. */
export function createRedisConnection(options: RedisConnectionOptions): RedisConnection {
  const client = new Redis(options.url, {
    commandTimeout: options.commandTimeoutMs ?? 2_000,
    // FAIL RATHER THAN QUEUE. With the default, a command issued while the
    // connection is down is buffered and resolves whenever the server returns —
    // so a caller waiting on a reservation waits past its own timeout, and the
    // fail-closed refusal `jobs` depends on is never reached. An error is the
    // answer the domain is written to handle.
    enableOfflineQueue: false,
    maxRetriesPerRequest: 1,
  });

  // A PERMANENT ERROR LISTENER, OR THE PROCESS DIES. An `error` event with no
  // listener is rethrown by the emitter, so a Redis that went away would take
  // down a process whose whole design is to report that as a value. This is the
  // one place a connection failure is swallowed, and it is swallowed only as an
  // EVENT: every command still rejects, and every caller turns that rejection
  // into `IDEMPOTENCY_UNAVAILABLE` or `MEMORY_CACHE_UNAVAILABLE`.
  client.on("error", () => undefined);

  /**
   * Resolved once the handshake has finished.
   *
   * `enableOfflineQueue: false` is what makes a command fail rather than wait
   * when the server is gone, and it is also why this is needed: a command issued
   * in the window between construction and the handshake has no queue to sit in
   * and fails with "Stream isn't writeable", which is not a fact about the
   * server. Awaiting readiness ONCE closes that window without reopening the one
   * the flag exists to close — after a later disconnect this promise is already
   * settled, so the command goes straight to the socket and fails fast, which is
   * the behaviour `jobs` fails closed on.
   */
  const ready: Promise<void> =
    client.status === "ready"
      ? Promise.resolve()
      : new Promise<void>((resolve, reject) => {
          client.once("ready", () => resolve());
          // Only until `ready` settles it: a promise cannot be rejected twice,
          // so a later transient error cannot poison a live connection.
          client.once("error", (error: Error) => reject(error));
        });

  return {
    async read(key) {
      await ready;
      return await client.get(key);
    },
    async claim(key, value, ttlSeconds) {
      await ready;
      return (await client.set(key, value, "EX", ttlSeconds, "NX")) === "OK";
    },
    async overwrite(key, value, ttlSeconds) {
      await ready;
      return (await client.set(key, value, "EX", ttlSeconds, "XX")) === "OK";
    },
    async write(key, value, ttlSeconds) {
      await ready;
      await client.set(key, value, "EX", ttlSeconds);
    },
    async remove(keys) {
      if (keys.length === 0) return 0;
      await ready;
      return await client.del(...keys);
    },
    async scanPrefix(cursor, pattern, count) {
      await ready;
      const [next, keys] = await client.scan(cursor, "MATCH", pattern, "COUNT", count);
      return [next, keys];
    },
    async close() {
      await client.quit();
    },
  };
}
