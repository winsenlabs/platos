// Handing a golden-set run to the durable seam.
//
// The property this suite exists to hold is that NO JUDGE IS PAID INSIDE THE
// REQUEST. Every test asserts `context.judge.asked` is empty, because the
// difference between this use case and the source it replaces is precisely that
// the source ran the whole fan-out — one paid model call per pair, serially,
// with the response held open — before answering.

import { describe, expect, it } from "vitest";
import { asIdentifier } from "@platos/kernel";

import type { AgentVersionId, EvalCriterionId, GoldenSetId, ThreadId } from "../domain/index.js";
import { enqueueEvalRun, evalRunIdempotencyKey } from "./enqueue-eval-run.js";
import { createGoldenSet } from "./golden-sets.js";
import {
  AGENT_ID,
  buildGovernanceTestContext,
  otherEnvironmentScope,
  THREAD_ID,
  withPolicy,
  type GovernanceTestContext,
} from "./testing/index.js";

const CRITERION_A = asIdentifier<EvalCriterionId>("criterion-a");
const CRITERION_B = asIdentifier<EvalCriterionId>("criterion-b");
const THREAD_2 = asIdentifier<ThreadId>("thread-2");
const OPERATOR = asIdentifier("operator-1");
const BASELINE = asIdentifier<AgentVersionId>("version-6");

async function seedSet(
  context: GovernanceTestContext,
  overrides: Record<string, unknown> = {},
): Promise<GoldenSetId> {
  const created = await createGoldenSet(context.dependencies, {
    authorization: context.authorization,
    createdBy: OPERATOR,
    set: {
      agentId: AGENT_ID,
      name: "regression",
      threadIds: [THREAD_ID, THREAD_2],
      criterionIds: [CRITERION_A, CRITERION_B],
      ...overrides,
    },
  });
  if (!created.ok) throw new Error(`seed failed: ${created.error.code}`);
  return created.value.goldenSetId;
}

async function enqueue(
  context: GovernanceTestContext,
  goldenSetId: GoldenSetId,
  overrides: Record<string, unknown> = {},
) {
  return enqueueEvalRun(context.dependencies, {
    authorization: context.authorization,
    goldenSetId,
    requestedBy: OPERATOR,
    ...overrides,
  });
}

describe("enqueueEvalRun", () => {
  it("plans every pair thread-major and hands the whole plan to the queue", async () => {
    const context = buildGovernanceTestContext();
    const goldenSetId = await seedSet(context);
    const queued = await enqueue(context, goldenSetId);

    expect(queued.ok && queued.value.pairs).toEqual([
      { threadId: THREAD_ID, criterionId: CRITERION_A },
      { threadId: THREAD_ID, criterionId: CRITERION_B },
      { threadId: THREAD_2, criterionId: CRITERION_A },
      { threadId: THREAD_2, criterionId: CRITERION_B },
    ]);
    expect(queued.ok && queued.value.pairCount).toBe(4);
    expect(queued.ok && queued.value.alreadyQueued).toBe(false);
    expect(context.evalRuns.requests).toHaveLength(1);
  });

  it("PAYS NO JUDGE and writes NO eval inside the request", async () => {
    const context = buildGovernanceTestContext();
    const goldenSetId = await seedSet(context);
    await enqueue(context, goldenSetId);
    expect(context.judge.asked).toHaveLength(0);
    expect(context.evals.size()).toBe(0);
  });

  it("stamps the queued request with the GRANTED scope and the set's agent", async () => {
    const context = buildGovernanceTestContext();
    const goldenSetId = await seedSet(context);
    await enqueue(context, goldenSetId, { baselineVersionId: BASELINE });
    const [request] = context.evalRuns.requests;
    expect(request.scope.environmentId).toBe("env-1");
    expect(request.agentId).toBe(AGENT_ID);
    expect(request.requestedBy).toBe(OPERATOR);
    expect(request.baselineVersionId).toBe(BASELINE);
  });
});

describe("the kill switch", () => {
  it("REFUSES to queue when judging is disabled, before the grant is even checked", async () => {
    const context = buildGovernanceTestContext({ policy: withPolicy({ evals: { enabled: false } }) });
    const enabled = buildGovernanceTestContext();
    const goldenSetId = await seedSet(enabled);
    const queued = await enqueueEvalRun(context.dependencies, {
      authorization: context.authorization,
      goldenSetId,
      requestedBy: OPERATOR,
    });
    expect(!queued.ok && queued.error.code).toBe("GOVERNANCE_EVALS_DISABLED");
    expect(context.evalRuns.requests).toHaveLength(0);
    expect(context.judge.asked).toHaveLength(0);
  });

  it("queues normally when the switch is on, so the disabled test is not vacuous", async () => {
    const context = buildGovernanceTestContext({ policy: withPolicy({ evals: { enabled: true } }) });
    const goldenSetId = await seedSet(context);
    const queued = await enqueue(context, goldenSetId);
    expect(queued.ok).toBe(true);
    expect(context.evalRuns.requests).toHaveLength(1);
  });
});

