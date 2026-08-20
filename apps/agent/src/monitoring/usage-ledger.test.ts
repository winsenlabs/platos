import { describe, expect, it } from "vitest";
import {
  addUsage,
  billableCostCents,
  billableCostFromRollup,
  EMPTY_USAGE,
  freshInputTokens,
  isCompletedTask,
  laneCostsFromRollup,
  laneForAuxiliaryKind,
  laneRollupField,
  ROLLUP_FIELD,
  roundUsage,
  summariseTurns,
  turnTokenDetails,
  usageFromRollup,
  usageFromStep,
  usageFromTurn,
  USAGE_LANES,
  type RollupHash,
} from "./usage-ledger";

/**
 * A task is ONE COMPLETED TURN.
 *
 * The number that made this module necessary said "Walle ran 322 tasks this
 * week." It had not: the counter was incremented per tool call, so an agent
 * that searched, read three documents and replied reported five jobs done.
 */
describe("a task is one completed turn", () => {
  const turnWithSixToolCalls = {
    status: "SUCCEEDED",
    costCents: 3.25,
    steps: [
      { inputTokens: 12_000, outputTokens: 90, costCents: 1.1 },
      { inputTokens: 14_000, outputTokens: 120, costCents: 1.2 },
      { inputTokens: 15_000, outputTokens: 400, costCents: 0.95 },
    ],
  };

  it("counts a turn with N tool calls as exactly one task", () => {
    // Six searches and reads across three model steps. One job done.
    expect(usageFromTurn(turnWithSixToolCalls).tasks).toBe(1);
    expect(summariseTurns([turnWithSixToolCalls]).tasks).toBe(1);
  });

  it("counts model steps as zero tasks on their own", () => {
    for (const step of turnWithSixToolCalls.steps) {
      expect(usageFromStep(step).tasks).toBe(0);
    }
  });

  it("counts three turns as three tasks however many steps they took", () => {
    const summary = summariseTurns([
      turnWithSixToolCalls,
      turnWithSixToolCalls,
      turnWithSixToolCalls,
    ]);
    expect(summary.tasks).toBe(3);
    // Nine model steps produced three tasks. The two numbers are different and
    // the ledger must never conflate them.
    expect(summary.tasks).not.toBe(9);
  });

  it("does not count a turn that never reached the model", () => {
    // Otherwise a failing agent inflates the number it is judged by.
    expect(isCompletedTask({ status: "SUCCEEDED", steps: [] })).toBe(false);
    expect(
      isCompletedTask({ status: "SUCCEEDED", steps: [{ inputTokens: 0, outputTokens: 0 }] }),
    ).toBe(false);
    expect(isCompletedTask(null)).toBe(false);
  });

  it("does not count a failed turn even when it burned tokens", () => {
    const failed = { status: "FAILED", steps: [{ inputTokens: 9_000, outputTokens: 0 }] };
    expect(isCompletedTask(failed)).toBe(false);
    // The spend is still real and still counted.
    expect(usageFromTurn({ ...failed, costCents: 1.8 }).costCents).toBe(1.8);
  });

  it("reads the task counter and never the model-call counter", () => {
    // `calls` is bumped by embeddings, compaction and thread auto-naming as
    // well as by turns. Reading it as a task count is the original bug.
    const hash: RollupHash = { tasks: "4", calls: "17", runs: "4" };
    expect(usageFromRollup(hash).tasks).toBe(4);
  });

  it("falls back to `runs` but never to `calls` on a pre-ledger rollup", () => {
    expect(usageFromRollup({ runs: "6", calls: "31" }).tasks).toBe(6);
    expect(usageFromRollup({ calls: "31" }).tasks).toBe(0);
  });
});

/**
 * Budget enforcement read a value understated by 10x. Measured on the live
 * deployment for 2026-07-31: cost_with_cache 25.70c against cost_cents 2.47c.
 */
describe("billable cost is the cache-aware figure", () => {
  it("prefers the cache-adjusted figure", () => {
    expect(billableCostCents({ cost_cents: 2.47, cost_with_cache_cents: 25.7 })).toBe(25.7);
    expect(
      billableCostFromRollup({ cost_cents: "2.47", cost_with_cache_cents: "25.7" }),
    ).toBe(25.7);
  });

  it("does NOT fall back when the cache-adjusted figure is genuinely zero", () => {
    // A real turn recorded cost_cents 0 against cost_with_cache 0.6861.
    // Falling back on falsy would resurrect the wrong number.
    expect(billableCostCents({ cost_cents: 5, cost_with_cache_cents: 0 })).toBe(0);
    expect(billableCostFromRollup({ cost_cents: "5", cost_with_cache_cents: "0" })).toBe(0);
  });

  it("falls back only for rows carrying no cache-adjusted figure at all", () => {
    expect(billableCostCents({ cost_cents: 3.5 })).toBe(3.5);
    expect(billableCostFromRollup({ cost_cents: "3.5" })).toBe(3.5);
    expect(billableCostFromRollup({ cost_cents: "3.5", cost_with_cache_cents: "" })).toBe(3.5);
    expect(billableCostCents({})).toBe(0);
    expect(billableCostCents(null)).toBe(0);
    expect(billableCostFromRollup(undefined)).toBe(0);
  });

  it("ignores a corrupt value rather than reporting NaN spend", () => {
    // hincrbyfloat cannot write this, but an operator with redis-cli can, and a
    // NaN propagating into a budget comparison silently disables the cap.
    expect(billableCostFromRollup({ cost_with_cache_cents: "not-a-number" })).toBe(0);
    expect(Number.isFinite(billableCostFromRollup({ cost_cents: "1e999" }))).toBe(true);
  });
});

