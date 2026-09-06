// What the request store does with what Redis says, WITHOUT a Redis.
//
// The same division of labour `idempotency-store.test.ts` states beside its own
// integration suite, and for the same reason. The real-Redis proof for THIS port
// lives in `apps/core-api/src/http/idempotency.integration.test.ts`, where two
// identical HTTP requests race through the whole process; what belongs here is
// the set of branches a working server cannot be asked to take on demand — a
// connection that throws, a key holding rubbish, a record truncated to half a
// reservation, and the release that must NOT delete a stranger's record.

import { describe, expect, it } from "vitest";

import type { RequestFingerprint } from "@platos/kernel";

import type { RedisConnection } from "./client.js";
import { createRedisRequestIdempotency, requestReservationKey } from "./request-idempotency.js";

const FINGERPRINT: RequestFingerprint = { scope: "0123456789abcdef0123456789abcdef", key: "k-1", digest: "d-1" };
const RESPONSE = { status: 201, body: '{"secret":"s"}', contentType: "application/json" };
const TTL = 60;

function connection(overrides: Partial<RedisConnection> = {}): RedisConnection & {
  readonly calls: string[];
} {
  const calls: string[] = [];
  const record =
    <Args extends unknown[], Value>(name: string, value: (...args: Args) => Promise<Value>) =>
    async (...args: Args): Promise<Value> => {
      calls.push(name);
      return await value(...args);
    };
  return {
    calls,
    read: record("read", overrides.read ?? (async () => null)),
    claim: record("claim", overrides.claim ?? (async () => true)),
    overwrite: record("overwrite", overrides.overwrite ?? (async () => true)),
    write: record("write", overrides.write ?? (async () => undefined)),
    remove: record("remove", overrides.remove ?? (async () => 1)),
    scanPrefix: record("scanPrefix", overrides.scanPrefix ?? (async () => ["0", []])),
    close: record("close", overrides.close ?? (async () => undefined)),
  } as RedisConnection & { readonly calls: string[] };
}

describe("the keyspace", () => {
  it("is disjoint from the jobs reservation namespace", () => {
    // Two ports on one connection. A shared prefix would let a job reservation
    // be read as an HTTP response, and vice versa.
    expect(requestReservationKey(FINGERPRINT).startsWith("platos:http:idem:")).toBe(true);
    expect(requestReservationKey(FINGERPRINT).startsWith("platos:jobs:idem:")).toBe(false);
  });

  it("puts the scope IN the key, so two callers cannot collide on one key", () => {
    const other = { ...FINGERPRINT, scope: "ffffffffffffffffffffffffffffffff" };
    expect(requestReservationKey(FINGERPRINT)).not.toBe(requestReservationKey(other));
  });
});

