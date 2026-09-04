// Did this version get worse?
//
// The property that matters most here is the one the source cannot express: a
// run in which every judge call failed must NOT read as a clean pass. The source
// builds its per-criterion list from the candidate rows alone, so an empty run
// yields an empty list and `regressed: false` — a report indistinguishable from
// a version that passed everything, which is read as permission to ship. The
// expected criteria come from the SET here, so that run reports `no-candidate`
// and `complete: false`.

import { beforeEach, describe, expect, it } from "vitest";
import { asIdentifier } from "@platos/kernel";

import type { ActorId, AgentEval, EvalCriterion, GoldenSetId, ThreadId, TurnId } from "../domain/index.js";
import { createCriterion } from "./criteria.js";
import { createGoldenSet } from "./golden-sets.js";
import { reportRegression } from "./regression-report.js";
import { runJudge } from "./run-judge.js";
import {
  AGENT_ID,
  PRIOR_AGENT_VERSION_ID,
  AGENT_VERSION_ID,
  THREAD_ID,
  TURN_ID,
  aCriterionDraft,
  buildGovernanceTestContext,
  otherEnvironmentScope,
  withPolicy,
  type GovernanceTestContext,
} from "./testing/index.js";

const DAY = 86_400_000;
const AUTHOR = asIdentifier<ActorId>("operator-1");

let context: GovernanceTestContext;
let seeded = 0;

beforeEach(() => {
  context = buildGovernanceTestContext({ now: new Date("2026-03-01T12:00:00.000Z") });
  seeded = 0;
});

async function seedCriterion(name?: string): Promise<EvalCriterion> {
  seeded += 1;
  const created = await createCriterion(context.dependencies, {
    authorization: context.authorization,
    createdBy: AUTHOR,
    criterion: aCriterionDraft({ name: name ?? `criterion-${seeded}` }),
  });
  if (!created.ok) throw new Error(`criterion seed failed: ${created.error.code}`);
  return created.value;
}

async function seedSet(criteria: readonly EvalCriterion[]): Promise<GoldenSetId> {
  const created = await createGoldenSet(context.dependencies, {
    authorization: context.authorization,
    createdBy: AUTHOR,
    set: {
      agentId: AGENT_ID,
      name: "regression",
      threadIds: [THREAD_ID],
      criterionIds: criteria.map((criterion) => criterion.evalCriterionId),
    },
  });
  if (!created.ok) throw new Error(`set seed failed: ${created.error.code}`);
  return created.value.goldenSetId;
}

async function score(criterion: EvalCriterion, value: number): Promise<AgentEval> {
  context.judge.only(`{"score": ${value}, "passed": true}`);
  const judged = await runJudge(context.dependencies, {
    authorization: context.authorization,
    agentId: AGENT_ID,
    criterionId: criterion.evalCriterionId,
    threadId: THREAD_ID,
    turnId: TURN_ID,
  });
  if (!judged.ok) throw new Error(`score failed: ${judged.error.code}`);
  return judged.value;
}