describe("token lanes", () => {
  it("treats inputTokens as inclusive of the cache slice", () => {
    // Adding the cache counters back double-counts: the provider already
    // included them in the input total.
    const usage = usageFromStep({
      inputTokens: 40_000,
      cacheReadInputTokens: 36_000,
      cacheCreationInputTokens: 2_000,
      outputTokens: 500,
    });
    expect(usage.inputTokens).toBe(40_000);
    expect(usage.freshInputTokens).toBe(2_000);
  });

  it("derives the fresh-token slice exactly once, from one base", () => {
    // Three call sites computed this from three different bases, which is how
    // one turn showed "no-cache tokens 3" on one panel and "9" on another.
    expect(freshInputTokens(9, 4, 2)).toBe(3);
    expect(freshInputTokens(40_000, 36_000, 2_000)).toBe(2_000);
  });

  it("clamps a cache slice larger than the input total to zero", () => {
    // Providers occasionally report this. A negative token count on a
    // dashboard is worse than a zero.
    expect(freshInputTokens(100, 90, 30)).toBe(0);
    expect(usageFromRollup({ input_tokens: "100", cache_read_input_tokens: "150" })
      .freshInputTokens).toBe(0);
  });

  it("keeps the fresh slice additive across a window", () => {
    const a = usageFromStep({ inputTokens: 100, cacheReadInputTokens: 60 });
    const b = usageFromStep({ inputTokens: 200, cacheReadInputTokens: 150 });
    expect(addUsage(a, b).freshInputTokens).toBe(40 + 50);
  });
});

/**
 * The turn-level usage event carried two disagreeing cache-read numbers:
 * `inputTokenDetails.cacheReadTokens` 14,788 beside `cacheReadInputTokens`
 * 39,795. The first was the LAST step's blob, the second the sum across steps.
 */
describe("the two cache-read fields agree", () => {
  it("projects the detail blob from the same accumulators as the totals", () => {
    const totals = { cacheReadTokens: 39_795, cacheWriteTokens: 1_204, reasoningTokens: 0 };
    const details = turnTokenDetails(totals);
    expect(details.inputTokenDetails?.cacheReadTokens).toBe(totals.cacheReadTokens);
    expect(details.inputTokenDetails?.cacheWriteTokens).toBe(totals.cacheWriteTokens);
    // The 2.7x gap is gone because there is only one number now.
    expect(details.inputTokenDetails?.cacheReadTokens).not.toBe(14_788);
  });

  it("stays silent rather than asserting a zero it did not measure", () => {
    const details = turnTokenDetails({
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
      reasoningTokens: 0,
    });
    expect(details.inputTokenDetails).toBeUndefined();
    expect(details.outputTokenDetails).toBeUndefined();
  });

  it("emits reasoning independently of the cache lanes", () => {
    const details = turnTokenDetails({
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
      reasoningTokens: 812,
    });
    expect(details.inputTokenDetails).toBeUndefined();
    expect(details.outputTokenDetails?.reasoningTokens).toBe(812);
  });

  it("agrees with the fresh-token slice computed from the same turn", () => {
    // The reported pair was noCacheTokens 3 against noCacheInputTokens 9, from
    // per-step and turn-total bases. One projection, one answer.
    const turnTotals = { inputTokens: 41_008, cacheReadTokens: 39_795, cacheWriteTokens: 1_204 };
    const details = turnTokenDetails({ ...turnTotals, reasoningTokens: 0 });
    expect(
      freshInputTokens(
        turnTotals.inputTokens,
        details.inputTokenDetails!.cacheReadTokens,
        details.inputTokenDetails!.cacheWriteTokens,
      ),
    ).toBe(freshInputTokens(
      turnTotals.inputTokens,
      turnTotals.cacheReadTokens,
      turnTotals.cacheWriteTokens,
    ));
  });
});

