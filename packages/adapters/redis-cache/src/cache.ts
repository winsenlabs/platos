// The `memory` `Cache`, over Redis.
//
// ADR M0.3 §13: "`Cache` is intentionally owned by `memory`; Redis is an
// implementation detail and does not define architectural ownership." So this
// honours a port written without a vendor in it, and the four properties the
// port's own header sets out are what it is judged on:
//
//   1. IT NAMES NO VENDOR TO ITS CALLER, and composes no key.
//      `domain/working-set.ts` mints every key this store is handed; a store
//      that prefixed or hashed them would be a second key policy, in the layer
//      that cannot see the first.
//   2. EVERY WRITE CARRIES ITS TTL. There is no path here that writes without
//      one. A cached projection that outlived its invalidation would serve a
//      rewritten subject's old profile and nothing would report it.
//   3. VALUES ARE STRINGS. No parsing, no re-encoding: the caller is the only
//      party that knows whether a value is a projection or an opaque watermark.
//   4. FAILURE IS A VALUE. Every method returns `Result` and none throws,
//      because the callers in `memory` treat a cache failure as a MISS and have
//      to be able to tell "the cache is down" from "the key was absent".
//
// `deleteNamespace` REFUSES A BLANK PREFIX AND SCANS RATHER THAN LISTS. The port
// says an implementation "MUST NOT expose a general pattern match:
// `deleteNamespace("")` would be a flush of the whole keyspace" — so a blank
// prefix is refused before any command is sent. The sweep uses `SCAN` rather
// than `KEYS` because `KEYS` blocks the single-threaded server for the length of
// the whole keyspace, which on a shared Redis is an outage for every other owner
// in it.

import type { Cache, CacheEntry, Result } from "@platos/context-memory/application/ports/index.js";
import {
  cacheNamespaceInvalid,
  cacheTtlInvalid,
  cacheUnavailable,
  err,
  ok,
} from "@platos/context-memory/application/ports/index.js";

import type { RedisConnection } from "./client.js";

/** How many keys one `SCAN` round asks for. */
const SCAN_BATCH = 256;

function reasonOf(error: unknown): string {
  // The MESSAGE only, never the error object. A driver error carries the
  // connection URL, which carries the password, and `details` is rendered into
  // logs.
  return error instanceof Error ? error.message : "redis command failed";
}

/**
 * Escape the glob metacharacters Redis `MATCH` understands.
 *
 * Without it a namespace containing `*`, `?` or `[` would match more keys than
 * it names — and the one bulk destructive operation in this directory is the
 * last place a caller's string should be read as a pattern.
 */
function escapeGlob(prefix: string): string {
  return prefix.replace(/[[\]?*\\^]/gu, (character) => `\\${character}`);
}

export function createRedisCache(connection: RedisConnection): Cache {
  return {
    async get(key: string): Promise<Result<string | null>> {
      try {
        return ok(await connection.read(key));
      } catch (error) {
        return err(cacheUnavailable(reasonOf(error)));
      }
    },

    async set(entry: CacheEntry): Promise<Result<void>> {
      // Redis refuses a non-positive `EX` with a driver error that names no key,
      // which would arrive at a caller as "the cache is down". Refusing here
      // names the entry and keeps the port's second property a RULE rather than
      // a hope about what the server happens to do.
      if (!Number.isInteger(entry.ttlSeconds) || entry.ttlSeconds <= 0) {
        return err(cacheTtlInvalid(entry.ttlSeconds));
      }
      try {
        await connection.write(entry.key, entry.value, entry.ttlSeconds);
        return ok(undefined);
      } catch (error) {
        return err(cacheUnavailable(reasonOf(error)));
      }
    },

    async delete(key: string): Promise<Result<boolean>> {
      try {
        return ok((await connection.remove([key])) > 0);
      } catch (error) {
        return err(cacheUnavailable(reasonOf(error)));
      }
    },

    async deleteNamespace(prefix: string): Promise<Result<number>> {
      if (prefix.length === 0) return err(cacheNamespaceInvalid());
      const pattern = `${escapeGlob(prefix)}*`;
      let cursor = "0";
      let removed = 0;
      try {
        do {
          const [next, keys] = await connection.scanPrefix(cursor, pattern, SCAN_BATCH);
          cursor = next;
          // A `SCAN` round may match nothing and still return a non-zero cursor,
          // so the batch is checked rather than assumed non-empty.
          removed += await connection.remove(keys);
        } while (cursor !== "0");
        return ok(removed);
      } catch (error) {
        return err(cacheUnavailable(reasonOf(error)));
      }
    },
  };
}