describe("the run that produced nothing", () => {
  it("reports `no-candidate` and `complete: false` for a criterion the run missed", async () => {
    const criterion = await seedCriterion("groundedness");
    const goldenSetId = await seedSet([criterion]);

    const report = await reportRegression(context.dependencies, {
      authorization: context.authorization,
      goldenSetId,
      evalIds: [],
    });
    expect(report.ok && report.value.complete).toBe(false);
    expect(report.ok && report.value.perCriterion).toHaveLength(1);
    expect(report.ok && report.value.perCriterion[0]?.verdict).toBe("no-candidate");
    expect(report.ok && report.value.perCriterion[0]?.criterionName).toBe("groundedness");
  });

  it("does NOT report `regressed` for a run that produced nothing", async () => {
    // `regressed: false` on its own would be read as permission to ship, which
    // is why `complete` is the field a gate must consult.
    const criterion = await seedCriterion();
    const goldenSetId = await seedSet([criterion]);
    const report = await reportRegression(context.dependencies, {
      authorization: context.authorization,
      goldenSetId,
      evalIds: [],
    });
    expect(report.ok && report.value.regressed).toBe(false);
    expect(report.ok && report.value.complete).toBe(false);
  });

  it("is COMPLETE when every criterion the set asked for produced a score", async () => {
    const criterion = await seedCriterion();
    const goldenSetId = await seedSet([criterion]);
    const written = await score(criterion, 70);
    const report = await reportRegression(context.dependencies, {
      authorization: context.authorization,
      goldenSetId,
      evalIds: [written.agentEvalId],
    });
    expect(report.ok && report.value.complete).toBe(true);
  });

  it("is INCOMPLETE when one of two criteria produced no score", async () => {
    const first = await seedCriterion();
    const second = await seedCriterion();
    const goldenSetId = await seedSet([first, second]);
    const written = await score(first, 70);
    const report = await reportRegression(context.dependencies, {
      authorization: context.authorization,
      goldenSetId,
      evalIds: [written.agentEvalId],
    });
    expect(report.ok && report.value.complete).toBe(false);
    expect(report.ok && report.value.perCriterion).toHaveLength(2);
  });
});

