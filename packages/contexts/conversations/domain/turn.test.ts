// The turn: input admission, the settle-once rule, and the derived totals.
//
// Mutations M-N1 (empty input), M-N2 (input size), M-N3 (settle twice), M-N4
// (the step clamp), M-N5 (the zeroing mutation on the cost rollup).

import { describe, expect, it } from "vitest";
import { asIdentifier, money, type Money } from "@platos/kernel";

import { DEFAULT_CONVERSATIONS_POLICY } from "./policy.js";
import { NO_STEP_RATES, type StepRate, type StepRateBook } from "./step-rates.js";
import { openStep, settleStep, type Step } from "./step.js";
import { stepUsage } from "./step-usage.js";
import { abandonTurn, admitTurnInput, beginTurn, openTurn, settleTurn, stepCeiling } from "./turn.js";
import type { AgentVersionId, StepId, ThreadId, TurnId } from "./identifiers.js";

const POLICY = DEFAULT_CONVERSATIONS_POLICY.turn;
const AT = new Date("2026-01-01T00:00:00.000Z");
const LATER = new Date("2026-01-01T00:00:02.500Z");

function rate(): StepRate {
  return { usdPerToken: "0.000003000000", source: "LITELLM", observedAt: AT, sourceRef: null };
}

function book(): StepRateBook {
  return { input: rate(), output: rate(), cacheRead: rate(), cacheWrite: rate() };
}

function step(sequence: number, microCents: bigint, tokens = 1_000): Step {
  const open = openStep({
    stepId: asIdentifier<StepId>(`step-${sequence}`),
    turnId: asIdentifier<TurnId>("turn-1"),
    sequence,
    model: "anthropic:claude-test",
    startedAt: AT,
  });
  const usage = stepUsage({ inputTokens: tokens, outputTokens: 100 });
  if (!usage.ok) throw new Error(usage.error.code);
  const settled = settleStep(open, {
    status: "SUCCEEDED",
    usage: usage.value,
    cost: money(microCents),
    modelPriceId: null,
    rates: book(),
    error: null,
    completedAt: AT,
  });
  if (!settled.ok) throw new Error(settled.error.code);
  return settled.value;
}

function draft(overrides: Record<string, unknown> = {}) {
  return {
    turnId: asIdentifier<TurnId>("turn-1"),
    threadId: asIdentifier<ThreadId>("thread-1"),
    agentVersionId: asIdentifier<AgentVersionId>("ver-1"),
    versionBucket: "CURRENT" as const,
    sequence: 1,
    inputText: "hello",
    at: AT,
    ...overrides,
  } as Parameters<typeof openTurn>[0];
}

describe("admitTurnInput", () => {
  it("admits text alone, structured input alone, and both", () => {
    expect(admitTurnInput("hi", null, POLICY).ok).toBe(true);
    expect(admitTurnInput(null, { a: 1 }, POLICY).ok).toBe(true);
    expect(admitTurnInput("hi", { a: 1 }, POLICY).ok).toBe(true);
  });

  it("refuses a turn with NEITHER, including a blank string", () => {
    const empty = admitTurnInput(null, null, POLICY);
    expect(empty.ok).toBe(false);
    if (empty.ok) return;
    expect(empty.error.code).toBe("CONVERSATIONS_TURN_INPUT_INVALID");
    expect(admitTurnInput("   ", null, POLICY).ok).toBe(false);
  });

  it("refuses input over the ceiling with a DIFFERENT code from emptiness", () => {
    const refused = admitTurnInput("x".repeat(POLICY.maxInputBytes + 1), null, POLICY);
    expect(refused.ok).toBe(false);
    if (refused.ok) return;
    expect(refused.error.code).toBe("CONVERSATIONS_TURN_INPUT_TOO_LARGE");
    expect(refused.error.details.maximum).toBe(POLICY.maxInputBytes);
  });

  it("counts the structured half toward the same ceiling", () => {
    const refused = admitTurnInput("x", { blob: "y".repeat(POLICY.maxInputBytes) }, POLICY);
    expect(refused.ok).toBe(false);
    if (refused.ok) return;
    expect(refused.error.code).toBe("CONVERSATIONS_TURN_INPUT_TOO_LARGE");
  });
});

describe("openTurn", () => {
  it("writes the user side, leaves the agent side null, and starts PENDING", () => {
    const opened = openTurn(draft(), POLICY);
    expect(opened.ok).toBe(true);
    if (!opened.ok) return;
    expect(opened.value.status).toBe("PENDING");
    expect(opened.value.inputText).toBe("hello");
    expect(opened.value.outputText).toBeNull();
    expect(opened.value.startedAt).toBeNull();
    expect(opened.value.cost.amount.microCents).toBe(0n);
    expect(opened.value.usage.inputTokens).toBe(0);
  });

  it("pins the version and its bucket, the axis a canary is judged along", () => {
    const opened = openTurn(draft({ versionBucket: "CANARY" }), POLICY);
    expect(opened.ok).toBe(true);
    if (!opened.ok) return;
    expect(opened.value.agentVersionId).toBe("ver-1");
    expect(opened.value.versionBucket).toBe("CANARY");
  });
});

