// Reading measurements: a page, one row, and the canary rollup.
//
// The rollup is the interesting one. It joins nothing: criterion names come from
// this context's own table by id and version numbers come from `agents`, and a
// label neither can supply is null rather than a reason to drop the bucket —
// because dropping it would improve the mean every time an operator deleted a
// criterion.

import { beforeEach, describe, expect, it } from "vitest";
import { asIdentifier } from "@platos/kernel";

import type { ActorId, AgentEvalId, EvalCriterion, ThreadId } from "../domain/index.js";
import { aggregateAgentEvals, describeEval, pageEvals } from "./read-evals.js";
import { createCriterion, removeCriterion } from "./criteria.js";
import { runJudge } from "./run-judge.js";
import {
  AGENT_ID,
  AGENT_VERSION_ID,
  PRIOR_AGENT_VERSION_ID,
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

async function seedCriterion(overrides: Record<string, unknown> = {}): Promise<EvalCriterion> {
  seeded += 1;
  const created = await createCriterion(context.dependencies, {
    authorization: context.authorization,
    createdBy: AUTHOR,
    criterion: aCriterionDraft({ name: `criterion-${seeded}`, ...overrides }),
  });
  if (!created.ok) throw new Error(`criterion seed failed: ${created.error.code}`);
  return created.value;
}

/** Score the fixture thread once, answering `score` on the criterion's scale. */
async function score(criterion: EvalCriterion, raw = '{"score": 80, "passed": true}') {
  context.judge.only(raw);
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

describe("pageEvals", () => {
  it("REFUSES an unminted grant and reads nothing", async () => {
    const criterion = await seedCriterion();
    await score(criterion);
    const page = await pageEvals(context.dependencies, { authorization: { forged: true } });
    expect(page.ok).toBe(false);
  });

  it("does NOT show another environment's evals to this grant", async () => {
    const criterion = await seedCriterion();
    await score(criterion);
    const elsewhere = await pageEvals(context.dependencies, {
      authorization: context.grantFor(otherEnvironmentScope()),
    });
    expect(elsewhere.ok && elsewhere.value.items).toEqual([]);
    expect(elsewhere.ok && elsewhere.value.total).toBe(0);
  });

  it("clamps an over-wide page to EXACTLY the ceiling", async () => {
    const narrow = buildGovernanceTestContext({
      now: new Date("2026-03-01T12:00:00.000Z"),
      policy: withPolicy({ evals: { maxPageSize: 2 } }),
    });
    context = narrow;
    const criterion = await seedCriterion();
    for (let index = 0; index < 5; index += 1) await score(criterion);
    const page = await pageEvals(context.dependencies, {
      authorization: context.authorization,
      limit: 500,
    });
    expect(page.ok && page.value.items).toHaveLength(2);
    expect(page.ok && page.value.limit).toBe(2);
    expect(page.ok && page.value.total).toBe(5);
  });

  it("REFUSES a negative offset rather than serving page one", async () => {
    const page = await pageEvals(context.dependencies, {
      authorization: context.authorization,
      offset: -1,
    });
    expect(!page.ok && page.error.code).toBe("GOVERNANCE_PAGE_REQUEST_INVALID");
  });

  it("CLAMPS an over-wide window to exactly the ceiling and reports the number used", async () => {
    const page = await pageEvals(context.dependencies, {
      authorization: context.authorization,
      sinceDays: 10_000,
    });
    expect(page.ok && page.value.sinceDays).toBe(365);
  });

  it("takes the DEFAULT window when a non-finite day count is asked for", async () => {
    // The source's `Math.min(NaN, 365)` is NaN, `new Date(NaN)` is invalid, and
    // every comparison against it is false — a window that matches nothing.
    const page = await pageEvals(context.dependencies, {
      authorization: context.authorization,
      sinceDays: Number.NaN,
    });
    expect(page.ok && page.value.sinceDays).toBe(30);
  });

  it("excludes a row that fell out of the window, and includes one inside it", async () => {
    const criterion = await seedCriterion();
    await score(criterion);
    context.clock.advanceMilliseconds(3 * DAY);
    await score(criterion);

    const twoDays = await pageEvals(context.dependencies, {
      authorization: context.authorization,
      sinceDays: 2,
    });
    expect(twoDays.ok && twoDays.value.total).toBe(1);

    const tenDays = await pageEvals(context.dependencies, {
      authorization: context.authorization,
      sinceDays: 10,
    });
    expect(tenDays.ok && tenDays.value.total).toBe(2);
  });

  it("filters by criterion, by version and by thread", async () => {
    const first = await seedCriterion();
    const second = await seedCriterion();
    await score(first);
    await score(second);

    const byCriterion = await pageEvals(context.dependencies, {
      authorization: context.authorization,
      criterionId: first.evalCriterionId,
    });
    expect(byCriterion.ok && byCriterion.value.total).toBe(1);

    const byVersion = await pageEvals(context.dependencies, {
      authorization: context.authorization,
      agentVersionId: PRIOR_AGENT_VERSION_ID,
    });
    expect(byVersion.ok && byVersion.value.total).toBe(2);

    const otherVersion = await pageEvals(context.dependencies, {
      authorization: context.authorization,
      agentVersionId: AGENT_VERSION_ID,
    });
    expect(otherVersion.ok && otherVersion.value.total).toBe(0);

    const byThread = await pageEvals(context.dependencies, {
      authorization: context.authorization,
      threadId: asIdentifier<ThreadId>("thread-absent"),
    });
    expect(byThread.ok && byThread.value.total).toBe(0);
  });

  it("treats a blank search as NO search rather than as a match on nothing", async () => {
    const criterion = await seedCriterion();
    await score(criterion, '{"score": 80, "rationale": "grounded", "passed": true}');
    const blank = await pageEvals(context.dependencies, {
      authorization: context.authorization,
      search: "   ",
    });
    expect(blank.ok && blank.value.total).toBe(1);

    const missing = await pageEvals(context.dependencies, {
      authorization: context.authorization,
      search: "no-such-rationale",
    });
    expect(missing.ok && missing.value.total).toBe(0);
  });

  it("reports a store failure rather than an empty page", async () => {
    context.evals.failNext("store down");
    const page = await pageEvals(context.dependencies, { authorization: context.authorization });
    expect(!page.ok && page.error.code).toBe("GOVERNANCE_LEDGER_UNAVAILABLE");
  });
});

describe("describeEval", () => {
  it("answers the row inside the granted environment", async () => {
    const criterion = await seedCriterion();
    const written = await score(criterion);
    const found = await describeEval(context.dependencies, {
      authorization: context.authorization,
      evalId: written.agentEvalId,
    });
    expect(found.ok && found.value.agentEvalId).toBe(written.agentEvalId);
  });

  it("REFUSES a row belonging to ANOTHER environment, as though it did not exist", async () => {
    const criterion = await seedCriterion();
    const written = await score(criterion);
    const elsewhere = await describeEval(context.dependencies, {
      authorization: context.grantFor(otherEnvironmentScope()),
      evalId: written.agentEvalId,
    });
    expect(!elsewhere.ok && elsewhere.error.code).toBe("GOVERNANCE_EVAL_NOT_FOUND");
  });

  it("REFUSES an id that does not exist at all, with the same code", async () => {
    const missing = await describeEval(context.dependencies, {
      authorization: context.authorization,
      evalId: asIdentifier<AgentEvalId>("eval-9999"),
    });
    expect(!missing.ok && missing.error.code).toBe("GOVERNANCE_EVAL_NOT_FOUND");
  });
});

describe("aggregateAgentEvals", () => {
  it("folds one bucket per (criterion, version) and names it from this context's table", async () => {
    const criterion = await seedCriterion({ name: "groundedness" });
    await score(criterion, '{"score": 100, "passed": true}');
    await score(criterion, '{"score": 60, "passed": false}');

    const rolled = await aggregateAgentEvals(context.dependencies, {
      authorization: context.authorization,
      agentId: AGENT_ID,
    });
    expect(rolled.ok && rolled.value.rows).toHaveLength(1);
    const row = rolled.ok ? rolled.value.rows[0] : undefined;
    expect(row?.criterionName).toBe("groundedness");
    expect(row?.sampleCount).toBe(2);
    expect(row?.meanScore).toBe(80);
    expect(row?.passRate).toBe(0.5);
  });

  it("labels the bucket with the version NUMBER `agents` gives it", async () => {
    const criterion = await seedCriterion();
    await score(criterion);
    const rolled = await aggregateAgentEvals(context.dependencies, {
      authorization: context.authorization,
      agentId: AGENT_ID,
    });
    const row = rolled.ok ? rolled.value.rows[0] : undefined;
    expect(row?.agentVersionId).toBe(PRIOR_AGENT_VERSION_ID);
    expect(row?.versionNumber).toBe(6);
  });

  it("KEEPS a bucket whose criterion was deleted, with a null name", async () => {
    // Dropping it would improve the mean every time an operator deleted a
    // criterion, which is the wrong direction for a number read as a score.
    const criterion = await seedCriterion();
    await score(criterion, '{"score": 20, "passed": false}');
    const removed = await removeCriterion(context.dependencies, {
      authorization: context.authorization,
      criterionId: criterion.evalCriterionId,
    });
    expect(removed.ok && removed.value).toBe(true);

    const rolled = await aggregateAgentEvals(context.dependencies, {
      authorization: context.authorization,
      agentId: AGENT_ID,
    });
    expect(rolled.ok && rolled.value.rows).toHaveLength(1);
    const row = rolled.ok ? rolled.value.rows[0] : undefined;
    expect(row?.criterionName).toBeNull();
    expect(row?.meanScore).toBe(20);
  });

  it("still answers, unlabelled, when `agents` cannot supply version numbers", async () => {
    const criterion = await seedCriterion();
    await score(criterion);
    context.agents.failEverything();
    const rolled = await aggregateAgentEvals(context.dependencies, {
      authorization: context.authorization,
      agentId: AGENT_ID,
    });
    expect(rolled.ok && rolled.value.rows).toHaveLength(1);
    expect(rolled.ok && rolled.value.rows[0]?.versionNumber).toBeNull();
  });

  it("narrows to the versions asked for, and an unmatched version is empty", async () => {
    const criterion = await seedCriterion();
    await score(criterion);
    const matching = await aggregateAgentEvals(context.dependencies, {
      authorization: context.authorization,
      agentId: AGENT_ID,
      versionIds: [PRIOR_AGENT_VERSION_ID],
    });
    expect(matching.ok && matching.value.rows).toHaveLength(1);

    const other = await aggregateAgentEvals(context.dependencies, {
      authorization: context.authorization,
      agentId: AGENT_ID,
      versionIds: [AGENT_VERSION_ID],
    });
    expect(other.ok && other.value.rows).toEqual([]);
  });

  it("REFUSES an unminted grant", async () => {
    const rolled = await aggregateAgentEvals(context.dependencies, {
      authorization: { forged: true },
      agentId: AGENT_ID,
    });
    expect(rolled.ok).toBe(false);
  });

  it("does NOT fold another environment's evals into this agent's rollup", async () => {
    const criterion = await seedCriterion();
    await score(criterion);
    const elsewhere = await aggregateAgentEvals(context.dependencies, {
      authorization: context.grantFor(otherEnvironmentScope()),
      agentId: AGENT_ID,
    });
    expect(elsewhere.ok && elsewhere.value.rows).toEqual([]);
  });

  it("reports a sample failure rather than an empty rollup", async () => {
    context.evals.failNext("store down");
    const rolled = await aggregateAgentEvals(context.dependencies, {
      authorization: context.authorization,
      agentId: AGENT_ID,
    });
    expect(!rolled.ok && rolled.error.code).toBe("GOVERNANCE_LEDGER_UNAVAILABLE");
  });

  it("reports the window it used, clamped", async () => {
    const rolled = await aggregateAgentEvals(context.dependencies, {
      authorization: context.authorization,
      agentId: AGENT_ID,
      sinceDays: 10_000,
    });
    expect(rolled.ok && rolled.value.sinceDays).toBe(365);
  });

  it("drops a row that fell out of the window", async () => {
    const criterion = await seedCriterion();
    await score(criterion);
    context.clock.advanceMilliseconds(5 * DAY);
    const rolled = await aggregateAgentEvals(context.dependencies, {
      authorization: context.authorization,
      agentId: AGENT_ID,
      sinceDays: 2,
    });
    expect(rolled.ok && rolled.value.rows).toEqual([]);
  });
});