describe("comparing against a baseline", () => {
  it("reports `no-baseline` when no baseline version was named", async () => {
    const criterion = await seedCriterion();
    const goldenSetId = await seedSet([criterion]);
    const written = await score(criterion, 70);
    const report = await reportRegression(context.dependencies, {
      authorization: context.authorization,
      goldenSetId,
      evalIds: [written.agentEvalId],
    });
    expect(report.ok && report.value.baselineVersionId).toBeNull();
    expect(report.ok && report.value.perCriterion[0]?.verdict).toBe("no-baseline");
    expect(report.ok && report.value.perCriterion[0]?.delta).toBe(0);
  });

  it("takes the delta on the EXACT means, and calls a small drop neutral", async () => {
    const criterion = await seedCriterion();
    const goldenSetId = await seedSet([criterion]);
    // Baseline: the fixture turn ran on `version-6`, so an eval taken now is a
    // `version-6` sample and is what `sampleBaseline` reads.
    await score(criterion, 80);
    const candidate = await score(criterion, 75);

    const report = await reportRegression(context.dependencies, {
      authorization: context.authorization,
      goldenSetId,
      evalIds: [candidate.agentEvalId],
      baselineVersionId: PRIOR_AGENT_VERSION_ID,
    });
    // The baseline window holds BOTH rows, so its mean is 77.5 and the delta is
    // -2.5 — not a regression. The point of this test is the arithmetic, pinned
    // exactly rather than by inequality.
    expect(report.ok && report.value.perCriterion[0]?.baselineMean).toBe(77.5);
    expect(report.ok && report.value.perCriterion[0]?.candidateMean).toBe(75);
    expect(report.ok && report.value.perCriterion[0]?.delta).toBe(-2.5);
    expect(report.ok && report.value.perCriterion[0]?.verdict).toBe("neutral");
    expect(report.ok && report.value.regressed).toBe(false);
  });

  it("calls a drop of EXACTLY the threshold a regression — the boundary is inclusive", async () => {
    const context5 = buildGovernanceTestContext({
      now: new Date("2026-03-01T12:00:00.000Z"),
      policy: withPolicy({ regression: { thresholdPoints: 5, baselineWindowDays: 30 } }),
    });
    context = context5;
    const criterion = await seedCriterion();
    const goldenSetId = await seedSet([criterion]);
    // One baseline sample at 80, then a candidate at 75. The candidate's own row
    // is inside the baseline window too, so the baseline mean is 77.5 and the
    // delta is -2.5 — which is why the baseline is read from a version the
    // candidate did NOT run on. Score the baseline against `version-6` by using
    // the fixture turn, then move the candidate onto a turn that ran on
    // `version-7` so the two samples do not pool.
    context.transcripts.seed(context.scope, asIdentifier<ThreadId>("thread-new"), AGENT_ID, [
      {
        turnId: asIdentifier<TurnId>("turn-new"),
        input: "after",
        output: "new answer",
        agentVersionId: AGENT_VERSION_ID,
      },
    ]);
    await score(criterion, 80);
    context.judge.only('{"score": 75, "passed": true}');
    const candidateRun = await runJudge(context.dependencies, {
      authorization: context.authorization,
      agentId: AGENT_ID,
      criterionId: criterion.evalCriterionId,
      threadId: asIdentifier<ThreadId>("thread-new"),
      turnId: asIdentifier<TurnId>("turn-new"),
    });
    if (!candidateRun.ok) throw new Error(`candidate failed: ${candidateRun.error.code}`);

    const report = await reportRegression(context.dependencies, {
      authorization: context.authorization,
      goldenSetId,
      evalIds: [candidateRun.value.agentEvalId],
      baselineVersionId: PRIOR_AGENT_VERSION_ID,
    });
    expect(report.ok && report.value.perCriterion[0]?.baselineMean).toBe(80);
    expect(report.ok && report.value.perCriterion[0]?.candidateMean).toBe(75);
    expect(report.ok && report.value.perCriterion[0]?.delta).toBe(-5);
    expect(report.ok && report.value.perCriterion[0]?.verdict).toBe("regressed");
    expect(report.ok && report.value.regressed).toBe(true);
  });

  it("calls a drop one point SHORT of the threshold neutral", async () => {
    const context5 = buildGovernanceTestContext({
      now: new Date("2026-03-01T12:00:00.000Z"),
      policy: withPolicy({ regression: { thresholdPoints: 6, baselineWindowDays: 30 } }),
    });
    context = context5;
    const criterion = await seedCriterion();
    const goldenSetId = await seedSet([criterion]);
    context.transcripts.seed(context.scope, asIdentifier<ThreadId>("thread-new"), AGENT_ID, [
      {
        turnId: asIdentifier<TurnId>("turn-new"),
        input: "after",
        output: "new answer",
        agentVersionId: AGENT_VERSION_ID,
      },
    ]);
    await score(criterion, 80);
    context.judge.only('{"score": 75, "passed": true}');
    const candidateRun = await runJudge(context.dependencies, {
      authorization: context.authorization,
      agentId: AGENT_ID,
      criterionId: criterion.evalCriterionId,
      threadId: asIdentifier<ThreadId>("thread-new"),
      turnId: asIdentifier<TurnId>("turn-new"),
    });
    if (!candidateRun.ok) throw new Error(`candidate failed: ${candidateRun.error.code}`);

    const report = await reportRegression(context.dependencies, {
      authorization: context.authorization,
      goldenSetId,
      evalIds: [candidateRun.value.agentEvalId],
      baselineVersionId: PRIOR_AGENT_VERSION_ID,
    });
    expect(report.ok && report.value.perCriterion[0]?.delta).toBe(-5);
    expect(report.ok && report.value.perCriterion[0]?.verdict).toBe("neutral");
    expect(report.ok && report.value.regressed).toBe(false);
  });

  it("calls a big drop REGRESSED and says so at the top level", async () => {
    const criterion = await seedCriterion();
    const goldenSetId = await seedSet([criterion]);
    await score(criterion, 90);
    await score(criterion, 90);
    const candidate = await score(criterion, 10);

    const report = await reportRegression(context.dependencies, {
      authorization: context.authorization,
      goldenSetId,
      evalIds: [candidate.agentEvalId],
      baselineVersionId: PRIOR_AGENT_VERSION_ID,
    });
    // Baseline mean over all three rows is 63.33…; candidate is 10.
    expect(report.ok && report.value.perCriterion[0]?.verdict).toBe("regressed");
    expect(report.ok && report.value.regressed).toBe(true);
  });

  it("reports NO baseline samples when the baseline version produced none", async () => {
    const criterion = await seedCriterion();
    const goldenSetId = await seedSet([criterion]);
    const candidate = await score(criterion, 70);
    const report = await reportRegression(context.dependencies, {
      authorization: context.authorization,
      goldenSetId,
      evalIds: [candidate.agentEvalId],
      // Nothing ran on this version: the fixture turn is `version-6`.
      baselineVersionId: AGENT_VERSION_ID,
    });
    expect(report.ok && report.value.perCriterion[0]?.baselineSamples).toBe(0);
    expect(report.ok && report.value.perCriterion[0]?.verdict).toBe("no-baseline");
  });

  it("reads the baseline from the REGRESSION window, not from the eval window", async () => {
    const narrow = buildGovernanceTestContext({
      now: new Date("2026-03-01T12:00:00.000Z"),
      policy: withPolicy({ regression: { baselineWindowDays: 2 } }),
    });
    context = narrow;
    const criterion = await seedCriterion();
    const goldenSetId = await seedSet([criterion]);
    await score(criterion, 90);
    context.clock.advanceMilliseconds(5 * DAY);
    const candidate = await score(criterion, 70);

    const report = await reportRegression(context.dependencies, {
      authorization: context.authorization,
      goldenSetId,
      evalIds: [candidate.agentEvalId],
      baselineVersionId: PRIOR_AGENT_VERSION_ID,
    });
    // The 90 fell outside the two-day baseline window; only the candidate's own
    // row remains, so baseline and candidate are the same number.
    expect(report.ok && report.value.perCriterion[0]?.baselineSamples).toBe(1);
    expect(report.ok && report.value.perCriterion[0]?.baselineMean).toBe(70);
  });
});

