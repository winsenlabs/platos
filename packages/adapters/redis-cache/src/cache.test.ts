// The `Cache` half, against a connection whose answers a case chooses.
//
// Every assertion here is one of the four properties the port's header sets out,
// or one of the two refusals it asks an implementation to make. The properties
// are the specification; this file is the specification with the vendor removed.

import type { Cache } from "@platos/context-memory/application/ports/index.js";
import { describe, expect, it } from "vitest";

import { createRedisCache } from "./cache.js";
import type { RedisConnection } from "./client.js";

interface Recorded {
  readonly writes: { key: string; value: string; ttlSeconds: number }[];
  readonly removed: string[];
  readonly scans: { cursor: string; pattern: string }[];
}

function connection(overrides: Partial<RedisConnection> = {}): {
  readonly link: RedisConnection;
  readonly log: Recorded;
} {
  const log: Recorded = { writes: [], removed: [], scans: [] };
  const link: RedisConnection = {
    read: overrides.read ?? (async () => null),
    claim: overrides.claim ?? (async () => true),
    overwrite: overrides.overwrite ?? (async () => true),
    write:
      overrides.write ??
      (async (key, value, ttlSeconds) => {
        log.writes.push({ key, value, ttlSeconds });
      }),
    remove:
      overrides.remove ??
      (async (keys) => {
        log.removed.push(...keys);
        return keys.length;
      }),
    scanPrefix:
      overrides.scanPrefix ??
      (async (cursor, pattern) => {
        log.scans.push({ cursor, pattern });
        return ["0", []];
      }),
    close: overrides.close ?? (async () => undefined),
  };
  return { link, log };
}

const cacheOver = (overrides: Partial<RedisConnection> = {}): Cache =>
  createRedisCache(connection(overrides).link);

describe("property 2 — every write carries its TTL", () => {
  it("passes the entry's TTL to the server", async () => {
    const { link, log } = connection();
    await createRedisCache(link).set({ key: "k", value: "v", ttlSeconds: 90 });
    expect(log.writes).toEqual([{ key: "k", value: "v", ttlSeconds: 90 }]);
  });

  it("REFUSES a non-positive or fractional TTL before any command is sent", async () => {
    // Redis rejects a non-positive `EX` with a driver error naming no key, which
    // would reach a caller as MEMORY_CACHE_UNAVAILABLE — a caller defect
    // reported as an outage, and one a caller would retry forever.
    for (const ttlSeconds of [0, -1, 1.5, Number.NaN]) {
      const { link, log } = connection();
      const outcome = await createRedisCache(link).set({ key: "k", value: "v", ttlSeconds });
      if (outcome.ok) throw new Error(`unreachable for ${ttlSeconds}`);
      expect(outcome.error.code, String(ttlSeconds)).toBe("MEMORY_CACHE_TTL_INVALID");
      expect(log.writes, String(ttlSeconds)).toHaveLength(0);
    }
  });
});

describe("property 1 — the store composes no key", () => {
  it("writes and reads the key it was handed, unchanged", async () => {
    // `domain/working-set.ts` mints every key this store sees. A prefix or a
    // hash here would be a second key policy in the layer that cannot see the
    // first, and a cached value would then be invisible to its own invalidation.
    const { link, log } = connection({ read: async (key) => `read:${key}` });
    const cache = createRedisCache(link);
    await cache.set({ key: "memory:env-1:agent-7", value: "v", ttlSeconds: 30 });
    expect(log.writes[0]?.key).toBe("memory:env-1:agent-7");
    expect(await cache.get("memory:env-1:agent-7")).toEqual({
      ok: true,
      value: "read:memory:env-1:agent-7",
    });
  });
});

describe("property 3 — values are strings", () => {
  it("stores the value verbatim and returns it verbatim", async () => {
    // No parsing and no re-encoding: the caller is the only party that knows
    // whether a value is a projection it may reshape or an opaque watermark.
    const json = '{"not":"parsed"}';
    const { link, log } = connection({ read: async () => json });
    const cache = createRedisCache(link);
    await cache.set({ key: "k", value: json, ttlSeconds: 30 });
    expect(log.writes[0]?.value).toBe(json);
    expect(await cache.get("k")).toEqual({ ok: true, value: json });
  });
});

