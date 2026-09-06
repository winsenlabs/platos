// TWO IDENTICAL REQUESTS RACING, ONE RESULT — against a real Redis.
//
// This is the suite WIN-260 exists to produce. Everything else about idempotency
// in this repository is provable in memory: `decideReplay` is a rule,
// `readReservation` is a decoder, and the in-memory double honours reserve-once
// because it was written to. NONE of that is evidence, because a single-threaded
// double cannot lose a race and a store that had quietly dropped its `NX` would
// satisfy every one of them.
//
// So every case here runs its contenders through SEPARATE connections, so the
// ordering is the server's and not one client's command queue, and the two
// halves of the claim are asserted together: exactly one caller ran the work,
// and BOTH callers got the same answer. A test that checked only the first would
// pass on a store that lost the loser's result; one that checked only the second
// would pass on a store that ran the job twice and happened to be deterministic.
//
// The last two cases are about TIME, and they are here rather than in the unit
// suite because a fake clock cannot refute them: `EX` expiry and the `XX`
// refusal that follows it are behaviours of the server, and the store's entire
// TTL contract is the assertion that the server has them.

import {
  asIdentifier,
  completedReservation,
  failedReservation,
  runningReservation,
  type ExecutionRequestId,
  type IdempotencyKey,
  type RequestDigest,
} from "@platos/context-jobs/application/ports/index.js";
import { afterAll, beforeAll, beforeEach, expect, test } from "vitest";

import { createRedisIdempotencyStore } from "./idempotency-store.js";
import type { RedisHarness } from "./harness.js";
import { startRedisHarness } from "./harness.js";

const DIGEST = asIdentifier<RequestDigest>("digest-a");
const OTHER_DIGEST = asIdentifier<RequestDigest>("digest-b");

let harness: RedisHarness;
let sequence = 0;

/** A fresh request id per case, so no two cases can inherit a reservation. */
function freshKey(): IdempotencyKey {
  sequence += 1;
  return {
    environmentId: "env-race",
    requestId: asIdentifier<ExecutionRequestId>(`req-${String(sequence).padStart(4, "0")}`),
  };
}

beforeAll(async () => {
  harness = await startRedisHarness();
}, 180_000);

beforeEach(async () => {
  await harness.reset();
});

afterAll(async () => {
  await harness.stop();
});

test("two identical requests racing: exactly ONE reserves, and the loser sees the winner", async () => {
  const key = freshKey();
  const contenders = [
    createRedisIdempotencyStore(harness.connect()),
    createRedisIdempotencyStore(harness.connect()),
  ];

  const outcomes = await Promise.all(
    contenders.map((store) => store.reserve(key, runningReservation(DIGEST), 60)),
  );
  const kinds = outcomes.map((outcome) => (outcome.ok ? outcome.value.kind : "failed"));

  expect(kinds.filter((kind) => kind === "reserved")).toHaveLength(1);
  expect(kinds.filter((kind) => kind === "held")).toHaveLength(1);

  // The loser sees the WINNER'S record, not an empty one. Without this the
  // caller would have to re-run the job to find out what happened.
  const loser = outcomes.find((outcome) => outcome.ok && outcome.value.kind === "held");
  if (loser === undefined || !loser.ok || loser.value.kind !== "held") throw new Error("unreachable");
  expect(loser.value.held).toEqual({ kind: "readable", reservation: runningReservation(DIGEST) });
});

test("EIGHT identical requests racing: exactly ONE reserves", async () => {
  // Two contenders can win by luck often enough that a broken store passes a
  // flaky suite. Eight, over eight connections, cannot.
  const key = freshKey();
  const stores = Array.from({ length: 8 }, () => createRedisIdempotencyStore(harness.connect()));
  const outcomes = await Promise.all(
    stores.map((store) => store.reserve(key, runningReservation(DIGEST), 60)),
  );

  const reserved = outcomes.filter((outcome) => outcome.ok && outcome.value.kind === "reserved");
  expect(reserved).toHaveLength(1);
  expect(outcomes.every((outcome) => outcome.ok)).toBe(true);
});