describe("reserve", () => {
  it("claims with NX and reads nothing when it wins", async () => {
    const link = connection({ claim: async () => true });
    const store = createRedisRequestIdempotency(link);
    expect(await store.reserve(FINGERPRINT, TTL)).toEqual({ kind: "reserved" });
    // ONE command. A `read` here would mean the store had composed a get and a
    // set, which is the race this port exists to close.
    expect(link.calls).toEqual(["claim"]);
  });

  it("passes the ttl the caller asked for to the server", async () => {
    let seen = 0;
    const store = createRedisRequestIdempotency(
      connection({
        claim: async (_key, _value, ttl) => {
          seen = ttl;
          return true;
        },
      }),
    );
    await store.reserve(FINGERPRINT, 3600);
    expect(seen).toBe(3600);
  });

  it("reports `absent` when the incumbent has gone by the time it is read", async () => {
    const store = createRedisRequestIdempotency(
      connection({ claim: async () => false, read: async () => null }),
    );
    expect(await store.reserve(FINGERPRINT, TTL)).toEqual({ kind: "absent" });
  });

  it("reports `malformed` for bytes that are not JSON", async () => {
    const store = createRedisRequestIdempotency(
      connection({ claim: async () => false, read: async () => "not json" }),
    );
    expect(await store.reserve(FINGERPRINT, TTL)).toEqual({ kind: "malformed" });
  });

  it("reports `malformed` for a settled record with no response", async () => {
    // A record something truncated is not a record a caller may replay. The
    // alternative — treating a missing response as an empty one — would answer a
    // secret mint with an empty body and call it a replay.
    const store = createRedisRequestIdempotency(
      connection({
        claim: async () => false,
        read: async () => JSON.stringify({ state: "settled", digest: "d-1" }),
      }),
    );
    expect(await store.reserve(FINGERPRINT, TTL)).toEqual({ kind: "malformed" });
  });

  it("reports `malformed` for a response whose status is not a whole number", async () => {
    const store = createRedisRequestIdempotency(
      connection({
        claim: async () => false,
        read: async () =>
          JSON.stringify({ state: "settled", digest: "d-1", response: { status: "201", body: "" } }),
      }),
    );
    expect(await store.reserve(FINGERPRINT, TTL)).toEqual({ kind: "malformed" });
  });

  it("checks the DIGEST before the state", async () => {
    // A running record under somebody else's digest is a mismatch, not an
    // in-flight twin. Reporting it as in-flight would tell the caller to retry a
    // key that will never come free for it.
    const store = createRedisRequestIdempotency(
      connection({
        claim: async () => false,
        read: async () => JSON.stringify({ state: "running", digest: "other" }),
      }),
    );
    expect(await store.reserve(FINGERPRINT, TTL)).toEqual({ kind: "mismatch" });
  });

  it("never replays a record belonging to a different request", async () => {
    const store = createRedisRequestIdempotency(
      connection({
        claim: async () => false,
        read: async () =>
          JSON.stringify({ state: "settled", digest: "other", response: RESPONSE }),
      }),
    );
    // The security case: a settled record under a reused key must not hand its
    // body — which on a mint is a secret — to a different request.
    expect(await store.reserve(FINGERPRINT, TTL)).toEqual({ kind: "mismatch" });
  });

  it("replays a settled twin exactly", async () => {
    const store = createRedisRequestIdempotency(
      connection({
        claim: async () => false,
        read: async () => JSON.stringify({ state: "settled", digest: "d-1", response: RESPONSE }),
      }),
    );
    expect(await store.reserve(FINGERPRINT, TTL)).toEqual({ kind: "replay", response: RESPONSE });
  });

  it("reports a running twin as in-flight", async () => {
    const store = createRedisRequestIdempotency(
      connection({
        claim: async () => false,
        read: async () => JSON.stringify({ state: "running", digest: "d-1" }),
      }),
    );
    expect(await store.reserve(FINGERPRINT, TTL)).toEqual({ kind: "in-flight" });
  });

  it("fails closed when the claim throws", async () => {
    const store = createRedisRequestIdempotency(
      connection({
        claim: async () => {
          throw new Error("connect ECONNREFUSED");
        },
      }),
    );
    expect(await store.reserve(FINGERPRINT, TTL)).toEqual({
      kind: "unavailable",
      reason: "connect ECONNREFUSED",
    });
  });

  it("fails closed — and NOT as `absent` — when the incumbent read throws", async () => {
    // `absent` is a positive answer from a working store. A read that threw is
    // no answer at all, and reporting it as absent would tell an operator to
    // look at the eviction policy of a store that is simply down.
    const store = createRedisRequestIdempotency(
      connection({
        claim: async () => false,
        read: async () => {
          throw new Error("read timeout");
        },
      }),
    );
    expect(await store.reserve(FINGERPRINT, TTL)).toEqual({
      kind: "unavailable",
      reason: "read timeout",
    });
  });

  it("carries no driver object into the reason it reports", async () => {
    // A driver error carries the connection string, which carries the password,
    // and the reason is rendered into a log line.
    const store = createRedisRequestIdempotency(
      connection({
        claim: async () => {
          throw { url: "redis://user:hunter2@host:6379" };
        },
      }),
    );
    expect(await store.reserve(FINGERPRINT, TTL)).toEqual({
      kind: "unavailable",
      reason: "redis command failed",
    });
  });
});

