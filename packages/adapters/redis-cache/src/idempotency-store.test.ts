// What the store does with what Redis says, WITHOUT a Redis.
//
// The division of labour with `idempotency.integration.test.ts` beside this file
// is deliberate and is not "unit versus integration". THAT suite proves the
// commands mean what this file assumes — that `NX` really is atomic under a real
// race, that a TTL really expires, that `XX` really refuses a vanished key —
// against a server nobody here controls. THIS one proves the branches a real
// server cannot be persuaded to take on demand: a connection that throws, a key
// that holds rubbish, a record whose cached failure names a code this major
// never promised. Neither suite can replace the other, and a store proven only
// by the first would have every fail-closed path untested.

import {
  asIdentifier,
  completedReservation,
  failedReservation,
  runningReservation,
  type ExecutionRequestId,
  type IdempotencyKey,
  type RequestDigest,
} from "@platos/context-jobs/application/ports/index.js";
import { describe, expect, it } from "vitest";

import type { RedisConnection } from "./client.js";
import { createRedisIdempotencyStore, reservationKey } from "./idempotency-store.js";

const DIGEST = asIdentifier<RequestDigest>("digest-a");
const KEY: IdempotencyKey = {
  environmentId: "env-1",
  requestId: asIdentifier<ExecutionRequestId>("req-1"),
};
const TTL = 60;

/**
 * A connection whose every answer a case chooses.
 *
 * Not a Redis simulator: it records what was asked and returns what it was told
 * to. A simulator would be a second implementation of the server's semantics,
 * written by the same person who wrote the store, and the two would agree by
 * construction — which is the vacuity the integration suite exists to avoid.
 */
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
    remove: record("remove", overrides.remove ?? (async () => 0)),
    scanPrefix: record("scanPrefix", overrides.scanPrefix ?? (async () => ["0", []])),
    close: record("close", overrides.close ?? (async () => undefined)),
  } as RedisConnection & { readonly calls: string[] };
}

describe("the keyspace", () => {
  it("puts the environment IN the key, so two environments cannot collide", () => {
    const other: IdempotencyKey = { ...KEY, environmentId: "env-2" };
    expect(reservationKey(KEY)).not.toBe(reservationKey(other));
    expect(reservationKey(KEY)).toContain("env-1");
    expect(reservationKey(KEY)).toContain("req-1");
  });

  it("namespaces every key under one prefix this directory owns", () => {
    // ADR M0.3 §4 asks each adapter for "one namespaced keyspace". A key without
    // the prefix would be indistinguishable from another owner's on a shared
    // server, and `deleteNamespace` on the cache half would be able to reach it.
    expect(reservationKey(KEY).startsWith("platos:jobs:idem:")).toBe(true);
  });
});

