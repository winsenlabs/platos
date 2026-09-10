// THE one file in this directory that names the Redis client.
//
// ADR M0.3 §5.1(h) is SDK containment and §4 gives an adapter directory one
// vendor client: a second `ioredis` import anywhere here would make "the sole
// holder of its vendor client" a claim nobody could check by reading. The rest of
// the package is written against `RedisStreamConnection` below.
//
// WHY STREAMS AND NOT PUB/SUB, WHICH IS THE DECISION THIS DIRECTORY'S NAME
// ALREADY MADE AND NOBODY HAD WRITTEN DOWN.
//
// Redis pub/sub is fire-and-forget: a message published while a subscriber is
// reconnecting is delivered to nobody and is not recoverable, because there is no
// server-side record that it existed. Every property WIN-272's acceptance asks
// for — "ordering and conservation proven under reconnect", "clients resume
// without missing or double-applying state" — is a property of frames that
// OUTLIVE the connection carrying them, and pub/sub has none.
//
// A Redis STREAM is an append-only log with server-assigned, monotonically
// ordered ids, a bounded length, and reads addressed by position. That is a
// journal, which is exactly what the kernel's `StreamJournal` describes, and the
// same primitive serves `EventBus` — the transient half — by reading only from
// the live end.
//
// THE ENTRY ID IS THE PRODUCER'S OWN SEQUENCE, AND THAT IS THE LOAD-BEARING
// TRICK. Redis lets a caller supply an id and enforces that it strictly
// increases. `StreamFrame.seq` is defined as 1-based, monotonic and gap-free
// within one stream, so `<seq>-0` is a legal id and the server itself refuses a
// producer that repeats or goes backwards. Two consequences fall out for free:
// a resume cursor and a Redis id are the SAME VALUE, so `read(after)` needs no
// lookup table and cannot drift from one; and a duplicate append is refused by
// the SERVER rather than by a check this file would otherwise have to write and
// get right under concurrency.
//
// THERE IS NO `FLUSHDB` AND NO `KEYS` ON THIS INTERFACE, for the reason
// `redis-cache/src/client.ts` gives: `KEYS` blocks the single-threaded server for
// the length of the whole keyspace, and `FLUSHDB` would destroy every other
// owner's namespace. Neither is reachable from any file in this directory.

// The NAMED export, not the default — the V1 solution compiles under NodeNext,
// where the CommonJS default is the module namespace object and is not
// constructable. `redis-cache/src/client.ts` carries the same line and the same
// reason.
import { Redis } from "ioredis";

/** How this directory reaches its server. */
export interface RedisStreamConnectionOptions {
  /** `redis://host:port/db`, or a full URL with credentials. */
  readonly url: string;
  /**
   * Milliseconds a command may wait before it is abandoned.
   *
   * There is no unbounded wait. A producer appending frames holds the turn that
   * generated them, so an append that hangs is a turn that hangs.
   */
  readonly commandTimeoutMs?: number;
}

/** One entry as the server holds it: the id it was written under, and its fields. */
export interface StreamEntry {
  /** The full Redis id, `<seq>-0`. */
  readonly id: string;
  /** The producer's sequence, parsed out of the id. */
  readonly seq: number;
  /** The single field this directory writes. See `ENTRY_FIELD`. */
  readonly body: string;
}

/** What an append did, as the server reports it. */
export interface AppendReport {
  /** The sequence of the last entry written. */
  readonly lastSeq: number;
  /** How many entries the length bound removed as a consequence of this append. */
  readonly trimmed: number;
}

/**
 * The ONE field name every entry in this directory carries.
 *
 * A stream entry is a field/value map, and using several fields would put a
 * second schema — the field names — beside the one the frame already carries.
 * One field holding one JSON document means the entry's shape is the frame's
 * shape and nothing else has to agree.
 */
export const ENTRY_FIELD = "b";

/** What this directory does to Redis, expressed as what it means. */
export interface RedisStreamConnection {
  /**
   * Append entries under caller-chosen sequences, bounding the stream's length.
   *
   * REFUSES rather than renumbers when a sequence is not above the last one: the
   * server's own `ERR The ID specified in XADD is equal or smaller` is surfaced
   * as `null`, because a producer that repeated a sequence has a defect and
   * renumbering would hide it behind a stream that silently reorders.
   */
  append(
    key: string,
    entries: readonly { readonly seq: number; readonly body: string }[],
    maxLength: number,
    ttlSeconds: number,
  ): Promise<AppendReport | null>;

  /** Entries with a sequence strictly greater than `afterSeq`, oldest first. */
  readAfter(key: string, afterSeq: number, count: number): Promise<readonly StreamEntry[]>;

