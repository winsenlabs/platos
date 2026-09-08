// What a queue is actually judged on, against a real PostgreSQL.
//
// Every use case suite in `governance` passes against `InMemoryEvalRunQueue`
// today, and that double is a `Map`: it cannot lose a run, cannot hand one out
// twice, and has never been asked what happens when a consumer dies. So none of
// the properties below can be established anywhere but here.
//
// FIVE CLAIMS, EACH JOINED TO SOMETHING THIS FILE DOES NOT CONTROL:
//
//   1. TWO CONSUMERS CANNOT TAKE THE SAME RUN. Real concurrency — N claims
//      issued with `Promise.all` on one pool — and the join is PostgreSQL's own
//      `FOR UPDATE SKIP LOCKED`, plus the arithmetic that the claimed sets are
//      disjoint AND exhaustive.
//   2. A CRASH BETWEEN CLAIM AND ACK LOSES NOTHING. The consumer never
//      acknowledges; the lease expires; the run comes back with `deliveries`
//      INCREMENTED, which is what tells at-least-once from at-most-once.
//   3. AN ERROR RESULT INSIDE THE UNIT OF WORK ROLLS BACK. This is the defect
//      the tree has already paid for once — a threshold event committed with no
//      delivery rows, because `run` RESOLVES an error `Result` and a resolved
//      callback COMMITS. Proved by counting rows in the database AFTER the
//      failure, not by asking a double what it rolled back.
//   4. THE IDEMPOTENCY KEY DOES NOT FIT IN A BTREE INDEX. At this context's own
//      five-hundred-pair ceiling the port's key is tens of kilobytes; the join
//      is PostgreSQL refusing a unique index row over 2704 bytes, exhibited as a
//      negative control against the same live database, and the store answering
//      correctly for the same run.
//   5. THE TWO REFUSAL CODES ARE SEPARABLE. One induced outage, two ports, two
//      codes — which is the claim `governance-repository.ts` used to give as the
//      reason this port could not live here at all.

import type {
  EnvironmentScope,
  EvalPair,
  EvalRunRequest,
} from "@platos/context-governance/application/ports/index.js";
import { asGovernanceIdentifier, err, runResult } from "@platos/context-governance/application/ports/index.js";
import { domainError } from "@platos/kernel";
import { afterAll, beforeAll, describe, expect, test } from "vitest";

import { evalRunDigest } from "./governance-eval-runs.js";
import { startGovernanceHarness, type GovernanceHarness, type PeerChain } from "./governance-harness.js";

let harness: GovernanceHarness;
let scope: EnvironmentScope;
let chain: PeerChain;
let goldenSetId: string;

/**
 * Count the rows, on the POOL and outside every transaction this suite opens.
 *
 * `prisma db execute` — which `governance-harness.ts` uses to seed peers — is
 * deliberately NOT used to read: it answers "Script executed successfully" and
 * discards the result set, so an assertion on its output is an assertion on
 * nothing. This was found by running the suite rather than by reading it.
 *
 * A STATIC TAGGED TEMPLATE with interpolated VALUES, which is what
 * `scripts/arch/sole-writer.mjs` can attribute; SQL assembled at run time is
 * UNATTRIBUTABLE and no package may issue it. It is a read, so the gate exempts
 * it either way.
 */
async function countRuns(): Promise<number> {
  const rows = await harness.base.client.$queryRaw<readonly { readonly total: bigint }[]>`
    SELECT count(*)::bigint AS "total" FROM "public"."EvalRun"`;
  return Number(rows[0]?.total ?? 0n);
}

/** One run's stored row, or null. The same pool, outside every transaction. */
async function readRun(
  runId: string,
): Promise<{ readonly lastError: string | null; readonly keyLength: number } | null> {
  const rows = await harness.base.client.$queryRaw<
    readonly { readonly lastError: string | null; readonly keyLength: number }[]
  >`
    SELECT run."lastError" AS "lastError",
           length(run."idempotencyKey")::int AS "keyLength"
    FROM "public"."EvalRun" AS run
    WHERE run."id" = ${runId}::uuid`;
  return rows[0] ?? null;
}