describe("reserve", () => {
  it("claims the key in ONE command and reads nothing when it wins", () => {
    // A `GET` before the `SET` would be the race this port exists to close:
    // two processes can both read "absent" and both then write.
    const link = connection({ claim: async () => true });
    return createRedisIdempotencyStore(link)
      .reserve(KEY, runningReservation(DIGEST), TTL)
      .then((outcome) => {
        expect(outcome).toEqual({ ok: true, value: { kind: "reserved" } });
        expect(link.calls).toEqual(["claim"]);
      });
  });

  it("reads the incumbent when it LOSES, and reports it as readable", async () => {
    const held = completedReservation(DIGEST, { rows: 3 });
    const link = connection({
      claim: async () => false,
      read: async () => JSON.stringify(held),
    });
    const outcome = await createRedisIdempotencyStore(link).reserve(KEY, runningReservation(DIGEST), TTL);
    if (!outcome.ok) throw new Error("unreachable");
    expect(outcome.value).toEqual({ kind: "held", held: { kind: "readable", reservation: held } });
    expect(link.calls).toEqual(["claim", "read"]);
  });

  it("reports ABSENT when the key vanished between the refused claim and the read", async () => {
    // Redis has no "SET NX, and hand me the incumbent if you refuse", so the
    // read is a second command and the key can expire in between. WIN-260 made
    // this its own answer rather than folding it into a conflict: nothing the
    // caller did caused it.
    const link = connection({ claim: async () => false, read: async () => null });
    const outcome = await createRedisIdempotencyStore(link).reserve(KEY, runningReservation(DIGEST), TTL);
    if (!outcome.ok) throw new Error("unreachable");
    expect(outcome.value).toEqual({ kind: "held", held: { kind: "unreadable", reason: "absent" } });
  });

  it("reports MALFORMED for a value that is not JSON at all", async () => {
    const link = connection({ claim: async () => false, read: async () => "not json {" });
    const outcome = await createRedisIdempotencyStore(link).reserve(KEY, runningReservation(DIGEST), TTL);
    if (!outcome.ok) throw new Error("unreachable");
    expect(outcome.value).toEqual({ kind: "held", held: { kind: "unreadable", reason: "malformed" } });
  });

  it("reports UNPROMISED-CODE for a cached failure this major never promised", async () => {
    // The read side of the promise `execute-job.ts::settle` makes on the write
    // side. Settle refuses to CACHE a code outside the closed set; this refuses
    // to REPLAY one, because a record is read up to seven days later by a
    // process that may not be the one that wrote it.
    const link = connection({
      claim: async () => false,
      read: async () => JSON.stringify({ state: "failed", digest: DIGEST, code: "JOB_EATEN_BY_WOLVES" }),
    });
    const outcome = await createRedisIdempotencyStore(link).reserve(KEY, runningReservation(DIGEST), TTL);
    if (!outcome.ok) throw new Error("unreachable");
    expect(outcome.value).toEqual({
      kind: "held",
      held: { kind: "unreadable", reason: "unpromised-code" },
    });
  });

  it("admits a cached failure whose code IS promised", async () => {
    // The negative control for the case above: a guard that refused every cached
    // failure would satisfy it and be useless.
    const held = failedReservation(DIGEST, "JOB_TIMEOUT");
    const link = connection({ claim: async () => false, read: async () => JSON.stringify(held) });
    const outcome = await createRedisIdempotencyStore(link).reserve(KEY, runningReservation(DIGEST), TTL);
    if (!outcome.ok) throw new Error("unreachable");
    expect(outcome.value).toEqual({ kind: "held", held: { kind: "readable", reservation: held } });
  });

  it("FAILS CLOSED when the claim itself cannot be sent", async () => {
    // Treating an unreachable store as "the key is free" turns an outage into
    // duplicate side effects, which for a job that moves money is the one
    // outcome nobody can undo.
    const link = connection({
      claim: async () => {
        throw new Error("connection refused");
      },
    });
    const outcome = await createRedisIdempotencyStore(link).reserve(KEY, runningReservation(DIGEST), TTL);
    if (outcome.ok) throw new Error("unreachable");
    expect(outcome.error.code).toBe("IDEMPOTENCY_UNAVAILABLE");
  });

  it("FAILS CLOSED when the claim is refused and the incumbent cannot be read", async () => {
    // Distinct from `absent`, and the distinction is the point. `absent` is a
    // positive answer from a working store; this is no answer at all, and a
    // caller told "conflict" would act on a fact nobody established.
    const link = connection({
      claim: async () => false,
      read: async () => {
        throw new Error("read timed out");
      },
    });
    const outcome = await createRedisIdempotencyStore(link).reserve(KEY, runningReservation(DIGEST), TTL);
    if (outcome.ok) throw new Error("unreachable");
    expect(outcome.error.code).toBe("IDEMPOTENCY_UNAVAILABLE");
  });

  it("never puts the driver's message where a connection string could travel", async () => {
    // A driver error carries the URL it failed to reach, and the URL carries the
    // password. `details` is rendered into logs.
    const link = connection({
      claim: async () => {
        throw new Error("connect ECONNREFUSED redis://user:hunter2@10.0.0.4:6379");
      },
    });
    const outcome = await createRedisIdempotencyStore(link).reserve(KEY, runningReservation(DIGEST), TTL);
    if (outcome.ok) throw new Error("unreachable");
    // The message is carried; what must never be is the error OBJECT, whose
    // `stack` and driver fields hold far more. This pins the shape rather than
    // pretending the reason can be redacted without losing the incident.
    expect(typeof outcome.error.details.reason).toBe("string");
    expect(Object.keys(outcome.error.details)).toEqual(["reason"]);
  });
});