describe("record", () => {
  it("uses XX, never NX and never an unconditional write", async () => {
    const link = connection();
    const store = createRedisRequestIdempotency(link);
    expect(await store.record(FINGERPRINT, RESPONSE, TTL)).toEqual({ kind: "settled" });
    expect(link.calls).toEqual(["overwrite"]);
  });

  it("reports `expired` rather than resurrecting a key whose window closed", async () => {
    const store = createRedisRequestIdempotency(connection({ overwrite: async () => false }));
    expect(await store.record(FINGERPRINT, RESPONSE, TTL)).toEqual({ kind: "expired" });
  });

  it("writes the response back verbatim, and a later reserve replays it", async () => {
    let stored = "";
    const link = connection({
      overwrite: async (_key, value) => {
        stored = value;
        return true;
      },
    });
    const store = createRedisRequestIdempotency(link);
    await store.record(FINGERPRINT, RESPONSE, TTL);
    const replaying = createRedisRequestIdempotency(
      connection({ claim: async () => false, read: async () => stored }),
    );
    expect(await replaying.reserve(FINGERPRINT, TTL)).toEqual({ kind: "replay", response: RESPONSE });
  });

  it("fails closed when the settle throws", async () => {
    const store = createRedisRequestIdempotency(
      connection({
        overwrite: async () => {
          throw new Error("write timeout");
        },
      }),
    );
    expect(await store.record(FINGERPRINT, RESPONSE, TTL)).toEqual({
      kind: "unavailable",
      reason: "write timeout",
    });
  });
});

describe("release", () => {
  it("reads before it deletes, and deletes only its own reservation", async () => {
    const link = connection({
      read: async () => JSON.stringify({ state: "running", digest: "d-1" }),
      remove: async () => 1,
    });
    const store = createRedisRequestIdempotency(link);
    expect(await store.release(FINGERPRINT)).toEqual({ kind: "settled" });
    expect(link.calls).toEqual(["read", "remove"]);
  });

  it("does NOT delete a record carrying somebody else's digest", async () => {
    // The window this read exists to shrink: a request that overran its own
    // reservation must not delete the TWIN that claimed the key afterwards,
    // because the twin would then be free to run a second time.
    const link = connection({
      read: async () => JSON.stringify({ state: "running", digest: "other" }),
    });
    const store = createRedisRequestIdempotency(link);
    expect(await store.release(FINGERPRINT)).toEqual({ kind: "expired" });
    expect(link.calls).toEqual(["read"]);
  });

  it("deletes nothing when the record has already gone", async () => {
    const link = connection({ read: async () => null });
    const store = createRedisRequestIdempotency(link);
    expect(await store.release(FINGERPRINT)).toEqual({ kind: "expired" });
    expect(link.calls).toEqual(["read"]);
  });

  it("deletes nothing when the record is not a reservation", async () => {
    const link = connection({ read: async () => "{" });
    const store = createRedisRequestIdempotency(link);
    expect(await store.release(FINGERPRINT)).toEqual({ kind: "expired" });
    expect(link.calls).toEqual(["read"]);
  });

  it("reports `expired` when the delete removed nothing", async () => {
    const store = createRedisRequestIdempotency(
      connection({
        read: async () => JSON.stringify({ state: "running", digest: "d-1" }),
        remove: async () => 0,
      }),
    );
    expect(await store.release(FINGERPRINT)).toEqual({ kind: "expired" });
  });

  it("fails closed when the delete throws", async () => {
    const store = createRedisRequestIdempotency(
      connection({
        read: async () => JSON.stringify({ state: "running", digest: "d-1" }),
        remove: async () => {
          throw new Error("del timeout");
        },
      }),
    );
    expect(await store.release(FINGERPRINT)).toEqual({
      kind: "unavailable",
      reason: "del timeout",
    });
  });
});