/**
 * A plan whose identifiers are all DIFFERENT, in the shape the schema stores.
 *
 * `pairs()` below repeats one thread id, which is what a real golden set does —
 * twenty threads by twenty-five criteria is five hundred pairs over forty-five
 * distinct identifiers. This one is the opposite extreme, and the two are here
 * because the btree case measured a difference between them that nothing in the
 * port or the schema predicts. Deterministic, so a failure reproduces.
 */
function distinctPairs(count: number): readonly EvalPair[] {
  const hex = (seed: number): string => {
    let value = seed * 2_654_435_761;
    let out = "";
    while (out.length < 32) {
      value = (value * 1_103_515_245 + 12_345) >>> 0;
      out += value.toString(16).padStart(8, "0");
    }
    return `${out.slice(0, 8)}-${out.slice(8, 12)}-4${out.slice(13, 16)}-8${out.slice(17, 20)}-${out.slice(20, 32)}`;
  };
  return Array.from({ length: count }, (_unused, index) => ({
    threadId: asGovernanceIdentifier(hex(index * 2 + 1)),
    criterionId: asGovernanceIdentifier(hex(index * 2 + 2)),
  })) as readonly EvalPair[];
}

function pairs(count: number): readonly EvalPair[] {
  return Array.from({ length: count }, (_unused, index) => ({
    threadId: asGovernanceIdentifier(chain.threadId),
    criterionId: asGovernanceIdentifier(
      `0000${String(index).padStart(4, "0")}-0000-4000-8000-000000000000`.slice(-36),
    ),
  })) as readonly EvalPair[];
}

function request(overrides: Partial<EvalRunRequest> = {}): EvalRunRequest {
  const plan = overrides.pairs ?? pairs(2);
  return {
    scope,
    goldenSetId: asGovernanceIdentifier(goldenSetId),
    agentId: asGovernanceIdentifier(chain.agentId),
    pairs: plan,
    baselineVersionId: null,
    requestedBy: asGovernanceIdentifier("fixture-operator"),
    idempotencyKey: `eval-run/${goldenSetId}/no-baseline/${plan
      .map((pair) => `${pair.threadId}:${pair.criterionId}`)
      .join("|")}`,
    ...overrides,
  };
}

beforeAll(async () => {
  harness = await startGovernanceHarness();
  scope = await harness.freshScope();
  chain = await harness.seedChain(scope);
  goldenSetId = harness.base.freshId("00e1");
  // Seeded with the ORM's CLI rather than through `goldenSets.create`, for the
  // reason `governance-harness.ts` gives about mixing two mechanisms in one
  // fixture: this suite is about the queue, and a golden set that failed to
  // admit would be a failure in a port this suite is not testing.
  harness.applyPeerRows(
    `INSERT INTO "GoldenSet" ("id", "environmentId", "agentId", "name", "threadIds", "criterionIds", "createdBy", "createdAt", "updatedAt")
     VALUES ('${goldenSetId}', '${scope.environmentId}', '${chain.agentId}', 'regression',
             ARRAY['${chain.threadId}']::text[], ARRAY[]::text[], 'fixture',
             '2026-05-01T09:00:00Z', '2026-05-01T09:00:00Z');`,
  );
}, 300_000);

afterAll(async () => {
  await harness?.stop();
});

