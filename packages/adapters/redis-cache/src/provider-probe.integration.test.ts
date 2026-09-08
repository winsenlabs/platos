// The two claims about the PROBE CACHE that only a real server can settle.
//
//   1. `SET key value PXAT <unix-ms>` HONOURS AN ABSOLUTE INSTANT. The unit
//      suite proves the instant crosses the seam unchanged; only a server proves
//      that the server does the subtraction — and that a `PXAT` already in the
//      past stores nothing rather than storing something immortal. The whole
//      reason `writeUntil` exists is to keep a clock out of the adapter, and an
//      unproven `PXAT` would have moved the clock into the server without
//      anybody checking it was there.
//
//   2. THE EVICTION PATTERN MATCHES UNDER REDIS'S OWN GLOB. The unit suite's
//      double implements `MATCH` with a regular expression this repository
//      wrote, so it is a statement about that translation as much as about the
//      pattern. Redis is the only authority on Redis globs, and eviction is the
//      half of the leaked-key repair a store can break.
//
// It FAILS when Docker is absent rather than skipping, for the reason
// `harness.ts` states: a skipped integration suite and a passing one look
// identical in a CI summary.

import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";

import type {
  ProviderHealthReport,
  ProviderId,
} from "@platos/context-providers/application/ports/index.js";
import {
  asProvidersIdentifier,
  credentialFingerprint,
  healthCacheKey,
  modelListCacheKey,
} from "@platos/context-providers/application/ports/index.js";

import type { RedisConnection } from "./client.js";
import { startRedisHarness, type RedisHarness } from "./harness.js";
import { createRedisProviderProbeCache } from "./provider-probe-cache.js";

const PROVIDER = asProvidersIdentifier<ProviderId>("openai");
const OTHER = asProvidersIdentifier<ProviderId>("anthropic");

const BEFORE = credentialFingerprint({
  providerKeyId: "pk_1",
  credentialId: "cred_1",
  updatedAt: new Date("2026-03-01T00:00:00.000Z"),
});
const AFTER = credentialFingerprint({
  providerKeyId: "pk_1",
  credentialId: "cred_1",
  updatedAt: new Date("2026-03-04T00:00:00.000Z"),
});

const REPORT: ProviderHealthReport = {
  provider: PROVIDER,
  status: "healthy",
  latencyMs: 42,
  failure: null,
  model: "gpt-4o-mini",
  requiredCredentials: [],
  checkedAt: new Date("2026-03-04T10:17:41.250Z"),
};

let harness: RedisHarness;
let connection: RedisConnection;

beforeAll(async () => {
  harness = await startRedisHarness();
  connection = harness.connect();
}, 180_000);

afterEach(async () => {
  await harness.reset();
});

afterAll(async () => {
  await harness?.stop();
});

describe("the domain's expiry instant is honoured by the SERVER", () => {
  it("stores a report until the instant the domain named", async () => {
    const cache = createRedisProviderProbeCache(connection);
    const key = healthCacheKey(PROVIDER, BEFORE);
    // A generous future instant: the point is that the entry LIVES and its
    // lifetime is bounded, not how long it lives.
    const expiresAt = new Date(Date.now() + 300_000);
    expect((await cache.writeHealth(key, REPORT, expiresAt)).ok).toBe(true);

    const found = await cache.readHealth(key);
    expect(found.ok).toBe(true);
    if (!found.ok) return;
    expect(found.value).toEqual(REPORT);
  }, 60_000);

  it("stores NOTHING when the instant has already passed", async () => {
    const cache = createRedisProviderProbeCache(connection);
    const key = healthCacheKey(PROVIDER, BEFORE);
    // A memo that was stale before it was written is not an error and is not an
    // entry. A relative-TTL implementation would have had to compute a negative
    // lifetime here and would either have thrown or written a key with no expiry
    // at all — which is the immortal-entry failure `writeUntil` avoids.
    const written = await cache.writeHealth(key, REPORT, new Date(Date.now() - 60_000));
    expect(written.ok).toBe(true);
    expect(await cache.readHealth(key)).toEqual({ ok: true, value: null });
  }, 60_000);
});

describe("eviction under Redis's own glob", () => {
  it("drops both kinds of entry for one provider and leaves every other alone", async () => {
    const cache = createRedisProviderProbeCache(connection);
    const expiresAt = new Date(Date.now() + 300_000);
    // Two fingerprints for the rotated provider — the pre-rotation verdict and
    // the post-rotation one — plus another provider's, which must survive.
    await cache.writeHealth(healthCacheKey(PROVIDER, BEFORE), REPORT, expiresAt);
    await cache.writeHealth(healthCacheKey(PROVIDER, AFTER), REPORT, expiresAt);
    await cache.writeModelList(modelListCacheKey(PROVIDER, BEFORE), ["gpt-4o"], expiresAt);
    await cache.writeHealth(healthCacheKey(OTHER, BEFORE), { ...REPORT, provider: OTHER }, expiresAt);

    expect((await cache.forgetProvider(PROVIDER)).ok).toBe(true);

    expect(await cache.readHealth(healthCacheKey(PROVIDER, BEFORE))).toEqual({ ok: true, value: null });
    expect(await cache.readHealth(healthCacheKey(PROVIDER, AFTER))).toEqual({ ok: true, value: null });
    expect(await cache.readModelList(modelListCacheKey(PROVIDER, BEFORE))).toEqual({ ok: true, value: null });

    const survivor = await cache.readHealth(healthCacheKey(OTHER, BEFORE));
    expect(survivor.ok).toBe(true);
    if (!survivor.ok) return;
    expect(survivor.value?.provider).toBe(OTHER);
  }, 60_000);

  it("leaves the OTHER owners' keyspaces on this connection untouched", async () => {
    // Three ports share this client. An eviction that matched `platos:*` would
    // destroy every job reservation in the environment, and the failure would
    // look like duplicated side effects rather than like a cache bug.
    const cache = createRedisProviderProbeCache(connection);
    await connection.write("platos:jobs:idem:env_1:req_1", "reserved", 300);
    await cache.writeHealth(healthCacheKey(PROVIDER, BEFORE), REPORT, new Date(Date.now() + 300_000));

    await cache.forgetProvider(PROVIDER);

    expect(await connection.read("platos:jobs:idem:env_1:req_1")).toBe("reserved");
  }, 60_000);
});
