import { describe, expect, it } from "vitest";

import {
  modelGeneration,
  passBudget,
  stepBudget,
  sumStepUsage,
  toolCatalogue,
  type GenerationStep,
  type ToolDefinition,
} from "./generation.js";
import { billableTokens, type TokenUsage } from "./token-usage.js";

function tool(name: string): ToolDefinition {
  return { name, description: `runs ${name}`, inputSchema: { type: "object", properties: {} } };
}

function usage(
  inputTokens: number,
  outputTokens: number,
  cacheReadInputTokens = 0,
  cacheWriteInputTokens = 0,
): TokenUsage {
  return { inputTokens, outputTokens, cacheReadInputTokens, cacheWriteInputTokens };
}

function step(overrides: Partial<GenerationStep> = {}): GenerationStep {
  return {
    text: "",
    toolCalls: [],
    toolResults: [],
    usage: usage(0, 0),
    reasoningTokens: 0,
    finishReason: "stop",
    ...overrides,
  };
}

describe("the tool catalogue", () => {
  it("accepts distinct names and hands back exactly what it was given", () => {
    const built = toolCatalogue([tool("search"), tool("fetch")]);
    if (!built.ok) throw new Error(`unreachable: ${built.error.code}`);
    expect(built.value.map((entry) => entry.name)).toEqual(["search", "fetch"]);
  });

  it("accepts no tools at all, which is a generation with no round trips", () => {
    const built = toolCatalogue([]);
    if (!built.ok) throw new Error("unreachable");
    expect(built.value).toEqual([]);
  });

  it("refuses two definitions of one name, naming it", () => {
    const built = toolCatalogue([tool("search"), tool("fetch"), tool("search")]);
    expect(built.ok).toBe(false);
    if (built.ok) throw new Error("unreachable");
    expect(built.error.code).toBe("PROVIDERS_TOOL_NAME_DUPLICATED");
    expect(built.error.details).toEqual({ toolName: "search" });
  });
});

describe("the step budget", () => {
  it("accepts one, which is a single call with no round trip", () => {
    const built = stepBudget(1);
    if (!built.ok) throw new Error("unreachable");
    expect(built.value).toBe(1);
  });

  it("refuses zero rather than reading it as unlimited", () => {
    const built = stepBudget(0);
    expect(built.ok).toBe(false);
    if (built.ok) throw new Error("unreachable");
    expect(built.error.code).toBe("PROVIDERS_STEP_BUDGET_INVALID");
    expect(built.error.details).toEqual({ maxSteps: 0 });
  });

  it("refuses a negative and a fractional budget", () => {
    expect(stepBudget(-1).ok).toBe(false);
    expect(stepBudget(1.5).ok).toBe(false);
    expect(stepBudget(Number.NaN).ok).toBe(false);
  });
});

describe("the pass budget", () => {
  it("bounds the schema-correction loop under its OWN code", () => {
    // A STEP is a tool round trip; a PASS is a whole second generation with the
    // first one's output quoted back inside it. Sharing one code would leave an
    // operator unable to tell which of the two budgets was wrong.
    const built = passBudget(0);
    expect(built.ok).toBe(false);
    if (built.ok) throw new Error("unreachable");
    expect(built.error.code).toBe("PROVIDERS_PASS_BUDGET_INVALID");
    expect(built.error.details).toEqual({ maxPasses: 0 });
    expect(built.error.code).not.toBe(stepBudget(0).ok ? "" : "PROVIDERS_STEP_BUDGET_INVALID");

    expect(passBudget(1).ok).toBe(true);
    expect(passBudget(-1).ok).toBe(false);
    expect(passBudget(1.5).ok).toBe(false);
  });
});