  /**
   * Append one entry under a SERVER-ASSIGNED id, bounding the stream's length.
   *
   * THE SECOND APPEND VERB, AND IT IS SEPARATE BECAUSE THE TWO PORTS DIFFER ON
   * WHO NUMBERS. A journal stream has ONE producer whose `seq` is part of the
   * contract, so the caller supplies the id and the server refuses a repeat. A bus
   * stream has MANY producers in different processes, and no caller-chosen number
   * could be monotonic across them — so the server assigns. Collapsing the two
   * into one verb with an optional id would have made "the server refused your
   * sequence" unreachable on the half that depends on it.
   */
  publishAssigned(key: string, body: string, maxLength: number, ttlSeconds: number): Promise<string>;

  /** The id of the newest entry, or null when the stream is empty or absent. */
  tip(key: string): Promise<string | null>;

  /**
   * Entries strictly after a full Redis id, oldest first. `null` reads from the
   * start.
   *
   * ADDRESSED BY ID RATHER THAN BY SEQUENCE, because a bus stream's ids are the
   * server's `<ms>-<n>` and carry no producer sequence to parse.
   */
  readAfterId(
    key: string,
    afterId: string | null,
    count: number,
  ): Promise<readonly { readonly id: string; readonly body: string }[]>;

  /** The oldest entry the stream still holds, or null when it holds none. */
  oldest(key: string): Promise<StreamEntry | null>;

  /** How many entries the stream holds right now. */
  length(key: string): Promise<number>;

  /** Read one field of a metadata hash. */
  readMeta(key: string, field: string): Promise<string | null>;

  /** Every field of a metadata hash, or null when the hash does not exist. */
  readAllMeta(key: string): Promise<Readonly<Record<string, string>> | null>;

  /**
   * Write a metadata field only if it is not already set, and report whether
   * this call was the one that set it.
   *
   * `HSETNX` AND NOT `HSET`, because this is how a seal becomes idempotent. Two
   * producers sealing the same stream — a retry of finished work, or a second
   * writer — must not be able to turn a completed turn into a failed one. The
   * first seal wins and the second is TOLD it did not.
   */
  claimMeta(key: string, field: string, value: string, ttlSeconds: number): Promise<boolean>;

  /** Set a metadata field, creating the hash if needed, and refresh its window. */
  writeMeta(key: string, field: string, value: string, ttlSeconds: number): Promise<void>;

  /** Remove keys. How many existed. */
  remove(keys: readonly string[]): Promise<number>;

  close(): Promise<void>;
}

/** `<seq>-0`, the id an entry with this sequence is written under. */
export function entryId(seq: number): string {
  return `${seq}-0`;
}

/**
 * The sequence inside a Redis entry id, or null when the id is not one of ours.
 *
 * NULL RATHER THAN A THROW OR A ZERO. This directory is not the only thing that
 * can write to a Redis server: an operator, another product, or a key collision
 * can put an entry under a server-assigned `<ms>-<n>` id in the same stream. A
 * parse that returned 0 would place that entry before every real frame and a
 * throw would take down a reader. Null lets the caller skip it and say so.
 */
export function sequenceOf(id: string): number | null {
  const dash = id.indexOf("-");
  if (dash < 0) return null;
  const left = id.slice(0, dash);
  const right = id.slice(dash + 1);
  if (!/^[0-9]+$/u.test(left) || right !== "0") return null;
  const seq = Number(left);
  return Number.isSafeInteger(seq) && seq >= 1 ? seq : null;
}

