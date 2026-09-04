// The rule that keeps a `Step` row able to explain its own charge.
//
// THE DEFECT THIS SUITE EXISTS FOR. A pricing fixture that carried no rate card
// left an entire money path unexecuted in another package this week while every
// case stayed green: with no rate to apply, every cost came out zero, and
// "priced at zero" and "not priced at all" were the same observable. The two
// cases below — a non-zero count with a null rate REFUSED, a zero count with a
// null rate ADMITTED — are what make them different observables.
//
// The mutation is M-R1: delete the `tokens > 0 &&` conjunct, or delete the whole
// `if`. Deleting the guard turns "refuses a charged rate that is absent" red;
// deleting only the conjunct turns "admits an absent rate whose count is zero"
// red. Two mutations, two named cases, because the guard has two halves.

import { describe, expect, it } from "vitest";

import {
  chargedTokensByRate,
  NO_STEP_RATES,
  ratesFullyObserved,
  requireExplainedRates,
  STEP_RATE_NAMES,
  type StepRate,
  type StepRateBook,
} from "./step-rates.js";
import { stepUsage } from "./step-usage.js";

const OBSERVED = new Date("2026-01-01T00:00:00.000Z");

function rate(usdPerToken: string, source: StepRate["source"] = "LITELLM"): StepRate {
  return { usdPerToken, source, observedAt: OBSERVED, sourceRef: null };
}

function fullBook(): StepRateBook {
  return {
    input: rate("0.000003000000"),
    output: rate("0.000015000000"),
    cacheRead: rate("0.000000300000"),
    cacheWrite: rate("0.000003750000"),
  };
}

function usage(draft: Parameters<typeof stepUsage>[0]) {
  const admitted = stepUsage(draft);
  if (!admitted.ok) throw new Error(admitted.error.code);
  return admitted.value;
}

describe("chargedTokensByRate", () => {
  it("maps the four rate names onto the four billable figures, exactly", () => {
    const charged = chargedTokensByRate(
      usage({
        inputTokens: 10_000,
        outputTokens: 400,
        cacheReadInputTokens: 6_000,
        cacheCreationInputTokens: 1_000,
      }),
    );
    expect(charged.input).toBe(3_000);
    expect(charged.output).toBe(400);
    expect(charged.cacheRead).toBe(6_000);
    expect(charged.cacheWrite).toBe(1_000);
  });

  it("names exactly the four rates the schema has columns for", () => {
    expect([...STEP_RATE_NAMES]).toEqual(["input", "output", "cacheRead", "cacheWrite"]);
  });
});

describe("requireExplainedRates", () => {
  it("admits a step whose four counts all have rates", () => {
    const admitted = requireExplainedRates(
      usage({
        inputTokens: 10_000,
        outputTokens: 400,
        cacheReadInputTokens: 6_000,
        cacheCreationInputTokens: 1_000,
      }),
      fullBook(),
    );
    expect(admitted.ok).toBe(true);
  });

  it("admits an absent rate whose count is zero — a step that never ran", () => {
    const admitted = requireExplainedRates(usage({}), NO_STEP_RATES);
    expect(admitted.ok).toBe(true);
    if (!admitted.ok) return;
    expect(admitted.value).toBe(NO_STEP_RATES);
  });

  it("refuses a charged rate that is absent, and names the column", () => {
    const refused = requireExplainedRates(
      usage({ inputTokens: 5_000, cacheReadInputTokens: 5_000 }),
      { ...fullBook(), cacheRead: null },
    );
    expect(refused.ok).toBe(false);
    if (refused.ok) return;
    expect(refused.error.code).toBe("CONVERSATIONS_STEP_RATE_MISSING");
    expect(refused.error.details.field).toBe("cacheReadRate");
    expect(refused.error.details.tokens).toBe(5_000);
  });

  it("refuses each of the four columns by name when its own count is charged", () => {
    const cases = [
      { draft: { inputTokens: 100 }, absent: "input", column: "inputRate", tokens: 100 },
      { draft: { outputTokens: 40 }, absent: "output", column: "outputRate", tokens: 40 },
      {
        draft: { inputTokens: 90, cacheReadInputTokens: 90 },
        absent: "cacheRead",
        column: "cacheReadRate",
        tokens: 90,
      },
      {
        draft: { inputTokens: 70, cacheCreationInputTokens: 70 },
        absent: "cacheWrite",
        column: "cacheWriteRate",
        tokens: 70,
      },
    ] as const;

    for (const testCase of cases) {
      const refused = requireExplainedRates(usage(testCase.draft), {
        ...fullBook(),
        [testCase.absent]: null,
      } as StepRateBook);
      expect(refused.ok).toBe(false);
      if (refused.ok) continue;
      expect(refused.error.details.field).toBe(testCase.column);
      expect(refused.error.details.tokens).toBe(testCase.tokens);
    }
  });

  it("answers the SAME book it was given, so a caller cannot check one and store another", () => {
    const book = fullBook();
    const admitted = requireExplainedRates(usage({ inputTokens: 1 }), book);
    expect(admitted.ok).toBe(true);
    if (!admitted.ok) return;
    expect(admitted.value).toBe(book);
  });
});

describe("ratesFullyObserved", () => {
  it("is true when every present rate came from a card or a live provider", () => {
    expect(ratesFullyObserved(fullBook())).toBe(true);
  });

  it("is FALSE when any rate was UNAVAILABLE — the cost is then a floor", () => {
    const book = { ...fullBook(), cacheWrite: rate("0.000000000000", "UNAVAILABLE") };
    expect(ratesFullyObserved(book)).toBe(false);
  });

  it("is true when a rate is absent, because absence is already refused elsewhere", () => {
    expect(ratesFullyObserved(NO_STEP_RATES)).toBe(true);
  });
});