describe("the enqueue half: idempotent, and bounded by what a btree can index", () => {
  test("a repeated key costs one run and the second answer says so", async () => {
    const command = request();
    const first = await harness.base.adapter.evalRuns.enqueue(command);
    const second = await harness.base.adapter.evalRuns.enqueue(command);

    if (!first.ok || !second.ok) throw new Error("unreachable");
    expect(first.value.alreadyQueued).toBe(false);
    expect(second.value.alreadyQueued).toBe(true);
    expect(second.value.runId).toBe(first.value.runId);
    expect(second.value.pairCount).toBe(2);
    // And ONE row, read back on the pool rather than taken from the answer.
    expect(await readRun(first.value.runId)).not.toBeNull();
  });

  test("whether the port's key fits a btree depends on how it COMPRESSES, and the digest removes the question", async () => {
    // THIS CASE WAS WRITTEN TO ASSERT SOMETHING SIMPLER AND MEASURED SOMETHING
    // WORSE, TWICE. The claim was "the port's key cannot be a unique index,
    // because at the five-hundred-pair ceiling it is ~37 kB and a btree index
    // row may not exceed ~2704 bytes". Both halves were wrong against a real
    // PostgreSQL 16:
    //
    //   * A unique index over the real column ACCEPTED the 37 kB key, because
    //     PostgreSQL compresses an index datum before measuring it and
    //     `enqueue-eval-run.ts` builds the key by joining
    //     `<threadId>:<criterionId>` — a string that repeats one thread id
    //     twenty-five times over in any real set.
    //   * The refusal, when it does come, is NOT the 2704-byte "btree version 4
    //     maximum". It is the index-tuple limit, and PostgreSQL's own words are
    //     `index row requires 19440 bytes, maximum size is 8191` under SQLSTATE
    //     54000. The number quoted from memory was the wrong one; this is the
    //     one the database raises, and the case matches its shape rather than a
    //     phrase.
    //
    // So the limit is not reached by LENGTH, it is reached by ENTROPY, and that
    // is the worse property: an install would meet it on some golden sets and
    // not others, with no rule at the port or the schema to predict which. Both
    // halves are measured below, against the same index, on the same column.
    const repetitive = request({ pairs: pairs(500), idempotencyKey: `eval-run/${goldenSetId}/compressible` });
    const distinct = request({
      pairs: distinctPairs(500),
      idempotencyKey: `eval-run/${goldenSetId}/${distinctPairs(500)
        .map((pair) => `${pair.threadId}:${pair.criterionId}`)
        .join("|")}`,
    });
    expect(distinct.idempotencyKey.length).toBeGreaterThan(8_191);
    expect(repetitive.idempotencyKey.length).toBeLessThan(distinct.idempotencyKey.length * 2);

    harness.applyPeerRows(
      `CREATE UNIQUE INDEX "EvalRun_idempotencyKey_probe"
         ON "public"."EvalRun" ("environmentId", "idempotencyKey");`,
    );
    const compressible = await harness.base.adapter.evalRuns.enqueue(repetitive);
    const incompressible = await harness.base.adapter.evalRuns.enqueue(distinct);
    harness.applyPeerRows(`DROP INDEX "EvalRun_idempotencyKey_probe";`);

    // A key that compresses gets in. A key of the same length that does not is
    // refused, in PostgreSQL's own words, carried out under the port's own code.
    expect(compressible.ok).toBe(true);
    expect(incompressible.ok).toBe(false);
    if (incompressible.ok) throw new Error("unreachable");
    expect(incompressible.error.code).toBe("GOVERNANCE_QUEUE_UNAVAILABLE");
    expect(String(incompressible.error.details?.reason)).toMatch(
      /index row requires \d+ bytes, maximum size is \d+/iu,
    );

    // AND THE DIGEST REMOVES THE QUESTION. With the probe index gone, the SAME
    // run the index refused is accepted, and a repeat of it answers
    // `alreadyQueued` — because what the design indexes is 64 hex characters
    // whatever the key's length or entropy.
    const accepted = await harness.base.adapter.evalRuns.enqueue(distinct);
    if (!accepted.ok) throw new Error(`unreachable: ${accepted.error.code}`);
    expect(accepted.value.pairCount).toBe(500);
    expect(evalRunDigest(distinct.idempotencyKey)).toHaveLength(64);
    // The full key is KEPT, not discarded, so a merged run can be explained.
    expect((await readRun(accepted.value.runId))?.keyLength).toBe(distinct.idempotencyKey.length);
    const repeated = await harness.base.adapter.evalRuns.enqueue(distinct);
    if (!repeated.ok) throw new Error("unreachable");
    expect(repeated.value.alreadyQueued).toBe(true);
    expect(repeated.value.runId).toBe(accepted.value.runId);
  }, 180_000);

  test("a digest that matches a DIFFERENT key is refused, not answered alreadyQueued", async () => {
    // A SHA-256 collision has never been exhibited, so the branch that compares
    // the stored key cannot be reached by finding one. It can be reached by
    // WRITING one: a row whose digest is `digest(K)` and whose key is not `K`
    // is exactly what a collision would look like to this store, and the ORM's
    // CLI can put it there. Without this the branch is unfalsifiable and would
    // have to be declared so.
    //
    // WHAT IT PROTECTS. Answering `alreadyQueued: true` for a run that is not
    // the same run tells the caller its fan-out is already in flight, writes no
    // row, and leaves nothing to score it — a silent no-op, which is the worst
    // answer available here.
    const command = request({ pairs: pairs(2), idempotencyKey: `eval-run/${goldenSetId}/collision` });
    const forged = harness.base.freshId("00e2");
    harness.applyPeerRows(
      `INSERT INTO "EvalRun" ("id", "environmentId", "goldenSetId", "agentId", "requestedBy",
                              "idempotencyKey", "idempotencyDigest", "pairCount",
                              "pairThreadIds", "pairCriterionIds",
                              "status", "deliveries", "createdAt", "updatedAt")
       VALUES ('${forged}', '${scope.environmentId}', '${goldenSetId}', '${chain.agentId}', 'fixture',
               'a completely different run', '${evalRunDigest(command.idempotencyKey)}', 1,
               ARRAY['${chain.threadId}']::text[], ARRAY['${chain.threadId}']::text[],
               'QUEUED', 0, '2026-05-01T09:00:00Z', '2026-05-01T09:00:00Z');`,
    );

    const answered = await harness.base.adapter.evalRuns.enqueue(command);
    expect(answered.ok).toBe(false);
    if (answered.ok) throw new Error("unreachable");
    expect(answered.error.code).toBe("GOVERNANCE_QUEUE_UNAVAILABLE");
    expect(String(answered.error.details?.reason)).toContain("digest_collision");
  }, 180_000);

  test("an error Result inside the unit of work ROLLS BACK, and the rows prove it", async () => {
    // THE DEFECT THIS TREE HAS ALREADY SHIPPED ONCE. `UnitOfWork.run` RESOLVES a
    // callback that answers a failure, and a resolved callback COMMITS — which
    // is how a threshold event was committed with no delivery rows beside it,
    // while both test doubles reported "nothing to roll back". The queue's
    // enqueue runs inside `atomicResult`, so the question is live here.
    const before = await countRuns();
    const refusal = domainError("GOVERNANCE_QUEUE_UNAVAILABLE", "conflict", "caller refused after enqueueing");
    const failed = await runResult(harness.base.adapter.unitOfWork, async () => {
      const enqueued = await harness.base.adapter.evalRuns.enqueue(
        request({ pairs: pairs(3), idempotencyKey: `eval-run/${goldenSetId}/rollback` }),
      );
      if (!enqueued.ok) throw new Error(`unreachable: ${enqueued.error.code}`);
      // The run IS written at this point — the case below commits the same
      // shape — and then the unit of work fails for a reason of the CALLER's,
      // exactly as `enqueue-eval-run.ts` would if a later step refused.
      return err<never>(refusal);
    });

    expect(failed.ok).toBe(false);
    // NOT "the double says it rolled back": the count, read on the pool after
    // the transaction ended. `InMemoryEvalRunQueue` has no commit to observe,
    // which is why this claim cannot be made anywhere but here.
    expect(await countRuns()).toBe(before);

    // AND THE SAME SHAPE COMMITS WHEN IT SUCCEEDS, which is what stops the case
    // above from passing because nothing was ever written.
    const committed = await runResult(harness.base.adapter.unitOfWork, async () => {
      return harness.base.adapter.evalRuns.enqueue(
        request({ pairs: pairs(3), idempotencyKey: `eval-run/${goldenSetId}/rollback` }),
      );
    });
    if (!committed.ok) throw new Error(`unreachable: ${committed.error.code}`);
    expect(await readRun(committed.value.runId)).not.toBeNull();
    expect(await countRuns()).toBe(before + 1);
  });
});

