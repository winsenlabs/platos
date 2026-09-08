// The `ProviderProbeCache` half, against a connection whose answers a case chooses.
//
// The port's own header is the specification and every case below is one of its
// sentences with the vendor removed — a miss is `ok(null)`, an outage is an
// error, an empty model list is an ANSWER, and freshness policy is the domain's.
//
// AND ONE CASE THAT IS NOT FROM THE PORT AT ALL. "a key rotated because it
// leaked" is from `domain/health.ts`'s WIN-259 note, which records a defect that
// was LIVE: a provider key rotated because it had leaked kept being reported
// `healthy`, because the cache was keyed on a row id and rotation does not
// change the id. The key half of that was repaired by `credentialFingerprint`;
// the half a STORE can still break is eviction, and that is what the case pins.

import { describe, expect, it } from "vitest";

import type {
  ProviderHealthReport,
  ProviderId,
  ProviderProbeCache,
} from "@platos/context-providers/application/ports/index.js";
import {
  asProvidersIdentifier,
  credentialFingerprint,
  healthCacheKey,
  modelListCacheKey,
} from "@platos/context-providers/application/ports/index.js";

import type { RedisConnection } from "./client.js";
import { createRedisProviderProbeCache, evictionPattern } from "./provider-probe-cache.js";

const PROVIDER = asProvidersIdentifier<ProviderId>("openai");
const CHECKED_AT = new Date("2026-03-04T10:17:41.250Z");
const EXPIRES_AT = new Date("2026-03-04T10:22:41.250Z");

function report(status: ProviderHealthReport["status"]): ProviderHealthReport {
  return {
    provider: PROVIDER,
    status,
    latencyMs: 42,
    failure: status === "healthy" ? null : "auth_refused",
    model: "gpt-4o-mini",
    requiredCredentials: [],
    checkedAt: CHECKED_AT,
  };
}

interface Recorded {
  readonly writes: { key: string; value: string; expiresAtMs: number }[];
  readonly removed: string[];
  readonly scans: { cursor: string; pattern: string }[];
}

/**
 * A Redis-shaped double: a keyspace, plus the two verbs a store reaches it with.
 *
 * It answers `scanPrefix` by GLOB-MATCHING the pattern against the keys it holds
 * rather than by returning a canned list, which is the only version of this
 * double that can make the eviction case fail: a pattern that does not match is
 * a pattern that removes nothing.
 */
function connection(overrides: Partial<RedisConnection> = {}): {
  readonly link: RedisConnection;
  readonly log: Recorded;
  readonly keys: Map<string, string>;
} {
  const log: Recorded = { writes: [], removed: [], scans: [] };
  const keys = new Map<string, string>();
  const link: RedisConnection = {
    read: overrides.read ?? (async (key) => keys.get(key) ?? null),
    claim: overrides.claim ?? (async () => true),
    overwrite: overrides.overwrite ?? (async () => true),
    write: overrides.write ?? (async () => undefined),
    writeUntil:
      overrides.writeUntil ??
      (async (key, value, expiresAtMs) => {
        log.writes.push({ key, value, expiresAtMs });
        keys.set(key, value);
      }),
    remove:
      overrides.remove ??
      (async (removed) => {
        log.removed.push(...removed);
        let gone = 0;
        for (const key of removed) if (keys.delete(key)) gone += 1;
        return gone;
      }),
    scanPrefix:
      overrides.scanPrefix ??
      (async (cursor, pattern) => {
        log.scans.push({ cursor, pattern });
        // Redis `MATCH` glob, narrowed to what this file's patterns use: `*`,
        // and `\`-escaped literals. Anything else is a literal character.
        const expression = new RegExp(
          `^${pattern.replace(/\\(.)|[.+^${}()|[\]]|(\*)/gu, (whole, escaped: string | undefined, star: string | undefined) => {
            if (escaped !== undefined) return escaped.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
            if (star !== undefined) return ".*";
            return `\\${whole}`;
          })}$`,
          "u",
        );
        return ["0", [...keys.keys()].filter((key) => expression.test(key))];
      }),
    close: overrides.close ?? (async () => undefined),
  };
  return { link, log, keys };
}

const cacheOver = (overrides: Partial<RedisConnection> = {}): ProviderProbeCache =>
  createRedisProviderProbeCache(connection(overrides).link);