/** Open the one connection this directory holds. */
export function createRedisStreamConnection(
  options: RedisStreamConnectionOptions,
): RedisStreamConnection {
  const client = new Redis(options.url, {
    commandTimeout: options.commandTimeoutMs ?? 5_000,
    // FAIL RATHER THAN QUEUE, for the reason `redis-cache` gives: a command
    // buffered while the connection is down resolves whenever the server returns,
    // so a caller waiting on it waits past its own timeout and the fail-closed
    // refusal never happens. An error is the answer the port is written to report.
    enableOfflineQueue: false,
    maxRetriesPerRequest: 1,
  });

  // A PERMANENT ERROR LISTENER, OR THE PROCESS DIES. An `error` event with no
  // listener is rethrown by the emitter. Every command still rejects; this only
  // stops a disconnection from being fatal to a process whose whole design is to
  // report it as a value.
  client.on("error", () => undefined);

  const ready: Promise<void> =
    client.status === "ready"
      ? Promise.resolve()
      : new Promise<void>((resolve, reject) => {
          client.once("ready", () => resolve());
          client.once("error", (error: Error) => reject(error));
        });
  // Marking the rejection handled settles nothing — an `await ready` inside a verb
  // still rejects. It stops Node killing the process on a rejection the design
  // defers, which is the hazard `redis-cache` hit at WIN-267 T3.
  void ready.catch(() => undefined);

  function toEntry(row: [string, string[]]): StreamEntry | null {
    const [id, fields] = row;
    const seq = sequenceOf(id);
    if (seq === null) return null;
    for (let index = 0; index + 1 < fields.length; index += 2) {
      if (fields[index] === ENTRY_FIELD) return { id, seq, body: fields[index + 1] ?? "" };
    }
    return null;
  }

  return {
    async append(key, entries, maxLength, ttlSeconds) {
      if (entries.length === 0) return { lastSeq: 0, trimmed: 0 };
      await ready;
      const before = await client.xlen(key);
      let lastSeq = 0;
      for (const entry of entries) {
        try {
          // EXACT `MAXLEN`, NOT `MAXLEN ~`. The approximate form trims only on a
          // node boundary, so the length a suite observes depends on the server's
          // internal node size — which would make every retention case here
          // non-deterministic and the `expired` refusal untestable.
          await client.xadd(key, "MAXLEN", maxLength, entryId(entry.seq), ENTRY_FIELD, entry.body);
        } catch {
          // The server refused the id. See the banner: a sequence that does not
          // strictly increase is a producer defect and is reported, not repaired.
          return null;
        }
        lastSeq = entry.seq;
      }
      await client.expire(key, ttlSeconds);
      const after = await client.xlen(key);
      // WHAT THE LENGTH BOUND REMOVED, DERIVED FROM THE SERVER'S OWN COUNTS
      // rather than from what this file believes the bound to be. `before +
      // written - after` is trimmed by construction, and it stays correct if
      // another writer appended concurrently — it would then under-report, which
      // is the safe direction for a number a producer uses to detect pressure.
      const trimmed = Math.max(0, before + entries.length - after);
      return { lastSeq, trimmed };
    },

    async readAfter(key, afterSeq, count) {
      await ready;
      // `(` is Redis's exclusive-range prefix: strictly after, so a reader never
      // receives the frame it already holds. Doing it with `afterSeq + 1` instead
      // would be a second place that has to know sequences are whole numbers.
      const from = afterSeq <= 0 ? "-" : `(${entryId(afterSeq)}`;
      const rows = (await client.xrange(key, from, "+", "COUNT", count)) as [string, string[]][];
      const entries: StreamEntry[] = [];
      for (const row of rows) {
        const entry = toEntry(row);
        if (entry !== null) entries.push(entry);
      }
      return entries;
    },

    async publishAssigned(key, body, maxLength, ttlSeconds) {
      await ready;
      const id = await client.xadd(key, "MAXLEN", maxLength, "*", ENTRY_FIELD, body);
      await client.expire(key, ttlSeconds);
      return id ?? "";
    },

    async tip(key) {
      await ready;
      // `XREVRANGE + - COUNT 1` is the newest entry. `$` is only meaningful
      // inside `XREAD`, so a subscriber that wants to start at the live end has
      // to learn the id first — which is what this verb is for.
      const rows = (await client.xrevrange(key, "+", "-", "COUNT", 1)) as [string, string[]][];
      return rows[0]?.[0] ?? null;
    },

    async readAfterId(key, afterId, count) {
      await ready;
      const from = afterId === null ? "-" : `(${afterId}`;
      const rows = (await client.xrange(key, from, "+", "COUNT", count)) as [string, string[]][];
      const entries: { id: string; body: string }[] = [];
      for (const [id, fields] of rows) {
        for (let index = 0; index + 1 < fields.length; index += 2) {
          if (fields[index] === ENTRY_FIELD) entries.push({ id, body: fields[index + 1] ?? "" });
        }
      }
      return entries;
    },

    async oldest(key) {
      await ready;
      const rows = (await client.xrange(key, "-", "+", "COUNT", 1)) as [string, string[]][];
      const row = rows[0];
      return row === undefined ? null : toEntry(row);
    },

    async length(key) {
      await ready;
      return await client.xlen(key);
    },

    async readMeta(key, field) {
      await ready;
      return await client.hget(key, field);
    },

    async readAllMeta(key) {
      await ready;
      const all = await client.hgetall(key);
      return Object.keys(all).length === 0 ? null : all;
    },

    async claimMeta(key, field, value, ttlSeconds) {
      await ready;
      const set = await client.hsetnx(key, field, value);
      // The window is refreshed whether or not this call won, because a loser is
      // still evidence the stream is live and the winner's window should not
      // expire under a reader that is still catching up.
      await client.expire(key, ttlSeconds);
      return set === 1;
    },

    async writeMeta(key, field, value, ttlSeconds) {
      await ready;
      await client.hset(key, field, value);
      await client.expire(key, ttlSeconds);
    },

    async remove(keys) {
      if (keys.length === 0) return 0;
      await ready;
      return await client.del(...keys);
    },

    async close() {
      try {
        // GRACEFUL FIRST: `QUIT` lets the server finish the replies it owes.
        await client.quit();
      } catch {
        // A command needs a writable stream, and there is none when the handshake
        // never completed. A caller asking for release is not refused because the
        // server was never reached.
      } finally {
        // UNCONDITIONAL, and this is the half that actually releases: `quit()`
        // that could not be sent leaves a live retry timer turning the event loop.
        client.disconnect();
      }
    },
  };
}
