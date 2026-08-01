import { describe, it, expect } from "vitest";
import { billableCostCents, isCompletedTask, summarise } from "./billable-usage";

/**
 * ONE SOURCE OF TRUTH. Two cost fields existed and consumers read the wrong one:
 * measured 2026-07-31, cost_with_cache 25.70c vs cost_cents 2.47c — a 10x
 * understatement that budgets were being enforced against.
 */
describe("billableCostCents", () => {
  it("prefers the cache-adjusted figure", () => {
    expect(billableCostCents({ cost_cents: 2.47, cost_with_cache_cents: 25.70 })).toBe(25.70);
  });

  it("does NOT fall back when the cache-adjusted figure is genuinely zero", () => {
    // A real turn recorded cost_cents 0 / cost_with_cache 0.6861. Falling back
    // on falsy would resurrect the wrong number.
    expect(billableCostCents({ cost_cents: 5, cost_with_cache_cents: 0 })).toBe(0);
  });

  it("falls back only for legacy rows with no cache figure at all", () => {
    expect(billableCostCents({ cost_cents: 3.5 })).toBe(3.5);
    expect(billableCostCents({})).toBe(0);
    expect(billableCostCents(null)).toBe(0);
  });
});

describe("a task is a job done, not a tool call", () => {
  const turn = { usage: { inputTokens: 100, outputTokens: 10 }, cost_with_cache_cents: 1 };

  it("counts one completed turn as one task", () => {
    expect(isCompletedTask(turn)).toBe(true);
    expect(summarise([turn]).tasks).toBe(1);
  });

  it("does not count a turn that never reached the model", () => {
    // Otherwise a failing agent inflates the number it is judged by.
    expect(isCompletedTask({ usage: { inputTokens: 0, outputTokens: 0 } })).toBe(false);
    expect(isCompletedTask({ cost_cents: 0 })).toBe(false);
  });

  it("one turn is one task however many tools it called", () => {
    // The 322 figure counted searches and executions. Seven calls to answer one
    // question is ONE job done; the rest is the agent's own deliberation.
    expect(summarise([turn, turn, turn]).tasks).toBe(3);
  });
});

describe("summarise — every surface reads the same numbers", () => {
  it("aggregates cost from the cache-adjusted field", () => {
    const rows = [
      { cost_cents: 2.47, cost_with_cache_cents: 25.70, usage: { inputTokens: 9000, outputTokens: 50, cacheReadInputTokens: 8000 } },
      { cost_cents: 0, cost_with_cache_cents: 0.6861, usage: { inputTokens: 2729, outputTokens: 4, cacheReadInputTokens: 0 } },
    ];
    const s = summarise(rows);
    expect(s.tasks).toBe(2);
    expect(s.costCents).toBeCloseTo(26.3861, 4);
    expect(s.cacheReadTokens).toBe(8000);
  });

  it("does not double-count the cache slice into input tokens", () => {
    // inputTokens is already INCLUSIVE of cache reads/writes.
    expect(summarise([{ usage: { inputTokens: 1000, cacheReadInputTokens: 900 } }]).inputTokens).toBe(1000);
  });

  it("rounds once at the end so sub-cent turns are not lost", () => {
    const tiny = { cost_with_cache_cents: 0.0004, usage: { inputTokens: 10, outputTokens: 1 } };
    expect(summarise(Array(10).fill(tiny)).costCents).toBeCloseTo(0.004, 4);
  });
});