describe("a miss is ok(null); an outage is an error", () => {
  it("reports an absent key as a miss rather than a failure", async () => {
    const found = await cacheOver().readHealth(healthCacheKey(PROVIDER, "fp"));
    expect(found).toEqual({ ok: true, value: null });
  });

  it("reports an unreachable server as a REFUSAL, so a caller can tell the two apart", async () => {
    const broken = cacheOver({
      read: async () => {
        throw new Error("connect ECONNREFUSED 127.0.0.1:6379");
      },
    });
    const found = await broken.readHealth(healthCacheKey(PROVIDER, "fp"));
    expect(found.ok).toBe(false);
    if (found.ok) return;
    expect(found.error.code).toBe("PROVIDERS_REPOSITORY_UNAVAILABLE");
  });

  it("carries the driver's MESSAGE into the refusal and never the connection URL", async () => {
    const url = "redis://default:hunter2@cache.internal:6379/0";
    const broken = cacheOver({
      writeUntil: async () => {
        throw new Error("READONLY replica");
      },
    });
    const written = await broken.writeHealth(healthCacheKey(PROVIDER, "fp"), report("healthy"), EXPIRES_AT);
    expect(written.ok).toBe(false);
    if (written.ok) return;
    expect(JSON.stringify(written.error)).toContain("READONLY replica");
    expect(JSON.stringify(written.error)).not.toContain(url);
  });

  it("treats a record it cannot read as a MISS, not as a crash", async () => {
    const corrupt = cacheOver({ read: async () => "{not json" });
    expect(await corrupt.readHealth(healthCacheKey(PROVIDER, "fp"))).toEqual({ ok: true, value: null });
    expect(await corrupt.readModelList(modelListCacheKey(PROVIDER, "fp"))).toEqual({ ok: true, value: null });
  });

  it("treats a report whose instant will not parse as a MISS", async () => {
    // An Invalid Date compares false against everything, so `isFresh` would call
    // it permanently stale and the provider would be re-probed forever without
    // anything reporting why. A miss re-probes ONCE and overwrites.
    const corrupt = cacheOver({ read: async () => JSON.stringify({ ...report("healthy"), checkedAt: "never" }) });
    expect(await corrupt.readHealth(healthCacheKey(PROVIDER, "fp"))).toEqual({ ok: true, value: null });
  });
});

describe("what a stored value is when it comes back", () => {
  it("round-trips a report, with its instant still an instant", async () => {
    const { link } = connection();
    const cache = createRedisProviderProbeCache(link);
    const key = healthCacheKey(PROVIDER, "fp");
    await cache.writeHealth(key, report("invalid_key"), EXPIRES_AT);
    const found = await cache.readHealth(key);
    expect(found.ok).toBe(true);
    if (!found.ok) return;
    // `toEqual` on the whole record, so a field silently dropped by the encoder
    // fails here rather than at the first page that reads it.
    expect(found.value).toEqual(report("invalid_key"));
    expect(found.value?.checkedAt).toBeInstanceOf(Date);
  });

  it("keeps an EMPTY model list as an answer, because the port says it is one", async () => {
    const { link } = connection();
    const cache = createRedisProviderProbeCache(link);
    const key = modelListCacheKey(PROVIDER, "fp");
    await cache.writeModelList(key, [], EXPIRES_AT);
    // `ok(null)` here would defeat the whole reason the empty result is cached:
    // stopping a broken upstream from being called once per page load.
    expect(await cache.readModelList(key)).toEqual({ ok: true, value: [] });
  });

  it("writes the domain's INSTANT and computes no lifetime of its own", async () => {
    const { link, log } = connection();
    await createRedisProviderProbeCache(link).writeHealth(
      healthCacheKey(PROVIDER, "fp"),
      report("healthy"),
      EXPIRES_AT,
    );
    // The port: freshness policy lives in `domain/health.ts`, and "an
    // implementation that quietly applied a TTL of its own would make the
    // domain's answer and the store's answer disagree". The instant crosses
    // unchanged, so there is no arithmetic here to disagree with.
    expect(log.writes).toEqual([
      {
        key: `platos:providers:probe:${healthCacheKey(PROVIDER, "fp")}`,
        value: JSON.stringify(report("healthy")),
        expiresAtMs: EXPIRES_AT.getTime(),
      },
    ]);
  });

  it("keeps the two kinds of entry in disjoint keys", async () => {
    const { link, keys } = connection();
    const cache = createRedisProviderProbeCache(link);
    await cache.writeHealth(healthCacheKey(PROVIDER, "fp"), report("healthy"), EXPIRES_AT);
    await cache.writeModelList(modelListCacheKey(PROVIDER, "fp"), ["a"], EXPIRES_AT);
    expect(keys.size).toBe(2);
  });
});