describe("adding the steps up", () => {
  it("sums each of the four counts independently", () => {
    const summed = sumStepUsage([
      step({ usage: usage(100, 10, 40, 20) }),
      step({ usage: usage(250, 33, 200, 5) }),
    ]);
    if (!summed.ok) throw new Error(`unreachable: ${summed.error.code}`);
    expect(summed.value).toEqual({
      inputTokens: 350,
      outputTokens: 43,
      cacheReadInputTokens: 240,
      cacheWriteInputTokens: 25,
    });
  });

  it("sums an empty list to nothing rather than refusing", () => {
    const summed = sumStepUsage([]);
    if (!summed.ok) throw new Error("unreachable");
    expect(summed.value).toEqual({
      inputTokens: 0,
      outputTokens: 0,
      cacheReadInputTokens: 0,
      cacheWriteInputTokens: 0,
    });
  });

  it("refuses a sum whose cache counts exceed its input count", () => {
    // A `GenerationStep` is a plain interface, so a step assembled by hand -- by
    // an adapter mapping a provider's payload, say -- can carry a reading that
    // never went through `tokenUsage`. This is where that is caught, and it is
    // caught by REFUSING rather than by clamping: a clamped negative remainder
    // is a corrupt reading wearing a plausible bill.
    const summed = sumStepUsage([step({ usage: usage(10, 1, 40, 0) })]);
    expect(summed.ok).toBe(false);
    if (summed.ok) throw new Error("unreachable");
    expect(summed.error.code).toBe("PROVIDERS_TOKEN_USAGE_INVALID");
  });
});

describe("assembling the answer", () => {
  const steps = [
    step({ text: "", usage: usage(1_000, 20, 0, 900), finishReason: "tool-calls" }),
    step({ text: "done", usage: usage(1_200, 40, 900, 0), reasoningTokens: 12 }),
  ];

  it("derives the total from the steps rather than accepting one", () => {
    const built = modelGeneration({ text: "done", steps, finishReason: "stop" });
    if (!built.ok) throw new Error(`unreachable: ${built.error.code}`);
    expect(built.value.totalUsage).toEqual({
      inputTokens: 2_200,
      outputTokens: 60,
      cacheReadInputTokens: 900,
      cacheWriteInputTokens: 900,
    });
    expect(built.value.steps).toHaveLength(2);
  });

  it("keeps the cache counts OUT of the fresh-input figure that is billed", () => {
    // The reason the two counts are carried separately at all: `price-card.ts`
    // charges four rates, and a surface reporting one input figure would make a
    // cached turn cost the same as an uncached one.
    const built = modelGeneration({ text: "done", steps, finishReason: "stop" });
    if (!built.ok) throw new Error("unreachable");
    expect(billableTokens(built.value.totalUsage)).toEqual({
      freshInputTokens: 400,
      outputTokens: 60,
      cacheReadInputTokens: 900,
      cacheWriteInputTokens: 900,
    });
  });

  it("reports reasoning tokens per step and never folds them into the bill", () => {
    const built = modelGeneration({ text: "done", steps, finishReason: "stop" });
    if (!built.ok) throw new Error("unreachable");
    expect(built.value.steps[1]?.reasoningTokens).toBe(12);
    // 60 is the sum of the two steps' output counts, unchanged by the 12.
    expect(built.value.totalUsage.outputTokens).toBe(60);
  });

  it("leaves `object` null unless the caller asked for one", () => {
    const text = modelGeneration({ text: "hello", steps: [step()], finishReason: "stop" });
    if (!text.ok) throw new Error("unreachable");
    expect(text.value.object).toBeNull();

    const shaped = modelGeneration({ text: "{}", object: { a: 1 }, steps: [step()], finishReason: "stop" });
    if (!shaped.ok) throw new Error("unreachable");
    expect(shaped.value.object).toEqual({ a: 1 });
  });

  it("refuses to assemble at all when a step's reading is corrupt", () => {
    const built = modelGeneration({
      text: "",
      steps: [step({ usage: usage(5, 1, 9, 0) })],
      finishReason: "stop",
    });
    expect(built.ok).toBe(false);
    if (built.ok) throw new Error("unreachable");
    expect(built.error.code).toBe("PROVIDERS_TOKEN_USAGE_INVALID");
  });
});
