// Statement counts, MEASURED — the N+1 control for `governance`'s reads.
//
// EVERY PIN IS TAKEN TWICE, over a small environment and one an order of
// magnitude larger, and both must be identical. A read whose cost grows with the
// rows it returns is correct in every case and expensive in exactly one: the
// installation that has been running longest. Two of these reads are the ones a
// dashboard opens with — `SafetyLedger.page` and `EvalsRepository.page` — and
// two more fold every row in a window without paging at all, which is where a
// per-row query would be invisible until it was slow.
//
// THE SUBJECT READS ARE THE INTERESTING PIN. `countSubject` and
// `anonymizeSubject` take a TENANT scope, and a row stores only its environment,
// so the containment is a relation filter through `Environment` and `Project`
// resolved inside the same statement. The obvious wrong implementation — read
// the environments the scope reaches, then one query per environment — is an
// N+1 in the tenant tree rather than in the rows, and it is measured here at an
// ORGANIZATION scope precisely so the widening cannot hide.
//
// THE PROBE PATTERN IS ANCHORED, and this is tranche 3's trap rather than a
// precaution. Its advisory lock projected `SELECT 1`, which is exactly the shape
// the statement suites strip to discard the driver's connection probe, so the
// lock was measured at ZERO statements and a mutation that removed it survived.
// The filter below anchors the probe to a statement that is ONLY `SELECT 1`, and
// every measurement records the unfiltered count beside the filtered one.

import { afterAll, beforeAll, describe, expect, test } from "vitest";

import type {
  ActorId,
  AgentId,
  EndUserId,
  EnvironmentScope,
  EvalCriterionId,
  TurnId,
} from "@platos/context-governance/application/ports/index.js";
import { asGovernanceIdentifier } from "@platos/context-governance/application/ports/index.js";

import {
  conformanceCriterion,
  conformanceEval,
  conformanceSafetyEvent,
  type GovernanceConformanceIds,
} from "./governance-conformance.js";
import type { GovernanceHarness, PeerChain } from "./governance-harness.js";
import { startGovernanceHarness } from "./governance-harness.js";

let harness: GovernanceHarness;

const actor = asGovernanceIdentifier<ActorId>("operator-1");
const SINCE = new Date("2026-01-01T00:00:00.000Z");

interface Fixture {
  readonly scope: EnvironmentScope;
  readonly chain: PeerChain;
  readonly ids: GovernanceConformanceIds;
  readonly criterionId: EvalCriterionId;
  readonly evalIds: readonly string[];
}

let small: Fixture;
let large: Fixture;

/**
 * Statements the CLIENT sent, less the transaction frame.
 *
 * `BEGIN`/`COMMIT`/`ROLLBACK`/`DEALLOCATE` are the driver's bookkeeping and are
 * not what an N+1 is made of. `SELECT 1` is the driver's connection probe and is
 * matched ONLY when the whole statement is that and nothing else, so a read that
 * genuinely projects a constant cannot be discarded by the thing measuring it.
 */
function queries(): readonly string[] {
  return harness.base
    .statements()
    .filter(
      (statement) =>
        !/^\s*(BEGIN|COMMIT|ROLLBACK|DEALLOCATE)\b/iu.test(statement) &&
        !/^\s*SELECT\s+1\s*$/iu.test(statement),
    );
}

interface Measurement {
  readonly counted: number;
  readonly total: number;
}

async function measure(work: () => Promise<unknown>): Promise<Measurement> {
  harness.base.resetStatements();
  await work();
  return { counted: queries().length, total: harness.base.statements().length };
}