describe("spend lanes", () => {
  const hash: RollupHash = {
    cost_with_cache_cents: "100",
    "cost_cents:embedding": "12",
    "cost_cents:extraction": "8",
    "cost_cents:eval-judge": "5",
    "cost_cents:tier:skill": "15",
  };

  it("splits spend into the four tagged lanes plus an inference residual", () => {
    const lanes = laneCostsFromRollup(hash);
    expect(lanes.embedding).toBe(12);
    expect(lanes.extraction).toBe(8);
    expect(lanes.judge).toBe(5);
    expect(lanes.skill).toBe(15);
    expect(lanes.inference).toBe(60);
  });

  it("makes the lanes sum back to the headline total by construction", () => {
    const lanes = laneCostsFromRollup(hash);
    const summed = USAGE_LANES.reduce((total, lane) => total + lanes[lane], 0);
    expect(summed).toBeCloseTo(billableCostFromRollup(hash), 10);
  });

  it("puts everything untagged in inference rather than losing it", () => {
    // Compaction, thread auto-naming and route preflight are model calls made
    // on a turn's behalf; they have no lane field and must not vanish.
    const untagged: RollupHash = {
      cost_with_cache_cents: "20",
      "cost_cents:compaction": "4",
      "cost_cents:thread-auto-name": "1",
    };
    expect(laneCostsFromRollup(untagged).inference).toBe(20);
  });

  it("never reports a negative inference lane", () => {
    // A partially-expired hash can keep a tagged field past its total.
    const skewed: RollupHash = { cost_cents: "1", "cost_cents:embedding": "9" };
    expect(laneCostsFromRollup(skewed).inference).toBe(0);
  });

  it("maps auxiliary kinds onto lanes and back onto their rollup fields", () => {
    expect(laneForAuxiliaryKind("embedding")).toBe("embedding");
    expect(laneForAuxiliaryKind("extraction")).toBe("extraction");
    expect(laneForAuxiliaryKind("eval-judge")).toBe("judge");
    expect(laneForAuxiliaryKind("compaction")).toBe("inference");
    expect(laneRollupField("embedding")).toBe("cost_cents:embedding");
    expect(laneRollupField("judge")).toBe("cost_cents:eval-judge");
    // The residual has no field of its own — that is what makes it a residual.
    expect(laneRollupField("inference")).toBeNull();
  });

  it("reports every lane at zero for an empty rollup", () => {
    const lanes = laneCostsFromRollup({});
    for (const lane of USAGE_LANES) expect(lanes[lane]).toBe(0);
  });
});

describe("aggregation", () => {
  it("takes the turn-level cost when present and sums steps otherwise", () => {
    const priced = { status: "SUCCEEDED", costCents: 7.5, steps: [
      { inputTokens: 10, outputTokens: 1, costCents: 3 },
      { inputTokens: 10, outputTokens: 1, costCents: 3 },
    ] };
    expect(usageFromTurn(priced).costCents).toBe(7.5);
    const unpriced = { status: "SUCCEEDED", steps: priced.steps };
    expect(usageFromTurn(unpriced).costCents).toBe(6);
  });

  it("reads a Prisma Decimal without losing the fraction", () => {
    // Step.costCents is Decimal(18,6); a naive `?? 0` on the object yields NaN.
    const decimalish = { toString: () => "0.6861", valueOf: () => "0.6861" };
    expect(usageFromStep({ inputTokens: 1, costCents: decimalish }).costCents)
      .toBeCloseTo(0.6861, 6);
  });

  it("rounds once at the end so sub-cent turns are not lost", () => {
    // A thousand 0.0004c turns round to zero individually and to 0.4c together.
    const tiny = { status: "SUCCEEDED", costCents: 0.0004, steps: [{ inputTokens: 10, outputTokens: 1 }] };
    expect(summariseTurns(Array(1000).fill(tiny)).costCents).toBeCloseTo(0.4, 4);
    expect(roundUsage({ ...EMPTY_USAGE, costCents: 0.00004 }).costCents).toBe(0);
  });

  it("adds an empty window to anything without changing it", () => {
    const usage = usageFromStep({ inputTokens: 5, outputTokens: 2, costCents: 1 });
    expect(addUsage(usage, { ...EMPTY_USAGE })).toEqual(usage);
  });

  it("keeps EMPTY_USAGE immutable across aggregations", () => {
    summariseTurns([{ status: "SUCCEEDED", costCents: 9, steps: [{ inputTokens: 1, outputTokens: 1 }] }]);
    expect(EMPTY_USAGE.costCents).toBe(0);
    expect(EMPTY_USAGE.tasks).toBe(0);
  });

  it("names every rollup field it reads", () => {
    // A literal typed by hand in a reader is how cost_with_cache_cents came to
    // be written by one writer and read by four of twelve consumers.
    const hash: RollupHash = {
      [ROLLUP_FIELD.costWithCacheCents]: "4.5",
      [ROLLUP_FIELD.inputTokens]: "900",
      [ROLLUP_FIELD.outputTokens]: "80",
      [ROLLUP_FIELD.cacheReadTokens]: "700",
      [ROLLUP_FIELD.cacheWriteTokens]: "100",
      [ROLLUP_FIELD.reasoningTokens]: "40",
      [ROLLUP_FIELD.tasks]: "3",
    };
    expect(usageFromRollup(hash)).toEqual({
      tasks: 3,
      costCents: 4.5,
      inputTokens: 900,
      freshInputTokens: 100,
      cacheReadTokens: 700,
      cacheWriteTokens: 100,
      outputTokens: 80,
      reasoningTokens: 40,
    });
  });
});
