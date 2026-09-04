// Usage, by EXACT values.
//
// A TEST THAT WOULD STILL PASS WITH EVERY NUMBER ZERO IS WORTH NOTHING, so every
// assertion below names a figure. The zeroing mutation is written out in
// `mutations.json` as M-U1: replace `admitted[field] = value` with
// `admitted[field] = 0` in `stepUsage`, and the named case that goes red is
// "admits a report and keeps every one of the five figures".

import { describe, expect, it } from "vitest";

import {
  billableStepTokens,
  NO_STEP_USAGE,
  stepUsage,
  sumStepUsage,
  totalStepTokens,
} from "./step-usage.js";

describe("stepUsage", () => {
  it("admits a report and keeps every one of the five figures", () => {
    const admitted = stepUsage({
      inputTokens: 14_788,
      outputTokens: 512,
      cacheReadInputTokens: 9_000,
      cacheCreationInputTokens: 1_200,
      reasoningTokens: 64,
    });
    expect(admitted.ok).toBe(true);
    if (!admitted.ok) return;
    expect(admitted.value.inputTokens).toBe(14_788);
    expect(admitted.value.outputTokens).toBe(512);
    expect(admitted.value.cacheReadInputTokens).toBe(9_000);
    expect(admitted.value.cacheCreationInputTokens).toBe(1_200);
    expect(admitted.value.reasoningTokens).toBe(64);
  });

  it("defaults an absent figure to zero rather than to undefined", () => {
    const admitted = stepUsage({ inputTokens: 10 });
    expect(admitted.ok).toBe(true);
    if (!admitted.ok) return;
    expect(admitted.value).toEqual(NO_STEP_USAGE_WITH(10));
  });

  it("refuses a negative count, naming the field", () => {
    const refused = stepUsage({ inputTokens: 10, outputTokens: -1 });
    expect(refused.ok).toBe(false);
    if (refused.ok) return;
    expect(refused.error.code).toBe("CONVERSATIONS_STEP_USAGE_INVALID");
    expect(refused.error.fields[0]?.field).toBe("outputTokens");
  });

  it("refuses a fractional count, which no token counter produces", () => {
    const refused = stepUsage({ cacheReadInputTokens: 1.5 });
    expect(refused.ok).toBe(false);
    if (refused.ok) return;
    expect(refused.error.code).toBe("CONVERSATIONS_STEP_USAGE_INVALID");
    expect(refused.error.fields[0]?.field).toBe("cacheReadInputTokens");
  });

  it("refuses each of the five fields by its own name", () => {
    const fields = [
      "inputTokens",
      "outputTokens",
      "cacheCreationInputTokens",
      "cacheReadInputTokens",
      "reasoningTokens",
    ] as const;
    for (const field of fields) {
      const refused = stepUsage({ [field]: -5 });
      expect(refused.ok).toBe(false);
      if (refused.ok) continue;
      expect(refused.error.fields[0]?.field).toBe(field);
    }
  });
});

describe("billableStepTokens", () => {
  it("subtracts BOTH cache figures from the input total, exactly", () => {
    const usage = unwrapUsage({
      inputTokens: 10_000,
      outputTokens: 500,
      cacheReadInputTokens: 6_000,
      cacheCreationInputTokens: 1_000,
    });
    const billable = billableStepTokens(usage);
    expect(billable.freshInputTokens).toBe(3_000);
    expect(billable.cacheReadInputTokens).toBe(6_000);
    expect(billable.cacheWriteInputTokens).toBe(1_000);
    expect(billable.outputTokens).toBe(500);
  });

  it("never merges the two cache figures, because four rates charge them", () => {
    const usage = unwrapUsage({
      inputTokens: 5_000,
      cacheReadInputTokens: 3_000,
      cacheCreationInputTokens: 1_000,
    });
    const billable = billableStepTokens(usage);
    expect(billable.cacheReadInputTokens).not.toBe(billable.cacheWriteInputTokens);
    expect(billable.cacheReadInputTokens).toBe(3_000);
    expect(billable.cacheWriteInputTokens).toBe(1_000);
  });

  it("floors the fresh figure at zero when a provider over-reports its cache", () => {
    const usage = unwrapUsage({
      inputTokens: 100,
      cacheReadInputTokens: 400,
    });
    expect(billableStepTokens(usage).freshInputTokens).toBe(0);
    // The RAW column keeps what was reported, so the inconsistency stays visible.
    expect(usage.cacheReadInputTokens).toBe(400);
  });
});

describe("totalStepTokens", () => {
  it("counts input and output once each, cache included in the input", () => {
    const usage = unwrapUsage({
      inputTokens: 1_000,
      outputTokens: 250,
      cacheReadInputTokens: 800,
    });
    expect(totalStepTokens(usage)).toBe(1_250);
  });
});

describe("sumStepUsage — the turn total is DERIVED", () => {
  it("sums three steps to exactly the figures they carry", () => {
    const total = sumStepUsage([
      unwrapUsage({ inputTokens: 10_000, outputTokens: 100, cacheReadInputTokens: 8_000 }),
      unwrapUsage({ inputTokens: 20_000, outputTokens: 200, cacheReadInputTokens: 16_000 }),
      unwrapUsage({ inputTokens: 9_795, outputTokens: 300, cacheReadInputTokens: 5_000 }),
    ]);
    expect(total.inputTokens).toBe(39_795);
    expect(total.outputTokens).toBe(600);
    expect(total.cacheReadInputTokens).toBe(29_000);
  });

  it("does not report the LAST step's figure as the turn's, which is the 14,788 bug", () => {
    // The extraction source kept the last step's token-detail blob and emitted it
    // beside an accumulated total, so one usage record carried two disagreeing
    // cache-read numbers for one turn: 14,788 from the last step beside 39,795
    // summed across all of them. Here there is one number and it is the sum.
    const steps = [
      unwrapUsage({ inputTokens: 1, cacheReadInputTokens: 25_007 - 25_006 }),
      unwrapUsage({ inputTokens: 25_007, cacheReadInputTokens: 25_007 }),
      unwrapUsage({ inputTokens: 14_788, cacheReadInputTokens: 14_788 }),
    ];
    const total = sumStepUsage(steps);
    expect(total.cacheReadInputTokens).toBe(39_796);
    expect(total.cacheReadInputTokens).not.toBe(steps[2]?.cacheReadInputTokens);
  });

  it("an empty turn is exactly zero on every figure, and that is not a null", () => {
    expect(sumStepUsage([])).toEqual(NO_STEP_USAGE);
  });
});

function unwrapUsage(draft: Parameters<typeof stepUsage>[0]) {
  const admitted = stepUsage(draft);
  if (!admitted.ok) throw new Error(admitted.error.code);
  return admitted.value;
}

function NO_STEP_USAGE_WITH(inputTokens: number) {
  return { ...NO_STEP_USAGE, inputTokens };
}