/** One environment carrying `events` safety rows, `ratings` votes and `evals` evals. */
async function seedFixture(events: number, evals: number): Promise<Fixture> {
  const scope = await harness.freshScope();
  const chain = await harness.seedChain(scope);
  const ids: GovernanceConformanceIds = {
    agentId: chain.agentId,
    agentVersionId: chain.agentVersionId,
    secondAgentVersionId: chain.secondAgentVersionId,
    endUserId: chain.endUserId,
    threadId: chain.threadId,
    turnId: chain.turnId,
    secondTurnId: chain.secondTurnId,
    absentId: "dddddddd-dddd-4ddd-8ddd-dddddddddddd",
  };
  const created = await harness.base.adapter.unitOfWork.run((transaction) =>
    harness.stores.criteria.create(
      scope,
      conformanceCriterion({ name: `pinned-${events}` }),
      actor,
      transaction,
    ),
  );
  if (!created.ok) throw new Error("the fixture criterion was refused");
  const criterionId = created.value.evalCriterionId;

  const evalIds: string[] = [];
  await harness.base.adapter.unitOfWork.run(async (transaction) => {
    for (let index = 0; index < events; index += 1) {
      await harness.stores.safety.append(
        scope,
        conformanceSafetyEvent(ids, {
          principalId: "subject-a",
          toolName: `tool_${index}`,
          detector: index % 2 === 0 ? "pii" : "injection",
        }),
        transaction,
      );
    }
    for (let index = 0; index < evals; index += 1) {
      const appended = await harness.stores.evals.append(
        scope,
        conformanceEval(ids, criterionId, { score: index }),
        transaction,
      );
      if (appended.ok) evalIds.push(appended.value.agentEvalId);
    }
    await harness.stores.ratings.upsert(
      scope,
      {
        turnId: asGovernanceIdentifier<TurnId>(ids.turnId),
        agentId: asGovernanceIdentifier<AgentId>(ids.agentId),
        agentVersionId: null,
        endUserId: asGovernanceIdentifier<EndUserId>(ids.endUserId),
        rating: 1,
        comment: null,
        revision: 1,
      },
      transaction,
    );
  });
  return { scope, chain, ids, criterionId, evalIds };
}

beforeAll(async () => {
  harness = await startGovernanceHarness();
  small = await seedFixture(2, 2);
  large = await seedFixture(40, 40);
}, 600_000);

afterAll(async () => {
  await harness?.stop();
});

/** The pin: the same count over both fixtures, and the filter's own arithmetic. */
async function pin(
  name: string,
  expected: number,
  work: (fixture: Fixture) => Promise<unknown>,
): Promise<void> {
  const smallResult = await measure(() => work(small));
  const largeResult = await measure(() => work(large));
  expect({ name, ...smallResult }).toEqual({ name, counted: expected, total: smallResult.total });
  expect({ name, counted: largeResult.counted }).toEqual({ name, counted: expected });
  // The filter must have removed only the frame, never a measured statement.
  expect(largeResult.total).toBeGreaterThanOrEqual(largeResult.counted);
}

describe("reads are a fixed number of statements, whatever the row count", () => {
  test("`SafetyLedger.page` is two: the page and its total", async () => {
    await pin("safety.page", 2, (fixture) =>
      harness.stores.safety.page(fixture.scope, {
        since: SINCE,
        limit: 10,
        offset: 0,
        detector: null,
        severity: null,
        agentId: null,
        threadId: null,
        search: null,
      }),
    );
  });

  test("`SafetyLedger.tally` is one, folding every row in the window", async () => {
    await pin("safety.tally", 1, (fixture) => harness.stores.safety.tally(fixture.scope, SINCE));
  });

  test("`SafetyLedger.countByAgent` is one GROUP BY, not one read per agent", async () => {
    await pin("safety.countByAgent", 1, (fixture) =>
      harness.stores.safety.countByAgent(fixture.scope, SINCE),
    );
  });

  test("`SafetyLedger.countSubject` is one at an ENVIRONMENT scope", async () => {
    await pin("safety.countSubject.environment", 1, (fixture) =>
      harness.stores.safety.countSubject({ scope: fixture.scope, principalId: "subject-a" }),
    );
  });

  test("and one at an ORGANIZATION scope, where the tree is joined not walked", async () => {
    await pin("safety.countSubject.organization", 1, (fixture) =>
      harness.stores.safety.countSubject({
        scope: { level: "organization", organizationId: fixture.scope.organizationId },
        principalId: "subject-a",
      }),
    );
  });

  test("a NULL subject is ZERO statements, so an unknown subject cannot be counted wrong", async () => {
    await pin("safety.countSubject.null", 0, (fixture) =>
      harness.stores.safety.countSubject({ scope: fixture.scope, principalId: null }),
    );
  });

  test("`EvalsRepository.page` is two", async () => {
    await pin("evals.page", 2, (fixture) =>
      harness.stores.evals.page(fixture.scope, {
        since: SINCE,
        limit: 10,
        offset: 0,
        agentId: null,
        agentVersionId: null,
        criterionId: null,
        threadId: null,
        search: null,
      }),
    );
  });

  test("`EvalsRepository.sampleByIds` is one for the whole run", async () => {
    // The run grouping is not a column; a run is the SET of ids it wrote. The
    // large fixture asks for forty of them in one statement.
    await pin("evals.sampleByIds", 1, (fixture) =>
      harness.stores.evals.sampleByIds(
        fixture.scope,
        fixture.evalIds.map((value) => asGovernanceIdentifier(value)),
      ),
    );
  });

  test("`EvalsRepository.sample` is one", async () => {
    await pin("evals.sample", 1, (fixture) =>
      harness.stores.evals.sample(fixture.scope, {
        agentId: asGovernanceIdentifier<AgentId>(fixture.ids.agentId),
        since: SINCE,
        versionIds: [],
      }),
    );
  });

  test("`CriteriaRepository.findMany` is one for the whole label set", async () => {
    await pin("criteria.findMany", 1, (fixture) =>
      harness.stores.criteria.findMany(fixture.scope, [fixture.criterionId]),
    );
  });

  test("`CriteriaRepository.page` is two", async () => {
    await pin("criteria.page", 2, (fixture) =>
      harness.stores.criteria.page(fixture.scope, {
        limit: 10,
        offset: 0,
        activeOnly: false,
        search: null,
      }),
    );
  });

  test("`RatingsRepository.sample` is one", async () => {
    await pin("ratings.sample", 1, (fixture) =>
      harness.stores.ratings.sample(fixture.scope, { since: SINCE, agentId: null }),
    );
  });
});

