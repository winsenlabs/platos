// The money path, end to end, by EXACT cent strings.
//
// THE ZEROING MUTATION IS M-Y1: replace `cost: moneyFromCentsString(priced.value
// .costCents)` with `cost: money(0n)` in `recordStep`. Every case below that
// names a figure goes red. A suite that asserted only "has a cost" would stay
// green against a system that charged nothing, which is the failure mode this
// file exists to make impossible.
//
// M-Y2 removes the `cacheWriteInputTokens: usage.cacheCreationInputTokens`
// translation in `toStepUsage`; M-Y3 removes the reasoning EXCLUSION from
// `toPricingDraft`. Both change a cent string, and both would be invisible to a
// shape assertion.

import { describe, expect, it } from "vitest";
import { moneyToCentsString } from "@platos/kernel";
import type { GenerationStep } from "@platos/context-providers";

import { recordStep, recordSteps, toRateBook, toStepUsage } from "./turn-steps.js";
import { buildConversationsTestContext, priceTestUsage } from "./testing/index.js";
import { asConversationsIdentifier, type TurnId } from "../domain/index.js";

const TURN = asConversationsIdentifier<TurnId>("turn-1");
const AT = new Date("2026-01-01T00:00:00.000Z");
const LATER = new Date("2026-01-01T00:00:01.000Z");

function generationStep(overrides: Partial<GenerationStep["usage"]> = {}, reasoning = 0): GenerationStep {
  return {
    text: "answer",
    toolCalls: [],
    toolResults: [],
    usage: {
      inputTokens: 10_000,
      outputTokens: 500,
      cacheReadInputTokens: 0,
      cacheWriteInputTokens: 0,
      ...overrides,
    },
    reasoningTokens: reasoning,
    finishReason: "stop",
  };
}

describe("toStepUsage — the one place the two vocabularies meet", () => {
  it("maps `cacheWriteInputTokens` onto the `cacheCreationInputTokens` column", () => {
    const usage = toStepUsage(generationStep({ cacheWriteInputTokens: 1_234 }));
    expect(usage.ok).toBe(true);
    if (!usage.ok) return;
    expect(usage.value.cacheCreationInputTokens).toBe(1_234);
    expect(usage.value.cacheReadInputTokens).toBe(0);
  });

  it("carries the reasoning figure onto the row", () => {
    const usage = toStepUsage(generationStep({}, 321));
    expect(usage.ok).toBe(true);
    if (!usage.ok) return;
    expect(usage.value.reasoningTokens).toBe(321);
  });

  it("refuses a negative count the provider reported", () => {
    const usage = toStepUsage(generationStep({ outputTokens: -1 }));
    expect(usage.ok).toBe(false);
    if (usage.ok) return;
    expect(usage.error.code).toBe("CONVERSATIONS_STEP_USAGE_INVALID");
  });
});

describe("toRateBook", () => {
  it("places the four named rates and leaves an unreported one NULL, not zero", () => {
    const book = toRateBook([
      { rate: "input", usdPerToken: "0.000003000000", source: "LITELLM", observedAt: AT, sourceRef: null },
      { rate: "output", usdPerToken: "0.000015000000", source: "LITELLM", observedAt: AT, sourceRef: null },
    ]);
    expect(book.input?.usdPerToken).toBe("0.000003000000");
    expect(book.output?.usdPerToken).toBe("0.000015000000");
    // A zero rate would be a claim that the tokens were free. A null is the truth.
    expect(book.cacheRead).toBeNull();
    expect(book.cacheWrite).toBeNull();
  });

  it("ignores a rate name the schema has no column for", () => {
    const book = toRateBook([
      { rate: "made-up", usdPerToken: "1.0", source: "LITELLM", observedAt: AT, sourceRef: null },
    ]);
    expect(book.input).toBeNull();
  });
});