describe("the consumer half: exclusive, and it loses nothing when a consumer dies", () => {
  test("thirty-two concurrent consumers never take one run twice, and lose none", async () => {
    const seeded = 32;
    const created: string[] = [];
    for (let index = 0; index < seeded; index += 1) {
      const enqueued = await harness.base.adapter.evalRuns.enqueue(
        request({
          pairs: pairs(1),
          idempotencyKey: `eval-run/${goldenSetId}/concurrency/${String(index)}`,
        }),
      );
      if (!enqueued.ok) throw new Error(`unreachable: ${enqueued.error.code}`);
      created.push(enqueued.value.runId);
    }

    // REAL CONCURRENCY, NOT A SEQUENTIAL LOOP. Every claim is in flight at once
    // on the same pool, which is the only arrangement in which two consumers can
    // reach one row's window.
    const claims = await Promise.all(
      Array.from({ length: seeded }, (_unused, index) =>
        harness.base.adapter.evalRuns.claim(`consumer-${String(index)}`, 60_000, 1),
      ),
    );

    const taken: string[] = [];
    for (const claim of claims) {
      if (!claim.ok) throw new Error(`unreachable: ${claim.error.code}`);
      for (const run of claim.value) taken.push(run.runId);
    }
    const concurrent = taken.filter((runId) => created.includes(runId));
    // THE SAFETY PROPERTY, and it is absolute: no run reached two consumers.
    expect(new Set(concurrent).size).toBe(concurrent.length);
    // Non-vacuous: the pass really did hand work out.
    expect(concurrent.length).toBeGreaterThan(0);

    // AND NOW THE PROPERTY THIS CASE WAS FIRST WRITTEN TO ASSERT AND WHICH IS
    // NOT TRUE. It read `expect(new Set(concurrent).size).toBe(seeded)` — "every
    // run was taken in one concurrent pass" — and MEASURED 30 of 32 on a real
    // PostgreSQL 16. That is `SKIP LOCKED` behaving exactly as specified: a
    // claim that steps over a row another transaction has locked, holding
    // `LIMIT 1`, comes back EMPTY. Two consumers went away with nothing while
    // two runs stayed QUEUED.
    //
    // The honest claim is therefore in two halves: a concurrent batch may be
    // UNDER-FILLED, and nothing is LOST. The drain below is the second half —
    // it claims until the queue is empty and the union must be all thirty-two,
    // still with no run taken twice.
    const drained: string[] = [...concurrent];
    for (let round = 0; round < seeded && new Set(drained).size < seeded; round += 1) {
      const more = await harness.base.adapter.evalRuns.claim(`drain-${String(round)}`, 60_000, seeded);
      if (!more.ok) throw new Error(`unreachable: ${more.error.code}`);
      for (const run of more.value) {
        if (created.includes(run.runId)) drained.push(run.runId);
      }
      if (more.value.length === 0) break;
    }
    expect(new Set(drained).size).toBe(seeded);
    // Still no double-hand, across the concurrent pass AND the drain: the only
    // repeats are redeliveries of runs whose lease this suite never released,
    // and there are none, because every lease above is sixty seconds.
    expect(drained.length).toBe(seeded);

    for (const claim of claims) {
      if (!claim.ok) throw new Error("unreachable");
      for (const run of claim.value) expect(run.deliveries).toBeGreaterThanOrEqual(1);
    }
  }, 180_000);

  test("a consumer that dies between claiming and acknowledging loses no run", async () => {
    const enqueued = await harness.base.adapter.evalRuns.enqueue(
      request({ pairs: pairs(1), idempotencyKey: `eval-run/${goldenSetId}/crash` }),
    );
    if (!enqueued.ok) throw new Error(`unreachable: ${enqueued.error.code}`);

    // Claimed under a lease that has ALREADY expired by the time the next claim
    // runs. This is the crash: no acknowledgement, ever.
    const first = await harness.base.adapter.evalRuns.claim("doomed-consumer", 1, 50);
    if (!first.ok) throw new Error("unreachable");
    const mine = first.value.find((run) => run.runId === enqueued.value.runId);
    expect(mine, "the run must have been handed out once").toBeDefined();
    expect(mine?.deliveries).toBe(1);

    await new Promise((resolve_) => setTimeout(resolve_, 50));

    const second = await harness.base.adapter.evalRuns.claim("live-consumer", 60_000, 50);
    if (!second.ok) throw new Error("unreachable");
    const again = second.value.find((run) => run.runId === enqueued.value.runId);
    // AT-LEAST-ONCE: the run came back. `deliveries` is 2, which is what
    // distinguishes a redelivery from a run that was never taken at all.
    expect(again, "the crashed consumer's run must be claimable again").toBeDefined();
    expect(again?.deliveries).toBe(2);

    // AND THE DEAD CONSUMER CANNOT FINISH IT. Its acknowledgement names a lease
    // that has moved on, so it updates nothing and is told so — otherwise a
    // consumer waking after its lease expired would mark somebody else's
    // in-flight delivery done.
    const late = await harness.base.adapter.evalRuns.acknowledge(enqueued.value.runId, "doomed-consumer");
    if (!late.ok) throw new Error("unreachable");
    expect(late.value).toBe(false);

    const finished = await harness.base.adapter.evalRuns.acknowledge(
      enqueued.value.runId,
      "live-consumer",
    );
    if (!finished.ok) throw new Error("unreachable");
    expect(finished.value).toBe(true);
    // A finished run is not handed out again.
    const after = await harness.base.adapter.evalRuns.claim("third-consumer", 60_000, 50);
    if (!after.ok) throw new Error("unreachable");
    expect(after.value.map((run) => run.runId)).not.toContain(enqueued.value.runId);
  }, 180_000);

  test("an abandoned run goes back to the queue with its reason recorded", async () => {
    const enqueued = await harness.base.adapter.evalRuns.enqueue(
      request({ pairs: pairs(1), idempotencyKey: `eval-run/${goldenSetId}/abandon` }),
    );
    if (!enqueued.ok) throw new Error("unreachable");
    const claimed = await harness.base.adapter.evalRuns.claim("flaky", 60_000, 50);
    if (!claimed.ok) throw new Error("unreachable");
    expect(claimed.value.map((run) => run.runId)).toContain(enqueued.value.runId);

    const given = await harness.base.adapter.evalRuns.abandon(
      enqueued.value.runId,
      "flaky",
      "judge unreachable",
    );
    if (!given.ok) throw new Error("unreachable");
    expect(given.value).toBe(true);

    const retaken = await harness.base.adapter.evalRuns.claim("steady", 60_000, 50);
    if (!retaken.ok) throw new Error("unreachable");
    const back = retaken.value.find((run) => run.runId === enqueued.value.runId);
    expect(back?.deliveries).toBe(2);
    expect((await readRun(enqueued.value.runId))?.lastError).toBe("judge unreachable");
  }, 180_000);

  test("a consumer past its lease cannot ABANDON the run another consumer now holds", async () => {
    // FOUND BY MUTATION, NOT BY READING. Deleting `leaseOwner` from
    // `abandon`'s predicate left every case in this file green, and the
    // acknowledge half was already pinned — so the two halves of the same rule
    // had one proof between them. The failure mode is worse on this side:
    // acknowledging somebody else's delivery marks it DONE, abandoning it puts a
    // run another consumer is actively scoring back on the queue, so the fan-out
    // is paid for twice.
    const enqueued = await harness.base.adapter.evalRuns.enqueue(
      request({ pairs: pairs(1), idempotencyKey: `eval-run/${goldenSetId}/abandon-fence` }),
    );
    if (!enqueued.ok) throw new Error("unreachable");

    const stale = await harness.base.adapter.evalRuns.claim("stale-consumer", 1, 50);
    if (!stale.ok) throw new Error("unreachable");
    expect(stale.value.map((run) => run.runId)).toContain(enqueued.value.runId);
    await new Promise((wait) => setTimeout(wait, 50));

    const holder = await harness.base.adapter.evalRuns.claim("holding-consumer", 60_000, 50);
    if (!holder.ok) throw new Error("unreachable");
    expect(holder.value.map((run) => run.runId)).toContain(enqueued.value.runId);

    const stolen = await harness.base.adapter.evalRuns.abandon(
      enqueued.value.runId,
      "stale-consumer",
      "woke up late",
    );
    if (!stolen.ok) throw new Error("unreachable");
    expect(stolen.value).toBe(false);
    // The holder still holds it: nothing was put back on the queue underneath it.
    expect((await readRun(enqueued.value.runId))?.lastError).toBeNull();
    const interloper = await harness.base.adapter.evalRuns.claim("interloper", 60_000, 50);
    if (!interloper.ok) throw new Error("unreachable");
    expect(interloper.value.map((run) => run.runId)).not.toContain(enqueued.value.runId);
  }, 180_000);

  test("sixteen concurrent enqueues of one key cost ONE run", async () => {
    // The port's own sentence: "a double-clicked `run` button costs one run and
    // the second answer says `alreadyQueued`". Sequentially that is a read
    // followed by an insert; CONCURRENTLY the read can miss for every caller at
    // once, and what decides the outcome is the unique index plus
    // `skipDuplicates` — a raise there would take the caller's transaction away
    // along with the answer.
    const command = request({
      pairs: pairs(2),
      idempotencyKey: `eval-run/${goldenSetId}/double-click`,
    });
    const answers = await Promise.all(
      Array.from({ length: 16 }, () => harness.base.adapter.evalRuns.enqueue(command)),
    );

    const runIds = new Set<string>();
    let fresh = 0;
    for (const answer of answers) {
      if (!answer.ok) throw new Error(`unreachable: ${answer.error.code}`);
      runIds.add(answer.value.runId);
      if (!answer.value.alreadyQueued) fresh += 1;
    }
    // ONE run, ONE identifier handed to all sixteen, and exactly one of them
    // told it was the first.
    expect(runIds.size).toBe(1);
    expect(fresh).toBe(1);
  }, 180_000);

  test("the queue is FIFO: the oldest run is claimed first", async () => {
    // FOUND BY MUTATION. Deleting the `ORDER BY` from the claim left every case
    // green, while the statement's own comment says "`LIMIT` without a total
    // order takes an arbitrary subset". Without this, a run enqueued first could
    // sit behind every later one indefinitely — a starvation nothing else here
    // would notice, because every other case claims the whole queue at once.
    const scoped = await harness.freshScope();
    const peer = await harness.seedChain(scoped);
    const set = harness.base.freshId("00e3");
    harness.applyPeerRows(
      `INSERT INTO "GoldenSet" ("id", "environmentId", "agentId", "name", "threadIds", "criterionIds", "createdBy", "createdAt", "updatedAt")
       VALUES ('${set}', '${scoped.environmentId}', '${peer.agentId}', 'fifo',
               ARRAY['${peer.threadId}']::text[], ARRAY[]::text[], 'fixture',
               '2026-05-01T09:00:00Z', '2026-05-01T09:00:00Z');`,
    );

    const order: string[] = [];
    for (const label of ["first", "second", "third"]) {
      const enqueued = await harness.base.adapter.evalRuns.enqueue({
        scope: scoped,
        goldenSetId: asGovernanceIdentifier(set),
        agentId: asGovernanceIdentifier(peer.agentId),
        pairs: pairs(1),
        baselineVersionId: null,
        requestedBy: asGovernanceIdentifier("fixture-operator"),
        idempotencyKey: `eval-run/${set}/fifo/${label}`,
      });
      if (!enqueued.ok) throw new Error(`unreachable: ${enqueued.error.code}`);
      order.push(enqueued.value.runId);
    }

    // ONE AT A TIME, and for as many rounds as it takes. The claim statement is
    // deliberately install-wide — a dispatcher drains every environment — so
    // earlier cases in this file have left QUEUED runs that are OLDER than these
    // three and come out first. What is asserted is therefore the SUBSEQUENCE:
    // among these three, the order is the order they were enqueued in.
    const seen: string[] = [];
    for (let round = 0; round < 60 && seen.length < order.length; round += 1) {
      const claim = await harness.base.adapter.evalRuns.claim(`fifo-${String(round)}`, 60_000, 1);
      if (!claim.ok) throw new Error("unreachable");
      if (claim.value.length === 0) break;
      for (const run of claim.value) {
        if (order.includes(run.runId)) seen.push(run.runId);
      }
    }
    // An array, not a set: `toEqual` is what makes this about ORDER.
    expect(seen).toEqual(order);

    // AND THE STATEMENT THE DRIVER ACTUALLY SENT, because the OUTCOME above
    // cannot separate a claim that ORDERS from one that does not. Deleting the
    // `ORDER BY` leaves every assertion in this file green: a small heap with no
    // deletes is scanned in insertion order, so FIFO is what PostgreSQL happens
    // to do rather than what this statement asks for. The property is not
    // observable at this scale and manufacturing a scale where it is would be
    // measuring the planner, so the join is to the SQL on the wire — the same
    // shape `agents-statements.integration.test.ts` uses for its `FOR UPDATE OF`.
    harness.base.resetStatements();
    const observed = await harness.base.adapter.evalRuns.claim("statement-probe", 60_000, 1);
    if (!observed.ok) throw new Error("unreachable");
    const sql = harness.base.statements().join(" ");
    expect(sql).toMatch(/ORDER BY[\s\S]*"createdAt" ASC[\s\S]*"id" ASC/iu);
    // The two halves of the claim's guarantee, in one statement: the order and
    // the exclusivity. Neither is observable from the rows alone.
    expect(sql).toMatch(/FOR UPDATE SKIP LOCKED/iu);
  }, 180_000);

  test("a claim that cannot bound anything is refused before a statement is sent", async () => {
    // FOUND BY MUTATION TOO: the three guards were unreachable from this suite.
    // A blank owner is the one that matters — it writes `leaseOwner = ''`, and
    // every OTHER consumer that also passed a blank owner would then pass the
    // ownership fences on `acknowledge` and `abandon`, which is the whole
    // protection those two predicates exist for.
    for (const [owner, leaseMs, limit] of [
      ["", 60_000, 1],
      ["consumer", 0, 1],
      ["consumer", 60_000, 0],
    ] as const) {
      const refused = await harness.base.adapter.evalRuns.claim(owner, leaseMs, limit);
      expect([owner, leaseMs, limit, refused.ok]).toEqual([owner, leaseMs, limit, false]);
      if (refused.ok) throw new Error("unreachable");
      expect(refused.error.code).toBe("GOVERNANCE_QUEUE_UNAVAILABLE");
      expect(String(refused.error.details?.reason)).toContain("eval_run_lease_invalid");
    }
  }, 180_000);

  test("the claim reads the plan back as pairs, in the order it was planned", async () => {
    const plan = pairs(4);
    const enqueued = await harness.base.adapter.evalRuns.enqueue(
      request({ pairs: plan, idempotencyKey: `eval-run/${goldenSetId}/order` }),
    );
    if (!enqueued.ok) throw new Error("unreachable");
    const claimed = await harness.base.adapter.evalRuns.claim("reader", 60_000, 50);
    if (!claimed.ok) throw new Error("unreachable");
    const mine = claimed.value.find((run) => run.runId === enqueued.value.runId);
    expect(mine?.pairs).toEqual(plan);
    expect(mine?.pairCount).toBe(4);
  }, 180_000);
});