describe("beginTurn and settleTurn", () => {
  it("moves PENDING to ACTIVE and stamps the start", () => {
    const opened = openTurn(draft(), POLICY);
    if (!opened.ok) throw new Error(opened.error.code);
    const running = beginTurn(opened.value, AT);
    expect(running.ok).toBe(true);
    if (!running.ok) return;
    expect(running.value.status).toBe("ACTIVE");
    expect(running.value.startedAt).toEqual(AT);
  });

  it("DERIVES the cost and the usage from the steps, to exact values", () => {
    const opened = openTurn(draft(), POLICY);
    if (!opened.ok) throw new Error(opened.error.code);
    const running = beginTurn(opened.value, AT);
    if (!running.ok) throw new Error(running.error.code);

    const settled = settleTurn(running.value, {
      status: "SUCCEEDED",
      outputText: "answered",
      steps: [step(1, 2_500_000n, 12_000), step(2, 1_000_001n, 8_000)],
      completedAt: LATER,
    });
    expect(settled.ok).toBe(true);
    if (!settled.ok) return;
    expect(settled.value.cost.amount.microCents).toBe(3_500_001n);
    expect(settled.value.cost.stepCount).toBe(2);
    expect(settled.value.usage.inputTokens).toBe(20_000);
    expect(settled.value.usage.outputTokens).toBe(200);
    expect(settled.value.latencyMs).toBe(2_500);
    expect(settled.value.outputText).toBe("answered");
  });

  it("has NO parameter for a usage or a cost total — the shape forbids disagreement", () => {
    const opened = openTurn(draft(), POLICY);
    if (!opened.ok) throw new Error(opened.error.code);
    const running = beginTurn(opened.value, AT);
    if (!running.ok) throw new Error(running.error.code);
    const settlement = {
      status: "SUCCEEDED" as const,
      steps: [step(1, 42n)],
      completedAt: LATER,
    };
    expect(Object.keys(settlement)).not.toContain("usage");
    expect(Object.keys(settlement)).not.toContain("cost");
    const settled = settleTurn(running.value, settlement);
    expect(settled.ok).toBe(true);
    if (!settled.ok) return;
    expect(settled.value.cost.amount.microCents).toBe(42n);
  });

  it("refuses a SECOND settlement", () => {
    const opened = openTurn(draft(), POLICY);
    if (!opened.ok) throw new Error(opened.error.code);
    const running = beginTurn(opened.value, AT);
    if (!running.ok) throw new Error(running.error.code);
    const first = settleTurn(running.value, { status: "SUCCEEDED", steps: [], completedAt: LATER });
    if (!first.ok) throw new Error(first.error.code);
    const second = settleTurn(first.value, { status: "FAILED", steps: [], completedAt: LATER });
    expect(second.ok).toBe(false);
    if (second.ok) return;
    expect(second.error.code).toBe("CONVERSATIONS_TURN_ALREADY_SETTLED");
    expect(second.error.details.status).toBe("SUCCEEDED");
  });
});

describe("abandonTurn", () => {
  it("settles CANCELLED and KEEPS the money the steps already spent", () => {
    const opened = openTurn(draft(), POLICY);
    if (!opened.ok) throw new Error(opened.error.code);
    const running = beginTurn(opened.value, AT);
    if (!running.ok) throw new Error(running.error.code);
    const abandoned = abandonTurn(running.value, [step(1, 750_000n)], LATER);
    expect(abandoned.ok).toBe(true);
    if (!abandoned.ok) return;
    expect(abandoned.value.status).toBe("CANCELLED");
    // The extraction source throws out of the generator and settles in a catch
    // that cannot see the steps, so an abandoned turn loses its money.
    expect(abandoned.value.cost.amount.microCents).toBe(750_000n);
    expect(abandoned.value.cost.stepCount).toBe(1);
  });
});

describe("stepCeiling", () => {
  it("clamps an agent's request to the installation ceiling", () => {
    expect(stepCeiling(100_000, POLICY)).toBe(POLICY.maxStepsPerTurn);
  });

  it("honours a request under the ceiling", () => {
    expect(stepCeiling(4, POLICY)).toBe(4);
  });

  it("falls back to the default when the request is absent or unusable", () => {
    expect(stepCeiling(null, POLICY)).toBe(POLICY.defaultStepsPerTurn);
    expect(stepCeiling(0, POLICY)).toBe(POLICY.defaultStepsPerTurn);
    expect(stepCeiling(-1, POLICY)).toBe(POLICY.defaultStepsPerTurn);
    expect(stepCeiling(2.5, POLICY)).toBe(POLICY.defaultStepsPerTurn);
  });

  it("the extraction source has no clamp at all, and this one is reachable", () => {
    // `stopWhen: isStepCount(agentConfig.maxSteps)` takes whatever the version
    // row says, so a row with 100000 is an unbounded provider bill.
    expect(stepCeiling(100_000, POLICY)).toBeLessThan(100_000);
  });
});

describe("the unpriced turn", () => {
  it("settles at exactly zero and says the total is COMPLETE, not unknown", () => {
    const opened = openTurn(draft(), POLICY);
    if (!opened.ok) throw new Error(opened.error.code);
    const running = beginTurn(opened.value, AT);
    if (!running.ok) throw new Error(running.error.code);
    const settled = settleTurn(running.value, { status: "FAILED", steps: [], completedAt: LATER });
    expect(settled.ok).toBe(true);
    if (!settled.ok) return;
    const amount: Money = settled.value.cost.amount;
    expect(amount.microCents).toBe(0n);
    expect(settled.value.cost.complete).toBe(true);
    expect(NO_STEP_RATES.input).toBeNull();
  });
});