describe("recordStep", () => {
  it("prices a step to an EXACT cent string", async () => {
    const context = buildConversationsTestContext();
    const step = await recordStep(context.dependencies, {
      turnId: TURN,
      model: "anthropic:claude-test",
      sequence: 1,
      generationStep: generationStep(),
      startedAt: AT,
      completedAt: LATER,
    });
    expect(step.ok).toBe(true);
    if (!step.ok) return;
    // 10,000 fresh input at 3e-6 USD/token + 500 output at 1.5e-5 USD/token
    //   = 0.03 + 0.0075 USD = 3.75 cents.
    expect(moneyToCentsString(step.value.cost!)).toBe("3.750000");
    expect(step.value.cost!.microCents).toBe(3_750_000n);
    expect(step.value.latencyMs).toBe(1_000);
    expect(step.value.modelPriceId).toBe("price-1");
  });

  it("charges a CACHED step less than an uncached one with the same input total", async () => {
    const context = buildConversationsTestContext();
    const uncached = await recordStep(context.dependencies, {
      turnId: TURN,
      model: "m",
      sequence: 1,
      generationStep: generationStep({ inputTokens: 10_000, outputTokens: 0 }),
      startedAt: AT,
      completedAt: LATER,
    });
    const cached = await recordStep(context.dependencies, {
      turnId: TURN,
      model: "m",
      sequence: 2,
      generationStep: generationStep({
        inputTokens: 10_000,
        outputTokens: 0,
        cacheReadInputTokens: 9_000,
      }),
      startedAt: AT,
      completedAt: LATER,
    });
    if (!uncached.ok || !cached.ok) throw new Error("expected both to price");
    // 10,000 x 3e-6 = 3 cents; 1,000 x 3e-6 + 9,000 x 3e-7 = 0.3 + 0.27 = 0.57.
    expect(uncached.value.cost!.microCents).toBe(3_000_000n);
    expect(cached.value.cost!.microCents).toBe(570_000n);
    // A surface that flattened the two input figures would price these the same.
    expect(cached.value.cost!.microCents).toBeLessThan(uncached.value.cost!.microCents);
  });

  it("charges cache WRITE at a different rate from cache READ", async () => {
    const context = buildConversationsTestContext();
    const read = await recordStep(context.dependencies, {
      turnId: TURN,
      model: "m",
      sequence: 1,
      generationStep: generationStep({ inputTokens: 8_000, outputTokens: 0, cacheReadInputTokens: 8_000 }),
      startedAt: AT,
      completedAt: LATER,
    });
    const write = await recordStep(context.dependencies, {
      turnId: TURN,
      model: "m",
      sequence: 2,
      generationStep: generationStep({
        inputTokens: 8_000,
        outputTokens: 0,
        cacheWriteInputTokens: 8_000,
      }),
      startedAt: AT,
      completedAt: LATER,
    });
    if (!read.ok || !write.ok) throw new Error("expected both to price");
    expect(read.value.cost!.microCents).toBe(240_000n);
    expect(write.value.cost!.microCents).toBe(3_000_000n);
    expect(read.value.cost!.microCents).not.toBe(write.value.cost!.microCents);
  });

  it("does NOT charge for reasoning, which is already inside the output count", async () => {
    const context = buildConversationsTestContext();
    const without = await recordStep(context.dependencies, {
      turnId: TURN,
      model: "m",
      sequence: 1,
      generationStep: generationStep({ inputTokens: 1_000, outputTokens: 400 }, 0),
      startedAt: AT,
      completedAt: LATER,
    });
    const with_ = await recordStep(context.dependencies, {
      turnId: TURN,
      model: "m",
      sequence: 2,
      generationStep: generationStep({ inputTokens: 1_000, outputTokens: 400 }, 400),
      startedAt: AT,
      completedAt: LATER,
    });
    if (!without.ok || !with_.ok) throw new Error("expected both to price");
    expect(without.value.cost!.microCents).toBe(with_.value.cost!.microCents);
    expect(with_.value.usage.reasoningTokens).toBe(400);
    // Tracked on the row, never added to the priced total.
    expect(context.providers.priced.at(-1)?.usage).not.toHaveProperty("reasoning");
  });

  it("REFUSES a priced step whose rate card came back empty", async () => {
    const context = buildConversationsTestContext();
    context.providers.omitRates = true;
    const refused = await recordStep(context.dependencies, {
      turnId: TURN,
      model: "m",
      sequence: 1,
      generationStep: generationStep(),
      startedAt: AT,
      completedAt: LATER,
    });
    expect(refused.ok).toBe(false);
    if (refused.ok) return;
    // The exact fixture defect that left a whole money path dead and green in
    // another package: with no rates, every cost is zero and nothing complains.
    expect(refused.error.code).toBe("CONVERSATIONS_STEP_RATE_MISSING");
  });

  it("returns `providers`' own refusal unchanged when it cannot price", async () => {
    const context = buildConversationsTestContext();
    context.providers.failWith("no card for that model");
    const refused = await recordStep(context.dependencies, {
      turnId: TURN,
      model: "m",
      sequence: 1,
      generationStep: generationStep(),
      startedAt: AT,
      completedAt: LATER,
    });
    expect(refused.ok).toBe(false);
    if (refused.ok) return;
    expect(refused.error.code).toBe("CONVERSATIONS_REPOSITORY_UNAVAILABLE");
  });
});