describe("authorization and scope", () => {
  it("REFUSES an unminted grant", async () => {
    const criterion = await seedCriterion();
    const goldenSetId = await seedSet([criterion]);
    const report = await reportRegression(context.dependencies, {
      authorization: { forged: true },
      goldenSetId,
      evalIds: [],
    });
    expect(report.ok).toBe(false);
  });

  it("REFUSES a set belonging to ANOTHER environment", async () => {
    const criterion = await seedCriterion();
    const goldenSetId = await seedSet([criterion]);
    const report = await reportRegression(context.dependencies, {
      authorization: context.grantFor(otherEnvironmentScope()),
      goldenSetId,
      evalIds: [],
    });
    expect(!report.ok && report.error.code).toBe("GOVERNANCE_GOLDEN_SET_NOT_FOUND");
  });

  it("REFUSES a golden set that does not exist", async () => {
    const report = await reportRegression(context.dependencies, {
      authorization: context.authorization,
      goldenSetId: asIdentifier<GoldenSetId>("golden-9999"),
      evalIds: [],
    });
    expect(!report.ok && report.error.code).toBe("GOVERNANCE_GOLDEN_SET_NOT_FOUND");
  });

  it("does NOT read an eval id belonging to another environment as a candidate", async () => {
    const criterion = await seedCriterion();
    const goldenSetId = await seedSet([criterion]);
    const written = await score(criterion, 70);

    // The store narrows by environment, so the id resolves to nothing here.
    const foreign = await context.evals.sampleByIds(otherEnvironmentScope(), [written.agentEvalId]);
    expect(foreign.ok && foreign.value).toEqual([]);

    const report = await reportRegression(context.dependencies, {
      authorization: context.authorization,
      goldenSetId,
      evalIds: [written.agentEvalId],
    });
    expect(report.ok && report.value.complete).toBe(true);
  });

  it("reports a candidate-sample failure rather than an empty report", async () => {
    const criterion = await seedCriterion();
    const goldenSetId = await seedSet([criterion]);
    context.evals.failNext("store down");
    const report = await reportRegression(context.dependencies, {
      authorization: context.authorization,
      goldenSetId,
      evalIds: [],
    });
    expect(!report.ok && report.error.code).toBe("GOVERNANCE_LEDGER_UNAVAILABLE");
  });
});
