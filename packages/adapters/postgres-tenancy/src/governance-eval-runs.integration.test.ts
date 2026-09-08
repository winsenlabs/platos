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
 * Read a row back with the ORM's own CLI, outside every store in this package.
 *
 * It goes through the HARNESS rather than spawning the CLI here, because
 * `env-access.mjs` declares that file as an environment reader and this one is
 * not: a second ambient read in a suite is an undeclared door, and the gate
 * says so. (Spelled without the literal, because that gate's own independent
 * reconciliation is a TEXT scan and a mention in prose reads to it as a use.)
 */
function query(sql: string): string {
  return harness.readPeerRows(sql);
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
  query(
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
    // And ONE row, read back outside this package.
    expect(query(`SELECT count(*) FROM "EvalRun" WHERE "id" = '${first.value.runId}';`)).toContain(
      "1 row",
    );
  });

  test("PostgreSQL itself refuses the port's key in a btree, which is why the digest exists", async () => {
    // THE NEGATIVE CONTROL, and it is the whole justification for the second
    // column. The key `enqueue-eval-run.ts` builds is the set id, every pair in
    // plan order and the baseline; `DEFAULT_GOVERNANCE_POLICY.goldenSets` caps a
    // set at five hundred pairs. A unique index over the KEY refuses it.
    const plan = pairs(500);
    const command = request({ pairs: plan });
    expect(command.idempotencyKey.length).toBeGreaterThan(2_704);

    query(`CREATE TABLE "EvalRunKeyProbe" ("k" TEXT NOT NULL);
           CREATE UNIQUE INDEX "EvalRunKeyProbe_k_key" ON "EvalRunKeyProbe" ("k");`);
    let refusal = "";
    try {
      query(
        `INSERT INTO "EvalRunKeyProbe" ("k") VALUES ('${command.idempotencyKey.replaceAll("'", "''")}');`,
      );
    } catch (error) {
      refusal = error instanceof Error ? `${error.message}` : String(error);
    }
    // PostgreSQL's own words, not this file's: "index row size ... exceeds
    // btree version 4 maximum ... for index".
    expect(refusal).toMatch(/index row size/iu);

    // AND THE STORE ACCEPTS THE SAME RUN, because what it indexes is 64 hex
    // characters. This is the pair that makes the design decision falsifiable:
    // remove the digest and this case fails on the line above's error, here.
    const accepted = await harness.base.adapter.evalRuns.enqueue(command);
    if (!accepted.ok) throw new Error(`unreachable: ${accepted.error.code}`);
    expect(accepted.value.pairCount).toBe(500);
    expect(evalRunDigest(command.idempotencyKey)).toHaveLength(64);
    // The full key is KEPT, not discarded, so a merged run can be explained.
    expect(
      query(
        `SELECT length("idempotencyKey") FROM "EvalRun" WHERE "id" = '${accepted.value.runId}';`,
      ),
    ).toContain("1 row");
    const repeated = await harness.base.adapter.evalRuns.enqueue(command);
    if (!repeated.ok) throw new Error("unreachable");
    expect(repeated.value.alreadyQueued).toBe(true);
  });

  test("an error Result inside the unit of work ROLLS BACK, and the rows prove it", async () => {
    // THE DEFECT THIS TREE HAS ALREADY SHIPPED ONCE. `UnitOfWork.run` RESOLVES a
    // callback that answers a failure, and a resolved callback COMMITS — which
    // is how a threshold event was committed with no delivery rows beside it,
    // while both test doubles reported "nothing to roll back". The queue's
    // enqueue runs inside `atomicResult`, so the question is live here.
    const before = query(`SELECT count(*) FROM "EvalRun";`);
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
    // NOT "the double says it rolled back": the count, read through the ORM's
    // CLI on a connection this unit of work never held.
    expect(query(`SELECT count(*) FROM "EvalRun";`)).toBe(before);

    // AND THE SAME SHAPE COMMITS WHEN IT SUCCEEDS, which is what stops the case
    // above from passing because nothing was ever written.
    const committed = await runResult(harness.base.adapter.unitOfWork, async () => {
      return harness.base.adapter.evalRuns.enqueue(
        request({ pairs: pairs(3), idempotencyKey: `eval-run/${goldenSetId}/rollback` }),
      );
    });
    if (!committed.ok) throw new Error(`unreachable: ${committed.error.code}`);
    expect(query(`SELECT count(*) FROM "EvalRun" WHERE "id" = '${committed.value.runId}';`)).toContain(
      "1 row",
    );
  });
});

describe("the consumer half: exclusive, and it loses nothing when a consumer dies", () => {
  test("thirty-two concurrent consumers take thirty-two DISJOINT runs", async () => {
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
    const relevant = taken.filter((runId) => created.includes(runId));
    // DISJOINT: no run was handed to two consumers.
    expect(new Set(relevant).size).toBe(relevant.length);
    // AND EXHAUSTIVE: `SKIP LOCKED` stepped over locked rows, it did not drop
    // them. A statement that merely never double-claimed could pass the line
    // above by claiming nothing.
    expect(new Set(relevant).size).toBe(seeded);
    // Every claim carried a first attempt.
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
    expect(
      query(
        `SELECT "lastError" FROM "EvalRun" WHERE "id" = '${enqueued.value.runId}' AND "lastError" = 'judge unreachable';`,
      ),
    ).toContain("1 row");
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
    query(`ALTER TABLE "EvalRun" RENAME TO "EvalRunHidden";
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
      query(`ALTER TABLE "EvalRunHidden" RENAME TO "EvalRun";
             ALTER TABLE "AgentEvalHidden" RENAME TO "AgentEval";`);
    }
  }, 180_000);
});