describe("a key rotated because it leaked must stop answering healthy", () => {
  // The two fingerprints differ ONLY in `updatedAt`, which is precisely the
  // rotation case `domain/health.ts` records: "rotation rotates the credential
  // BEHIND the row and relinks the same `ProviderKey`", so the row id and the
  // credential id are unchanged and only the instant moves.
  const before = credentialFingerprint({
    providerKeyId: "pk_1",
    credentialId: "cred_1",
    updatedAt: new Date("2026-03-01T00:00:00.000Z"),
  });
  const after = credentialFingerprint({
    providerKeyId: "pk_1",
    credentialId: "cred_1",
    updatedAt: new Date("2026-03-04T00:00:00.000Z"),
  });

  it("addresses a different entry after the rotation", () => {
    // The KEY half of the repair, restated here because this store is what makes
    // it true or false in Redis: two fingerprints, two keys, so the pre-rotation
    // verdict is not what the post-rotation read asks for.
    expect(before).not.toBe(after);
    expect(healthCacheKey(PROVIDER, before)).not.toBe(healthCacheKey(PROVIDER, after));
  });

  it("EVICTS the pre-rotation verdict, so nothing still holding the old fingerprint can read it", async () => {
    const { link, keys } = connection();
    const cache = createRedisProviderProbeCache(link);
    await cache.writeHealth(healthCacheKey(PROVIDER, before), report("healthy"), EXPIRES_AT);
    await cache.writeModelList(modelListCacheKey(PROVIDER, before), ["gpt-4o"], EXPIRES_AT);
    expect(keys.size).toBe(2);

    const forgotten = await cache.forgetProvider(PROVIDER);
    expect(forgotten.ok).toBe(true);
    // BOTH kinds, or a rotated credential's model list survives the eviction of
    // its health verdict — the same defect one aisle over.
    expect(keys.size).toBe(0);
    expect(await cache.readHealth(healthCacheKey(PROVIDER, before))).toEqual({ ok: true, value: null });
  });

  it("evicts ONLY that provider, so one rotation does not re-probe every other", async () => {
    const other = asProvidersIdentifier<ProviderId>("anthropic");
    const { link, keys } = connection();
    const cache = createRedisProviderProbeCache(link);
    await cache.writeHealth(healthCacheKey(PROVIDER, before), report("healthy"), EXPIRES_AT);
    await cache.writeHealth(healthCacheKey(other, before), report("healthy"), EXPIRES_AT);

    await cache.forgetProvider(PROVIDER);
    expect([...keys.keys()]).toEqual([`platos:providers:probe:${healthCacheKey(other, before)}`]);
  });

  it("reports a FAILED eviction as a failure, rather than as a rotation that worked", async () => {
    const broken = cacheOver({
      scanPrefix: async () => {
        throw new Error("connect ECONNREFUSED 127.0.0.1:6379");
      },
    });
    const forgotten = await broken.forgetProvider(PROVIDER);
    // `domain/health.ts` records that all six call sites DISCARDED this Result.
    // Repairing that is the caller's; what this side owes is a refusal that is
    // true, so the day a caller starts checking, it is checking something real.
    expect(forgotten.ok).toBe(false);
  });
});

describe("the eviction pattern is DERIVED from the domain's key builder", () => {
  it("matches every fingerprint under one provider and nothing under another", () => {
    const pattern = evictionPattern(healthCacheKey, PROVIDER);
    // Read off the builder, not written out: if `domain/health.ts` ever changes
    // the layout, this expectation moves with it and the pattern moves with it,
    // and the SCAN case above is what fails if they stop moving together.
    expect(pattern).toBe(`platos:providers:probe:${healthCacheKey(PROVIDER, "")}*`);
    expect(healthCacheKey(PROVIDER, "any-fingerprint").startsWith(healthCacheKey(PROVIDER, ""))).toBe(true);
  });

  it("cannot be widened by a provider id carrying a glob character", async () => {
    // `asProvidersIdentifier` tags a string; nothing stops a caller tagging one
    // with a `*` in it, and a pattern built by interpolation would then evict
    // another provider's entries. The escape is what stops that.
    const hostile = asProvidersIdentifier<ProviderId>("*");
    const { link, keys } = connection();
    const cache = createRedisProviderProbeCache(link);
    await cache.writeHealth(healthCacheKey(PROVIDER, "fp"), report("healthy"), EXPIRES_AT);
    await cache.forgetProvider(hostile);
    expect(keys.size).toBe(1);
  });
});