describe("recordSteps", () => {
  it("numbers steps from the sequence it was given and prices each separately", async () => {
    const context = buildConversationsTestContext();
    const steps = await recordSteps(
      context.dependencies,
      TURN,
      "anthropic:claude-test",
      [generationStep(), generationStep({ inputTokens: 2_000, outputTokens: 100 })],
      1,
      AT,
      LATER,
    );
    expect(steps.ok).toBe(true);
    if (!steps.ok) return;
    expect(steps.value.map((step) => step.sequence)).toEqual([1, 2]);
    expect(steps.value[0]?.cost?.microCents).toBe(3_750_000n);
    // 2,000 fresh input at 3e-6 + 100 output at 1.5e-5 = 0.006 + 0.0015 USD
    //   = 0.75 cents.
    expect(steps.value[1]?.cost?.microCents).toBe(750_000n);
    // Two pricing calls, not one over summed tokens: that is what makes the
    // turn total the exact sum of the step totals.
    expect(context.providers.priced).toHaveLength(2);
  });

  it("starts at the sequence a DELEGATED run is given, not always at one", async () => {
    const context = buildConversationsTestContext();
    const steps = await recordSteps(
      context.dependencies,
      TURN,
      "m",
      [generationStep(), generationStep()],
      7,
      AT,
      LATER,
    );
    expect(steps.ok).toBe(true);
    if (!steps.ok) return;
    expect(steps.value.map((step) => step.sequence)).toEqual([7, 8]);
  });

  it("FAILS on the first refusal rather than reporting a partial total", async () => {
    const context = buildConversationsTestContext();
    const refused = await recordSteps(
      context.dependencies,
      TURN,
      "m",
      [generationStep(), generationStep({ outputTokens: -1 }), generationStep()],
      1,
      AT,
      LATER,
    );
    expect(refused.ok).toBe(false);
    if (refused.ok) return;
    expect(refused.error.code).toBe("CONVERSATIONS_STEP_USAGE_INVALID");
  });

  it("agrees with the rate card's own arithmetic on a mixed step", async () => {
    const context = buildConversationsTestContext();
    const steps = await recordSteps(
      context.dependencies,
      TURN,
      "m",
      [
        generationStep({
          inputTokens: 12_345,
          outputTokens: 678,
          cacheReadInputTokens: 4_321,
          cacheWriteInputTokens: 1_000,
        }),
      ],
      1,
      AT,
      LATER,
    );
    if (!steps.ok) throw new Error(steps.error.code);
    const expected = priceTestUsage({
      input: 12_345 - 4_321 - 1_000,
      output: 678,
      cacheRead: 4_321,
      cacheWrite: 1_000,
    });
    expect(moneyToCentsString(steps.value[0]!.cost!)).toBe(expected);
    // 7,024 x 3e6 + 678 x 15e6 + 4,321 x 3e5 + 1,000 x 3.75e6 pico-USD
    //   = 36,288,300,000 pico-USD = 3,628,830 micro-cents.
    expect(steps.value[0]!.cost!.microCents).toBe(3_628_830n);
  });
});