describe("authorization and scope", () => {
  it("REFUSES an unminted grant and queues NOTHING", async () => {
    const context = buildGovernanceTestContext();
    const goldenSetId = await seedSet(context);
    const queued = await enqueueEvalRun(context.dependencies, {
      authorization: { principalType: "operator", scope: context.scope },
      goldenSetId,
      requestedBy: OPERATOR,
    });
    expect(queued.ok).toBe(false);
    expect(context.evalRuns.requests).toHaveLength(0);
  });

  it("REFUSES a set belonging to ANOTHER environment", async () => {
    const context = buildGovernanceTestContext();
    const goldenSetId = await seedSet(context);
    const queued = await enqueueEvalRun(context.dependencies, {
      authorization: context.grantFor(otherEnvironmentScope()),
      goldenSetId,
      requestedBy: OPERATOR,
    });
    expect(!queued.ok && queued.error.code).toBe("GOVERNANCE_GOLDEN_SET_NOT_FOUND");
    expect(context.evalRuns.requests).toHaveLength(0);
  });

  it("REFUSES a set whose agent has since become invisible here", async () => {
    const context = buildGovernanceTestContext();
    const goldenSetId = await seedSet(context);
    context.agents.failEverything();
    const queued = await enqueue(context, goldenSetId);
    expect(!queued.ok && queued.error.code).toBe("GOVERNANCE_AGENT_NOT_VISIBLE");
    expect(context.evalRuns.requests).toHaveLength(0);
  });
});

describe("the caps are re-checked against the STORED set", () => {
  it("REFUSES to run a set written when the pair ceiling was higher", async () => {
    // Written under a ceiling of 10 pairs, then run under a ceiling of 3.
    const wide = buildGovernanceTestContext({
      policy: withPolicy({ goldenSets: { maxThreads: 10, maxCriteria: 10, maxPairs: 10 } }),
    });
    const goldenSetId = await seedSet(wide);
    const stored = await wide.goldenSets.findById(wide.scope, goldenSetId);
    expect(stored.ok && stored.value?.threadIds).toHaveLength(2);

    const narrow = buildGovernanceTestContext({
      scope: wide.scope,
      policy: withPolicy({ goldenSets: { maxThreads: 10, maxCriteria: 10, maxPairs: 3 } }),
    });
    // Same store, narrower policy: this is the "cap lowered after the write" case.
    const queued = await enqueueEvalRun(
      { ...narrow.dependencies, goldenSets: wide.goldenSets },
      { authorization: narrow.authorization, goldenSetId, requestedBy: OPERATOR },
    );
    expect(!queued.ok && queued.error.code).toBe("GOVERNANCE_GOLDEN_SET_TOO_MANY_PAIRS");
    expect(narrow.evalRuns.requests).toHaveLength(0);
  });

  it("RUNS a set that is inside a ceiling of exactly its own pair count", async () => {
    const context = buildGovernanceTestContext({
      policy: withPolicy({ goldenSets: { maxThreads: 10, maxCriteria: 10, maxPairs: 4 } }),
    });
    const goldenSetId = await seedSet(context);
    const queued = await enqueue(context, goldenSetId);
    expect(queued.ok && queued.value.pairCount).toBe(4);
  });
});

describe("idempotency", () => {
  it("a repeated request costs ONE run and says so", async () => {
    const context = buildGovernanceTestContext();
    const goldenSetId = await seedSet(context);
    const first = await enqueue(context, goldenSetId);
    const second = await enqueue(context, goldenSetId);

    expect(first.ok && first.value.alreadyQueued).toBe(false);
    expect(second.ok && second.value.alreadyQueued).toBe(true);
    expect(first.ok && second.ok && first.value.runId).toBe(second.value.runId);
  });

  it("a DIFFERENT baseline is a different run", async () => {
    const context = buildGovernanceTestContext();
    const goldenSetId = await seedSet(context);
    const plain = await enqueue(context, goldenSetId);
    const against = await enqueue(context, goldenSetId, { baselineVersionId: BASELINE });
    expect(against.ok && against.value.alreadyQueued).toBe(false);
    expect(plain.ok && against.ok && plain.value.runId).not.toBe(against.value.runId);
  });

  it("the key is built from WHAT the run is, and carries no instant", () => {
    const pairs = [
      { threadId: THREAD_ID, criterionId: CRITERION_A },
      { threadId: THREAD_2, criterionId: CRITERION_B },
    ];
    const goldenSetId = asIdentifier<GoldenSetId>("golden-0001");
    expect(evalRunIdempotencyKey(goldenSetId, pairs, null)).toBe(
      "eval-run/golden-0001/no-baseline/thread-1:criterion-a|thread-2:criterion-b",
    );
    expect(evalRunIdempotencyKey(goldenSetId, pairs, BASELINE)).toBe(
      "eval-run/golden-0001/version-6/thread-1:criterion-a|thread-2:criterion-b",
    );
  });

  it("the key is STABLE across two calls a minute apart", async () => {
    const context = buildGovernanceTestContext({ now: new Date("2026-03-01T12:00:00.000Z") });
    const goldenSetId = await seedSet(context);
    await enqueue(context, goldenSetId);
    context.clock.advanceMilliseconds(60_000);
    await enqueue(context, goldenSetId);
    const [first, second] = context.evalRuns.requests;
    expect(first.idempotencyKey).toBe(second.idempotencyKey);
  });
});

describe("the queue itself", () => {
  it("reports a queue failure rather than claiming work was accepted", async () => {
    const context = buildGovernanceTestContext();
    const goldenSetId = await seedSet(context);
    context.evalRuns.failNext("dispatcher down");
    const queued = await enqueue(context, goldenSetId);
    expect(!queued.ok && queued.error.code).toBe("GOVERNANCE_LEDGER_UNAVAILABLE");
  });

  it("REFUSES a golden set that does not exist at all", async () => {
    const context = buildGovernanceTestContext();
    const queued = await enqueue(context, asIdentifier<GoldenSetId>("golden-9999"));
    expect(!queued.ok && queued.error.code).toBe("GOVERNANCE_GOLDEN_SET_NOT_FOUND");
  });
});