test("the racing losers all replay the SAME result, and the work ran ONCE", async () => {
  // The whole claim, end to end, with the side effect counted. `executions`
  // stands in for a handler: it is the thing that must happen exactly once
  // however many callers ask.
  const key = freshKey();
  let executions = 0;

  const askOnce = async (): Promise<unknown> => {
    const store = createRedisIdempotencyStore(harness.connect());
    const reserved = await store.reserve(key, runningReservation(DIGEST), 60);
    if (!reserved.ok) throw new Error("reserve failed");
    if (reserved.value.kind === "held") {
      const held = reserved.value.held;
      if (held.kind !== "readable" || held.reservation.state !== "completed") return "in-progress";
      return held.reservation.result;
    }
    executions += 1;
    const value = { rows: 42 };
    await store.settle(key, completedReservation(DIGEST, value), 60);
    return value;
  };

  // Serialised AFTER the first, so every later caller meets a SETTLED record
  // rather than a running one — which is the replay the port is for.
  const first = await askOnce();
  const rest = await Promise.all([askOnce(), askOnce(), askOnce()]);

  expect(executions).toBe(1);
  expect(first).toEqual({ rows: 42 });
  for (const result of rest) expect(result).toEqual({ rows: 42 });
});

test("a completed reservation replays its result to a later, separate connection", async () => {
  const key = freshKey();
  const writer = createRedisIdempotencyStore(harness.connect());
  await writer.reserve(key, runningReservation(DIGEST), 60);
  await writer.settle(key, completedReservation(DIGEST, { rows: 7 }), 60);

  const reader = createRedisIdempotencyStore(harness.connect());
  const outcome = await reader.reserve(key, runningReservation(DIGEST), 60);
  if (!outcome.ok || outcome.value.kind !== "held") throw new Error("unreachable");
  expect(outcome.value.held).toEqual({
    kind: "readable",
    reservation: completedReservation(DIGEST, { rows: 7 }),
  });
});

test("a NULL result is replayed as a value, not as an absence", async () => {
  // A job that legitimately produced nothing. A store that could not tell that
  // from "no record" would re-run it on every retry for seven days.
  const key = freshKey();
  const store = createRedisIdempotencyStore(harness.connect());
  await store.reserve(key, runningReservation(DIGEST), 60);
  await store.settle(key, completedReservation(DIGEST, null), 60);

  const outcome = await createRedisIdempotencyStore(harness.connect()).reserve(
    key,
    runningReservation(DIGEST),
    60,
  );
  if (!outcome.ok || outcome.value.kind !== "held") throw new Error("unreachable");
  expect(outcome.value.held).toEqual({
    kind: "readable",
    reservation: completedReservation(DIGEST, null),
  });
});

test("a cached FAILURE is replayed with the code it was stored under", async () => {
  const key = freshKey();
  const store = createRedisIdempotencyStore(harness.connect());
  await store.reserve(key, runningReservation(DIGEST), 60);
  await store.settle(key, failedReservation(DIGEST, "JOB_TIMEOUT"), 60);

  const outcome = await createRedisIdempotencyStore(harness.connect()).reserve(
    key,
    runningReservation(DIGEST),
    60,
  );
  if (!outcome.ok || outcome.value.kind !== "held") throw new Error("unreachable");
  expect(outcome.value.held).toEqual({
    kind: "readable",
    reservation: failedReservation(DIGEST, "JOB_TIMEOUT"),
  });
});

test("a record whose failure code this major never promised is REFUSED, not replayed", async () => {
  // Written straight into the keyspace, the way a peer on a different contract
  // version would write it — this store cannot produce such a record itself,
  // which is exactly why the guard has to be on the READ.
  const key = freshKey();
  const store = createRedisIdempotencyStore(harness.connect());
  const raw = harness.connect();
  await raw.write(
    store.keyFor(key),
    JSON.stringify({ state: "failed", digest: DIGEST, code: "JOB_EATEN_BY_WOLVES" }),
    60,
  );

  const outcome = await store.reserve(key, runningReservation(DIGEST), 60);
  if (!outcome.ok || outcome.value.kind !== "held") throw new Error("unreachable");
  expect(outcome.value.held).toEqual({ kind: "unreadable", reason: "unpromised-code" });
});

