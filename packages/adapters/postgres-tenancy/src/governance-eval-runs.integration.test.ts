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
//      acknowledges; the lease expires; the run comes back with `attempts`
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

  test("PostgreSQL itself refuses the port's key in a btree, which is why the digest exists", async () => {
    // THE NEGATIVE CONTROL, and it is the whole justification for the second
    // column. The key `enqueue-eval-run.ts` builds is the set id, every pair in
    // plan order and the baseline; `DEFAULT_GOVERNANCE_POLICY.goldenSets` caps a
    // set at five hundred pairs. A unique index over the KEY refuses it.
    //
    // The probe is a unique index ON THE REAL COLUMN, added and dropped through
    // the ORM's CLI. A scratch table would have been a raw mutation naming a
    // model no canonical schema claims, which `sole-writer.mjs` calls
    // UNATTRIBUTABLE and forbids outright — so the control is run against the
    // very column the design is about, which is the stronger shape anyway.
    const plan = pairs(500);
    const command = request({ pairs: plan, idempotencyKey: `eval-run/${goldenSetId}/big/${"x".repeat(4)}` });
    const wholeKey = request({ pairs: plan }).idempotencyKey;
    expect(wholeKey.length).toBeGreaterThan(2_704);

    harness.applyPeerRows(
      `CREATE UNIQUE INDEX "EvalRun_idempotencyKey_probe"
         ON "public"."EvalRun" ("environmentId", "idempotencyKey");`,
    );
    const refused = await harness.base.adapter.evalRuns.enqueue(
      request({ pairs: plan, idempotencyKey: wholeKey }),
    );
    harness.applyPeerRows(`DROP INDEX "EvalRun_idempotencyKey_probe";`);

    // PostgreSQL's own words, carried out through the port's own refusal code:
    // "index row size ... exceeds btree version 4 maximum ... for index".
    expect(refused.ok).toBe(false);
    if (refused.ok) throw new Error("unreachable");
    expect(refused.error.code).toBe("GOVERNANCE_QUEUE_UNAVAILABLE");
    expect(String(refused.error.details?.reason)).toMatch(/index row size/iu);

    // AND THE STORE ACCEPTS THE SAME RUN once the index the design does NOT
    // create is gone, because what it indexes is 64 hex characters. This is the
    // pair that makes the decision falsifiable: index the key instead of its
    // digest and the first half of this case is what production does.
    const accepted = await harness.base.adapter.evalRuns.enqueue(
      request({ pairs: plan, idempotencyKey: wholeKey }),
    );
    if (!accepted.ok) throw new Error(`unreachable: ${accepted.error.code}`);
    expect(accepted.value.pairCount).toBe(500);
    expect(evalRunDigest(wholeKey)).toHaveLength(64);
    // The full key is KEPT, not discarded, so a merged run can be explained.
    expect((await readRun(accepted.value.runId))?.keyLength).toBe(wholeKey.length);
    const repeated = await harness.base.adapter.evalRuns.enqueue(
      request({ pairs: plan, idempotencyKey: wholeKey }),
    );
    if (!repeated.ok) throw new Error("unreachable");
    expect(repeated.value.alreadyQueued).toBe(true);
    expect(command.idempotencyKey).not.toBe(wholeKey);
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
      for (const run of claim.value) expect(run.attempts).toBeGreaterThanOrEqual(1);
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
    expect(mine?.attempts).toBe(1);

    await new Promise((resolve_) => setTimeout(resolve_, 50));

    const second = await harness.base.adapter.evalRuns.claim("live-consumer", 60_000, 50);
    if (!second.ok) throw new Error("unreachable");
    const again = second.value.find((run) => run.runId === enqueued.value.runId);
    // AT-LEAST-ONCE: the run came back. `attempts` is 2, which is what
    // distinguishes a redelivery from a run that was never taken at all.
    expect(again, "the crashed consumer's run must be claimable again").toBeDefined();
    expect(again?.attempts).toBe(2);

    // AND THE DEAD CONSUMER CANNOT FINISH IT. Its acknowledgement names a lease
    // that has moved on, so it updates nothing and is told so — otherwise a
    // consumer waking after its lease expired would mark somebody else's
    // in-flight attempt done.
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
    expect(back?.attempts).toBe(2);
    expect((await readRun(enqueued.value.runId))?.lastError).toBe("judge unreachable");
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
    // with "a table is down". Here is the merge, attempted: the same table is
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
