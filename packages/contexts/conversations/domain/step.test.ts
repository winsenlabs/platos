// The step: settle once, retry a live one, and never store an unexplainable row.
//
// Mutations M-P1 (settle twice), M-P2 (retry after settlement), M-P3 (the rate
// rule reached through `settleStep` rather than directly).

import { describe, expect, it } from "vitest";
import { asIdentifier, money } from "@platos/kernel";

import { NO_STEP_RATES, type StepRate, type StepRateBook } from "./step-rates.js";
import { noCost, openStep, retryStep, settleStep, stepCost } from "./step.js";
import { stepUsage } from "./step-usage.js";
import type { ModelPriceId, StepId, TurnId } from "./identifiers.js";

const AT = new Date("2026-01-01T00:00:00.000Z");
const LATER = new Date("2026-01-01T00:00:01.250Z");

function rate(): StepRate {
  return { usdPerToken: "0.000003000000", source: "LITELLM", observedAt: AT, sourceRef: null };
}

function book(): StepRateBook {
  return { input: rate(), output: rate(), cacheRead: rate(), cacheWrite: rate() };
}

function open() {
  return openStep({
    stepId: asIdentifier<StepId>("step-1"),
    turnId: asIdentifier<TurnId>("turn-1"),
    sequence: 1,
    model: "anthropic:claude-test",
    startedAt: AT,
  });
}

function usage(draft: Parameters<typeof stepUsage>[0] = { inputTokens: 1_000, outputTokens: 100 }) {
  const admitted = stepUsage(draft);
  if (!admitted.ok) throw new Error(admitted.error.code);
  return admitted.value;
}

describe("openStep", () => {
  it("starts ACTIVE, unpriced, unretried, with four null rates", () => {
    const step = open();
    expect(step.status).toBe("ACTIVE");
    expect(step.retryCount).toBe(0);
    expect(step.cost).toBeNull();
    expect(step.modelPriceId).toBeNull();
    expect(step.rates).toEqual(NO_STEP_RATES);
    expect(step.completedAt).toBeNull();
    expect(step.startedAt).toEqual(AT);
  });
});

describe("settleStep", () => {
  it("stores the usage, the exact cost, the card and the four rates", () => {
    const settled = settleStep(open(), {
      status: "SUCCEEDED",
      usage: usage({ inputTokens: 9_000, outputTokens: 640, cacheReadInputTokens: 4_000 }),
      cost: money(1_234_567n),
      modelPriceId: asIdentifier<ModelPriceId>("price-9"),
      rates: book(),
      error: null,
      completedAt: LATER,
    });
    expect(settled.ok).toBe(true);
    if (!settled.ok) return;
    expect(settled.value.status).toBe("SUCCEEDED");
    expect(settled.value.cost?.microCents).toBe(1_234_567n);
    expect(settled.value.modelPriceId).toBe("price-9");
    expect(settled.value.usage.cacheReadInputTokens).toBe(4_000);
    expect(settled.value.latencyMs).toBe(1_250);
  });

  it("refuses a SECOND settlement before it looks at the rates", () => {
    const first = settleStep(open(), {
      status: "SUCCEEDED",
      usage: usage(),
      cost: money(1n),
      modelPriceId: null,
      rates: book(),
      error: null,
      completedAt: LATER,
    });
    if (!first.ok) throw new Error(first.error.code);

    const second = settleStep(first.value, {
      status: "FAILED",
      usage: usage(),
      // Rates absent AND already settled. The transition check runs first, so
      // deleting it cannot be masked by the rate rule.
      cost: null,
      modelPriceId: null,
      rates: NO_STEP_RATES,
      error: "late",
      completedAt: LATER,
    });
    expect(second.ok).toBe(false);
    if (second.ok) return;
    expect(second.error.code).toBe("CONVERSATIONS_TURN_ALREADY_SETTLED");
  });

  it("refuses a row whose charged tokens have no rate, through THIS entry point", () => {
    const refused = settleStep(open(), {
      status: "SUCCEEDED",
      usage: usage({ inputTokens: 5_000, outputTokens: 10 }),
      cost: money(1n),
      modelPriceId: null,
      rates: { ...book(), output: null },
      error: null,
      completedAt: LATER,
    });
    expect(refused.ok).toBe(false);
    if (refused.ok) return;
    expect(refused.error.code).toBe("CONVERSATIONS_STEP_RATE_MISSING");
    expect(refused.error.details.field).toBe("outputRate");
  });

  it("admits a FAILED step that consumed nothing and carries no rates", () => {
    const settled = settleStep(open(), {
      status: "FAILED",
      usage: usage({}),
      cost: null,
      modelPriceId: null,
      rates: NO_STEP_RATES,
      error: "the provider refused",
      completedAt: LATER,
    });
    expect(settled.ok).toBe(true);
    if (!settled.ok) return;
    expect(settled.value.status).toBe("FAILED");
    expect(settled.value.error).toBe("the provider refused");
    expect(settled.value.cost).toBeNull();
  });
});

describe("retryStep", () => {
  it("increments the counter on an open step, keeping its identity", () => {
    const retried = retryStep(open());
    expect(retried.ok).toBe(true);
    if (!retried.ok) return;
    expect(retried.value.retryCount).toBe(1);
    expect(retried.value.stepId).toBe("step-1");
    expect(retried.value.sequence).toBe(1);
  });

  it("refuses a retry of a SETTLED step", () => {
    const settled = settleStep(open(), {
      status: "SUCCEEDED",
      usage: usage(),
      cost: money(1n),
      modelPriceId: null,
      rates: book(),
      error: null,
      completedAt: LATER,
    });
    if (!settled.ok) throw new Error(settled.error.code);
    const refused = retryStep(settled.value);
    expect(refused.ok).toBe(false);
    if (refused.ok) return;
    expect(refused.error.code).toBe("CONVERSATIONS_STEP_ALREADY_SETTLED");
  });
});

describe("stepCost", () => {
  it("answers the exact stored amount", () => {
    const settled = settleStep(open(), {
      status: "SUCCEEDED",
      usage: usage(),
      cost: money(987_654n),
      modelPriceId: null,
      rates: book(),
      error: null,
      completedAt: LATER,
    });
    if (!settled.ok) throw new Error(settled.error.code);
    expect(stepCost(settled.value).microCents).toBe(987_654n);
  });

  it("answers a typed zero, never a bare number, for an unpriced step", () => {
    expect(stepCost(open()).microCents).toBe(0n);
    expect(noCost().microCents).toBe(0n);
    expect(noCost().currency).toBe("USD");
  });
});