test("a DIFFERENT body under the same request id is reported as the winner's record", async () => {
  // The store reports; the domain decides. `decideReplay` turns this into
  // IDEMPOTENCY_CONFLICT, and it can only do that because the digest it compares
  // survived the round trip.
  const key = freshKey();
  const store = createRedisIdempotencyStore(harness.connect());
  await store.reserve(key, runningReservation(DIGEST), 60);

  const outcome = await createRedisIdempotencyStore(harness.connect()).reserve(
    key,
    runningReservation(OTHER_DIGEST),
    60,
  );
  if (!outcome.ok || outcome.value.kind !== "held") throw new Error("unreachable");
  expect(outcome.value.held).toEqual({ kind: "readable", reservation: runningReservation(DIGEST) });
});

test("the SERVER expires a reservation, and a fresh request may then reserve", async () => {
  // The port asks for "a TTL the store enforces rather than a sweep". Nothing in
  // this process ages the key; the assertion is that Redis does.
  const key = freshKey();
  const store = createRedisIdempotencyStore(harness.connect());
  const claimed = await store.reserve(key, runningReservation(DIGEST), 1);
  expect(claimed).toEqual({ ok: true, value: { kind: "reserved" } });

  await new Promise((resolve) => setTimeout(resolve, 1_400));

  const after = await store.reserve(key, runningReservation(DIGEST), 60);
  expect(after).toEqual({ ok: true, value: { kind: "reserved" } });
});

test("settle does NOT resurrect a reservation the server has already expired", async () => {
  // The `XX`. A settle that recreated the key would let a request replay long
  // after its window closed — a caller retrying an id it has forgotten the
  // meaning of would be handed a result instead of running the job.
  const key = freshKey();
  const store = createRedisIdempotencyStore(harness.connect());
  await store.reserve(key, runningReservation(DIGEST), 1);
  await new Promise((resolve) => setTimeout(resolve, 1_400));

  const settled = await store.settle(key, completedReservation(DIGEST, { rows: 1 }), 60);
  expect(settled).toEqual({ ok: true, value: false });

  // And the key really is still gone: the next caller reserves rather than
  // replaying a result that was written after the window closed.
  const after = await createRedisIdempotencyStore(harness.connect()).reserve(
    key,
    runningReservation(DIGEST),
    60,
  );
  expect(after).toEqual({ ok: true, value: { kind: "reserved" } });
});

test("two environments do not collide on one request id", async () => {
  // The environment is IN the key. Without it, one tenant's retry would replay
  // another tenant's result, which is the worst outcome this port can produce.
  const requestId = asIdentifier<ExecutionRequestId>("req-shared");
  const first: IdempotencyKey = { environmentId: "env-a", requestId };
  const second: IdempotencyKey = { environmentId: "env-b", requestId };
  const store = createRedisIdempotencyStore(harness.connect());

  expect(await store.reserve(first, runningReservation(DIGEST), 60)).toEqual({
    ok: true,
    value: { kind: "reserved" },
  });
  expect(await store.reserve(second, runningReservation(DIGEST), 60)).toEqual({
    ok: true,
    value: { kind: "reserved" },
  });
});

test("racing SETTLES of one reservation leave exactly one record, and it is readable", async () => {
  // Two workers finishing the same execution — which happens when the first is
  // slow enough that a supervisor starts another. `XX` means both write, and the
  // point is that neither creates a second key and the record stays decodable.
  const key = freshKey();
  const opener = createRedisIdempotencyStore(harness.connect());
  await opener.reserve(key, runningReservation(DIGEST), 60);

  const settlers = [
    createRedisIdempotencyStore(harness.connect()),
    createRedisIdempotencyStore(harness.connect()),
  ];
  const results = await Promise.all(
    settlers.map((store) => store.settle(key, completedReservation(DIGEST, { rows: 5 }), 60)),
  );
  expect(results.every((result) => result.ok && result.value)).toBe(true);

  const outcome = await createRedisIdempotencyStore(harness.connect()).reserve(
    key,
    runningReservation(DIGEST),
    60,
  );
  if (!outcome.ok || outcome.value.kind !== "held") throw new Error("unreachable");
  expect(outcome.value.held).toEqual({
    kind: "readable",
    reservation: completedReservation(DIGEST, { rows: 5 }),
  });
});