describe("settle", () => {
  it("OVERWRITES an existing reservation and never creates one", async () => {
    const link = connection({ overwrite: async () => true });
    const outcome = await createRedisIdempotencyStore(link).settle(
      KEY,
      completedReservation(DIGEST, { rows: 1 }),
      TTL,
    );
    expect(outcome).toEqual({ ok: true, value: true });
    // `claim` is NX and would refuse every settle; `write` is unconditional and
    // would resurrect an expired key, letting a request replay long after its
    // window closed. Neither may be reached from here.
    expect(link.calls).toEqual(["overwrite"]);
  });

  it("reports FALSE for a reservation that had already expired", async () => {
    // Not an error: the port documents this as survivable. What matters is that
    // nothing was written, so the expired key stays expired.
    const link = connection({ overwrite: async () => false });
    const outcome = await createRedisIdempotencyStore(link).settle(
      KEY,
      completedReservation(DIGEST, null),
      TTL,
    );
    expect(outcome).toEqual({ ok: true, value: false });
  });

  it("reports a store failure as a value rather than throwing out of the adapter", async () => {
    // `execute-job.ts` discards this result on purpose — the running reservation
    // stays fail-closed until it expires — so the failure must be a value it can
    // discard rather than an exception that would abandon a completed job.
    const link = connection({
      overwrite: async () => {
        throw new Error("connection reset");
      },
    });
    const outcome = await createRedisIdempotencyStore(link).settle(
      KEY,
      completedReservation(DIGEST, null),
      TTL,
    );
    if (outcome.ok) throw new Error("unreachable");
    expect(outcome.error.code).toBe("IDEMPOTENCY_UNAVAILABLE");
  });
});

describe("what is written", () => {
  it("round-trips every reservation shape through the value it stores", async () => {
    // The encoder and the decoder are on opposite sides of a seven-day gap and
    // of a process boundary. Anything that survives one and not the other is a
    // replay that silently becomes a re-run.
    for (const reservation of [
      runningReservation(DIGEST),
      completedReservation(DIGEST, { rows: 3 }),
      completedReservation(DIGEST, null),
      failedReservation(DIGEST, "JOB_EXECUTION_FAILED"),
    ]) {
      let stored = "";
      const writer = connection({
        claim: async (_key, value) => {
          stored = value;
          return true;
        },
      });
      await createRedisIdempotencyStore(writer).reserve(KEY, reservation, TTL);

      const reader = connection({ claim: async () => false, read: async () => stored });
      const outcome = await createRedisIdempotencyStore(reader).reserve(KEY, runningReservation(DIGEST), TTL);
      if (!outcome.ok || outcome.value.kind !== "held") throw new Error("unreachable");
      expect(outcome.value.held).toEqual({ kind: "readable", reservation });
    }
  });

  it("passes the caller's TTL to the server rather than a default of its own", async () => {
    // The port takes a TTL per call. A store that substituted its own would make
    // `IDEMPOTENCY_TTL_SECONDS` in the domain a comment.
    let seen = -1;
    const link = connection({
      claim: async (_key, _value, ttlSeconds) => {
        seen = ttlSeconds;
        return true;
      },
    });
    await createRedisIdempotencyStore(link).reserve(KEY, runningReservation(DIGEST), 604_800);
    expect(seen).toBe(604_800);
  });
});