describe("the writes are a fixed number too", () => {
  test("`upsert` is TWO on both paths, so the count is a pin and not a path", async () => {
    // The CREATE path: a scoped update that matches nothing, then the insert.
    const created = await measure(() =>
      harness.base.adapter.unitOfWork.run((transaction) =>
        harness.stores.ratings.upsert(
          small.scope,
          {
            turnId: asGovernanceIdentifier<TurnId>(small.ids.secondTurnId),
            agentId: asGovernanceIdentifier<AgentId>(small.ids.agentId),
            agentVersionId: null,
            endUserId: asGovernanceIdentifier<EndUserId>(small.ids.endUserId),
            rating: 1,
            comment: null,
            revision: 1,
          },
          transaction,
        ),
      ),
    );
    // The FLIP path: the same scoped update, matching, then the read back.
    const flipped = await measure(() =>
      harness.base.adapter.unitOfWork.run((transaction) =>
        harness.stores.ratings.upsert(
          small.scope,
          {
            turnId: asGovernanceIdentifier<TurnId>(small.ids.secondTurnId),
            agentId: asGovernanceIdentifier<AgentId>(small.ids.agentId),
            agentVersionId: null,
            endUserId: asGovernanceIdentifier<EndUserId>(small.ids.endUserId),
            rating: 1,
            comment: "changed my mind",
            revision: 2,
          },
          transaction,
        ),
      ),
    );
    expect({ created: created.counted, flipped: flipped.counted }).toEqual({ created: 2, flipped: 2 });
  });

  test("`anonymizeSubject` is ONE update, however many rows it rewrites", async () => {
    // Two rows in the small fixture, forty in the large, one statement in both.
    const smallResult = await measure(() =>
      harness.base.adapter.unitOfWork.run((transaction) =>
        harness.stores.safety.anonymizeSubject(
          { scope: small.scope, principalId: "subject-a" },
          transaction,
        ),
      ),
    );
    const largeResult = await measure(() =>
      harness.base.adapter.unitOfWork.run((transaction) =>
        harness.stores.safety.anonymizeSubject(
          { scope: large.scope, principalId: "subject-a" },
          transaction,
        ),
      ),
    );
    expect({ small: smallResult.counted, large: largeResult.counted }).toEqual({ small: 1, large: 1 });
  });

  test("`criteria.update` is THREE, and the order is scope, name, write", async () => {
    const found = await harness.stores.criteria.findById(small.scope, small.criterionId);
    expect(found.ok && found.value).not.toBeNull();
    if (!found.ok || found.value === null) return;
    const measured = await measure(() =>
      harness.base.adapter.unitOfWork.run((transaction) =>
        harness.stores.criteria.update(
          small.scope,
          { ...found.value!, description: "measured" },
          transaction,
        ),
      ),
    );
    expect(measured.counted).toBe(3);
  });
});