describe("the two refusal codes the old objection said could not stay apart", () => {
  test("ONE outage, TWO ports, TWO codes, in one process against one database", async () => {
    // The objection in `governance-repository.ts` was that satisfying this port
    // from the canonical store would merge "the dispatcher refused the work"
    // with "a table is down". Here is the merge, tried: the same table is
    // taken away from BOTH ports at once.
    harness.applyPeerRows(`ALTER TABLE "EvalRun" RENAME TO "EvalRunHidden";
           ALTER TABLE "AgentEval" RENAME TO "AgentEvalHidden";`);
    try {
      const queued = await harness.base.adapter.evalRuns.enqueue(
        request({ pairs: pairs(1), idempotencyKey: `eval-run/${goldenSetId}/outage` }),
      );
      expect(queued.ok).toBe(false);
      if (queued.ok) throw new Error("unreachable");
      expect(queued.error.code).toBe("GOVERNANCE_QUEUE_UNAVAILABLE");

      const scored = await harness.base.adapter.evals.page(scope, {
        agentId: null,
        agentVersionId: null,
        criterionId: null,
        threadId: null,
        since: new Date("2026-01-01T00:00:00.000Z"),
        search: null,
        offset: 0,
        limit: 1,
      });
      expect(scored.ok).toBe(false);
      if (scored.ok) throw new Error("unreachable");
      expect(scored.error.code).toBe("GOVERNANCE_LEDGER_UNAVAILABLE");

      // The point, stated as one assertion: the codes DIFFER under one cause.
      expect(queued.error.code).not.toBe(scored.error.code);
    } finally {
      harness.applyPeerRows(`ALTER TABLE "EvalRunHidden" RENAME TO "EvalRun";
             ALTER TABLE "AgentEvalHidden" RENAME TO "AgentEval";`);
    }
  }, 180_000);
});
