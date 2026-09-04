import { asIdentifier } from "@platos/kernel";
import { beforeEach, describe, expect, it } from "vitest";

import type { ActorId, AgentId, EvalCriterionId, ThreadId, TurnId } from "../domain/index.js";
import { createCriterion, updateCriterion } from "./criteria.js";
import { JUDGE_INSTRUCTIONS, runJudge } from "./run-judge.js";
import {
  AGENT_ID,
  AGENT_MODEL,
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

const AUTHOR = asIdentifier<ActorId>("operator-1");
let context: GovernanceTestContext;

beforeEach(() => {
  context = buildGovernanceTestContext();
  seedCounter = 0;
});

let seedCounter = 0;

async function seedCriterion(overrides: Record<string, unknown> = {}) {
  seedCounter += 1;
  const written = await createCriterion(context.dependencies, {
    authorization: context.authorization,
    createdBy: AUTHOR,
    // A unique name per seed: `@@unique([environmentId, name])` is real in the
    // double, so a suite that seeds twice in one test must not collide.
    criterion: { ...aCriterionDraft({ name: `criterion-${seedCounter}` }), ...overrides } as never,
  });
  if (!written.ok) throw new Error(`seed failed: ${written.error.code}`);
  return written.value;
}

async function judge(overrides: Record<string, unknown> = {}) {
  const criterion = overrides["criterionId"] === undefined ? await seedCriterion() : null;
  return runJudge(context.dependencies, {
    authorization: context.authorization,
    agentId: AGENT_ID,
    threadId: THREAD_ID,
    criterionId: criterion?.evalCriterionId ?? (overrides["criterionId"] as EvalCriterionId),
    ...overrides,
  });
}

describe("gate 1 — the kill switch", () => {
  it("REFUSES every judging path when judging is disabled", async () => {
    context = buildGovernanceTestContext({ policy: withPolicy({ evals: { enabled: false } }) });
    const scored = await judge();
    expect(!scored.ok && scored.error.code).toBe("GOVERNANCE_EVALS_DISABLED");
  });

  it("does not PAY a judge when it is disabled", async () => {
    context = buildGovernanceTestContext({ policy: withPolicy({ evals: { enabled: false } }) });
    await judge();
    expect(context.judge.asked).toHaveLength(0);
    expect(context.evals.size()).toBe(0);
  });

  it("refuses before the grant is verified, so a perfect grant does not route around it", async () => {
    context = buildGovernanceTestContext({ policy: withPolicy({ evals: { enabled: false } }) });
    const scored = await runJudge(context.dependencies, {
      authorization: context.authorization,
      agentId: AGENT_ID,
      threadId: THREAD_ID,
      criterionId: asIdentifier<EvalCriterionId>("criterion-nope"),
    });
    expect(!scored.ok && scored.error.code).toBe("GOVERNANCE_EVALS_DISABLED");
  });
});

describe("gate 2 — the grant", () => {
  it("REFUSES an unminted grant and pays nobody", async () => {
    await seedCriterion();
    const scored = await runJudge(context.dependencies, {
      authorization: {},
      agentId: AGENT_ID,
      threadId: THREAD_ID,
      criterionId: asIdentifier<EvalCriterionId>("criterion-0001"),
    });
    expect(scored.ok).toBe(false);
    expect(context.judge.asked).toHaveLength(0);
  });

  it("cannot reach a criterion in another environment", async () => {
    const criterion = await seedCriterion();
    const scored = await runJudge(context.dependencies, {
      authorization: context.grantFor(otherEnvironmentScope()),
      agentId: AGENT_ID,
      threadId: THREAD_ID,
      criterionId: criterion.evalCriterionId,
    });
    expect(!scored.ok && scored.error.code).toBe("GOVERNANCE_CRITERION_NOT_FOUND");
    expect(context.judge.asked).toHaveLength(0);
  });
});

describe("gates 3 and 4 — the criterion", () => {
  it("REFUSES an unknown criterion", async () => {
    const scored = await judge({ criterionId: asIdentifier<EvalCriterionId>("criterion-nope") });
    expect(!scored.ok && scored.error.code).toBe("GOVERNANCE_CRITERION_NOT_FOUND");
  });

  it("REFUSES an INACTIVE criterion, with a DIFFERENT code", async () => {
    const criterion = await seedCriterion();
    await updateCriterion(context.dependencies, {
      authorization: context.authorization,
      criterionId: criterion.evalCriterionId,
      patch: { isActive: false },
    });
    const scored = await judge({ criterionId: criterion.evalCriterionId });
    expect(!scored.ok && scored.error.code).toBe("GOVERNANCE_CRITERION_INACTIVE");
    expect(context.judge.asked).toHaveLength(0);
    expect(context.evals.size()).toBe(0);
  });
});

describe("gate 5 — the judge model", () => {
  it("REFUSES an unsupported provider before a transcript is read", async () => {
    const criterion = await seedCriterion({ judgeModel: "cohere:command-r" });
    const scored = await judge({ criterionId: criterion.evalCriterionId });
    expect(!scored.ok && scored.error.code).toBe("GOVERNANCE_JUDGE_MODEL_INVALID");
    expect(context.transcripts.reads).toHaveLength(0);
  });

  it("REFUSES a leading-colon specification", async () => {
    const criterion = await seedCriterion({ judgeModel: ":gpt-4o" });
    const scored = await judge({ criterionId: criterion.evalCriterionId });
    expect(!scored.ok && scored.error.code).toBe("GOVERNANCE_JUDGE_MODEL_INVALID");
  });

  it("falls back to the install's default judge when the criterion names none", async () => {
    const scored = await judge();
    expect(scored.ok && scored.value.judgeModel).toBe("anthropic:claude-haiku-4-5-20251001");
  });

  it("uses the install's configured default, not a module constant", async () => {
    context = buildGovernanceTestContext({
      policy: withPolicy({ evals: { defaultJudgeModel: "google:gemini-x" } }),
    });
    const scored = await judge();
    expect(scored.ok && scored.value.judgeModel).toBe("google:gemini-x");
  });
});

describe("gate 6 — no self-evaluation", () => {
  it("REFUSES a judge that is the model under test", async () => {
    const criterion = await seedCriterion({ judgeModel: AGENT_MODEL });
    const scored = await judge({ criterionId: criterion.evalCriterionId });
    expect(!scored.ok && scored.error.code).toBe("GOVERNANCE_EVAL_SELF_JUDGED");
    expect(context.judge.asked).toHaveLength(0);
    expect(context.evals.size()).toBe(0);
  });

  it("REFUSES it when the two are spelled differently — the defect this replaces", async () => {
    // The agent's model is `anthropic:claude-sonnet-4-6`; an unprefixed judge
    // naming the same model is the same model, and the source's string
    // comparison says it is not.
    const criterion = await seedCriterion({ judgeModel: "claude-sonnet-4-6" });
    const scored = await judge({ criterionId: criterion.evalCriterionId });
    expect(!scored.ok && scored.error.code).toBe("GOVERNANCE_EVAL_SELF_JUDGED");
  });

  it("REFUSES when the agent's model cannot be read, rather than proceeding", async () => {
    context.agents.seed({
      agentId: AGENT_ID,
      name: "Support",
      model: ":broken",
      currentVersionId: AGENT_VERSION_ID,
      currentVersionNumber: 7,
    });
    const scored = await judge();
    expect(!scored.ok && scored.error.code).toBe("GOVERNANCE_JUDGE_MODEL_INVALID");
    expect(context.judge.asked).toHaveLength(0);
  });

  it("ADMITS a genuinely different model", async () => {
    const criterion = await seedCriterion({ judgeModel: "openai:gpt-5" });
    const scored = await judge({ criterionId: criterion.evalCriterionId });
    expect(scored.ok).toBe(true);
  });
});

describe("the transcript gate", () => {
  it("REFUSES a thread that is not in this environment", async () => {
    const scored = await judge({ threadId: asIdentifier<ThreadId>("thread-nope") });
    expect(!scored.ok && scored.error.code).toBe("GOVERNANCE_TRANSCRIPT_NOT_FOUND");
    expect(context.judge.asked).toHaveLength(0);
  });

  it("REFUSES a thread that belongs to a DIFFERENT agent than the caller named", async () => {
    // Scoring agent A's conversation and attributing it to agent B corrupts
    // every rollup taken afterwards.
    context.transcripts.seed(context.scope, asIdentifier<ThreadId>("thread-2"), asIdentifier<AgentId>("agent-2"), [
      { turnId: asIdentifier<TurnId>("turn-9"), input: "hi", output: "hello", agentVersionId: null },
    ]);
    const scored = await judge({ threadId: asIdentifier<ThreadId>("thread-2") });
    expect(!scored.ok && scored.error.code).toBe("GOVERNANCE_TRANSCRIPT_NOT_FOUND");
    expect(context.evals.size()).toBe(0);
  });

  it("REFUSES when the transcript reader is down", async () => {
    context.transcripts.failNext("reader down");
    const scored = await judge();
    expect(scored.ok).toBe(false);
    expect(context.judge.asked).toHaveLength(0);
  });

  it("narrows to ONE turn when a turn id is supplied", async () => {
    await judge({ turnId: TURN_ID });
    expect(context.transcripts.reads.at(-1)).toEqual({ threadId: THREAD_ID, turnId: TURN_ID });
    expect(context.judge.asked[0]?.prompt).toContain("how do I reset it?");
  });

  it("scores an EMPTY conversation rather than widening to the whole thread", async () => {
    const scored = await judge({ turnId: asIdentifier<TurnId>("turn-not-in-thread") });
    expect(scored.ok).toBe(true);
    expect(context.judge.asked[0]?.prompt).not.toContain("how do I reset it?");
  });
});

describe("what a successful score writes", () => {
  it("stores the verdict, the judge, the prompt and the raw answer", async () => {
    const scored = await judge();
    expect(scored.ok && scored.value.score).toBe(80);
    expect(scored.ok && scored.value.passed).toBe(true);
    expect(scored.ok && scored.value.rationale).toBe("grounded and complete");
    expect(scored.ok && scored.value.rawResponse).toContain('"score": 80');
    expect(scored.ok && scored.value.judgePromptUsed).toContain("how do I reset it?");
  });

  it("attributes the eval to the version THAT PRODUCED the transcript", async () => {
    // The fixture is mid-promotion: the seeded turn ran on `version-6` and the
    // agent is live on `version-7`. An eval attributed to the live binding —
    // the source's behaviour — files last week's output against this week's
    // version, and `aggregateAgentEvals` filtered by version reads the mixture.
    const scored = await judge();
    expect(scored.ok && scored.value.agentVersionId).toBe(PRIOR_AGENT_VERSION_ID);
    expect(scored.ok && scored.value.agentVersionId).not.toBe(AGENT_VERSION_ID);
  });

  it("attributes a conversation SPANNING a promotion to NEITHER version", async () => {
    context.transcripts.seed(context.scope, asIdentifier<ThreadId>("thread-mixed"), AGENT_ID, [
      {
        turnId: asIdentifier<TurnId>("turn-old"),
        input: "before",
        output: "old answer",
        agentVersionId: PRIOR_AGENT_VERSION_ID,
      },
      {
        turnId: asIdentifier<TurnId>("turn-new"),
        input: "after",
        output: "new answer",
        agentVersionId: AGENT_VERSION_ID,
      },
    ]);
    const scored = await judge({ threadId: asIdentifier<ThreadId>("thread-mixed") });
    expect(scored.ok && scored.value.agentVersionId).toBeNull();
  });

  it("FREEZES the criterion it was scored against", async () => {
    const criterion = await seedCriterion({ name: "before-the-edit" });
    const scored = await judge({ criterionId: criterion.evalCriterionId });
    await updateCriterion(context.dependencies, {
      authorization: context.authorization,
      criterionId: criterion.evalCriterionId,
      patch: { name: "after-the-edit", judgePrompt: "something else entirely" },
    });
    expect(scored.ok && scored.value.criterionSnapshot.name).toBe("before-the-edit");
    expect(context.evals.all()[0]?.criterionSnapshot.name).toBe("before-the-edit");
  });

  it("sends the standing instructions unchanged, separately from the criterion", async () => {
    await judge();
    expect(context.judge.asked[0]?.instructions).toBe(JUDGE_INSTRUCTIONS);
  });

  it("measures latency across the JUDGE call alone", async () => {
    const scored = await judge();
    expect(scored.ok && scored.value.latencyMs).toBe(0);
  });

  it("stores the cost the adapter priced, and null when it could not price it", async () => {
    const priced = await judge();
    expect(priced.ok && priced.value.costCents).toBe(12);
    context.judge.costCents = null;
    const unpriced = await judge();
    expect(unpriced.ok && unpriced.value.costCents).toBeNull();
  });

  it("truncates an enormous judge answer to the configured ceiling, AND SAYS SO", async () => {
    context = buildGovernanceTestContext({ policy: withPolicy({ evals: { maxRawResponseLength: 12 } }) });
    context.judge.only('{"score": 40, "rationale": "and a great deal more text besides"}');
    const scored = await judge();
    expect(scored.ok && scored.value.rawResponse).toHaveLength(12);
    // On the STORED ROW, not only on the admitted draft: a reader has to be able
    // to tell "the judge said this" from "the judge said this and more".
    expect(scored.ok && scored.value.rawResponseTruncated).toBe(true);
  });

  it("does NOT flag an answer that fitted", async () => {
    context = buildGovernanceTestContext({ policy: withPolicy({ evals: { maxRawResponseLength: 4_000 } }) });
    context.judge.only('{"score": 40}');
    const scored = await judge();
    expect(scored.ok && scored.value.rawResponseTruncated).toBe(false);
    expect(scored.ok && scored.value.rawResponse).toBe('{"score": 40}');
  });
});

describe("a judge failure is stored, not thrown", () => {
  it("writes a zero-scored eval carrying the failure as its rationale", async () => {
    context.judge.failNext("provider timed out");
    const scored = await judge();
    expect(scored.ok).toBe(true);
    expect(scored.ok && scored.value.score).toBe(0);
    expect(scored.ok && scored.value.passed).toBe(false);
    expect(scored.ok && scored.value.rawResponse).toContain("[judge-error]");
    expect(context.evals.size()).toBe(1);
  });

  it("writes a zero-scored eval for an UNREADABLE answer too", async () => {
    context.judge.only("I would rather not say.");
    const scored = await judge();
    expect(scored.ok && scored.value.score).toBe(0);
    expect(scored.ok && scored.value.rationale).toBe("I would rather not say.");
  });

  it("REFUSES when the eval store itself is down, rather than losing the measurement quietly", async () => {
    context.evals.failNext("store down");
    const scored = await judge();
    expect(scored.ok).toBe(false);
    expect(context.evals.size()).toBe(0);
  });
});