describe("property 4 — failure is a value, and a MISS is not a failure", () => {
  it("reports an absent key as null rather than as an error", async () => {
    expect(await cacheOver({ read: async () => null }).get("k")).toEqual({ ok: true, value: null });
  });

  it("reports an unreachable server as UNAVAILABLE, so the two can be told apart", async () => {
    const outcome = await cacheOver({
      read: async () => {
        throw new Error("connection refused");
      },
    }).get("k");
    if (outcome.ok) throw new Error("unreachable");
    expect(outcome.error.code).toBe("MEMORY_CACHE_UNAVAILABLE");
    expect(outcome.error.category).toBe("unavailable");
  });

  it("never throws out of any method", async () => {
    // The callers in `memory` treat a cache failure as a miss. A method that
    // threw would take the read it was serving down with it.
    const failing = (): Promise<never> => Promise.reject(new Error("down"));
    const cache = cacheOver({
      read: failing,
      write: failing,
      remove: failing,
      scanPrefix: failing,
    });
    expect((await cache.get("k")).ok).toBe(false);
    expect((await cache.set({ key: "k", value: "v", ttlSeconds: 5 })).ok).toBe(false);
    expect((await cache.delete("k")).ok).toBe(false);
    expect((await cache.deleteNamespace("p:")).ok).toBe(false);
  });
});

describe("delete", () => {
  it("reports TRUE when a key went and FALSE when there was nothing to remove", async () => {
    expect(await cacheOver({ remove: async () => 1 }).delete("k")).toEqual({ ok: true, value: true });
    expect(await cacheOver({ remove: async () => 0 }).delete("k")).toEqual({ ok: true, value: false });
  });
});

describe("deleteNamespace", () => {
  it("REFUSES a blank prefix before any command is sent", async () => {
    // The port: an implementation "MUST NOT expose a general pattern match:
    // `deleteNamespace(\"\")` would be a flush of the whole keyspace".
    const { link, log } = connection();
    const outcome = await createRedisCache(link).deleteNamespace("");
    if (outcome.ok) throw new Error("unreachable");
    expect(outcome.error.code).toBe("MEMORY_CACHE_NAMESPACE_INVALID");
    expect(log.scans).toHaveLength(0);
    expect(log.removed).toHaveLength(0);
  });

  it("follows the cursor to the end and sums what each round removed", async () => {
    const rounds: [string, readonly string[]][] = [
      ["17", ["p:a", "p:b"]],
      ["0", ["p:c"]],
    ];
    let index = 0;
    const { link, log } = connection({
      scanPrefix: async () => rounds[index++] ?? ["0", []],
    });
    expect(await createRedisCache(link).deleteNamespace("p:")).toEqual({ ok: true, value: 3 });
    expect(log.removed).toEqual(["p:a", "p:b", "p:c"]);
  });

  it("survives a round that matches nothing and still returns a cursor", async () => {
    // A `SCAN` round may match nothing and still be mid-traversal. A loop that
    // stopped on an empty batch would leave keys behind, and `del()` with no
    // arguments is a driver error.
    const rounds: [string, readonly string[]][] = [
      ["9", []],
      ["0", ["p:z"]],
    ];
    let index = 0;
    const { link, log } = connection({ scanPrefix: async () => rounds[index++] ?? ["0", []] });
    expect(await createRedisCache(link).deleteNamespace("p:")).toEqual({ ok: true, value: 1 });
    expect(log.removed).toEqual(["p:z"]);
  });

  it("escapes glob metacharacters, so a prefix names only itself", async () => {
    // Without this, a namespace containing `*` or `[` would match more keys than
    // it names — in the one bulk destructive operation in this directory.
    const { link, log } = connection();
    await createRedisCache(link).deleteNamespace("memory:a*b[c]:");
    expect(log.scans[0]?.pattern).toBe("memory:a\\*b\\[c\\]:*");
  });
});
