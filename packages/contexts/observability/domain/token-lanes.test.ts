import { describe, expect, it } from "vitest";

import { laneCosts, lanesPartitionInput, resolveLanes } from "./token-lanes.js";

describe("resolveLanes — the lanes are a PARTITION of reported input", () => {
  it("derives fresh input as total minus the two cache lanes", () => {
    const lanes = resolveLanes({
      inputTokens: 1_000,
      cacheReadInputTokens: 400,
      cacheWriteInputTokens: 100,
      outputTokens: 250,
    });
    expect(lanes.totalInput).toBe(1_000);
    expect(lanes.freshInput).toBe(500);
    expect(lanes.cacheRead).toBe(400);
    expect(lanes.cacheWrite).toBe(100);
    expect(lanes.output).toBe(250);
  });

  it("never adds the cache lanes back into the total", () => {
    const lanes = resolveLanes({ inputTokens: 1_000, cacheReadInputTokens: 400 });
    expect(lanes.totalInput).toBe(1_000);
    expect(lanes.freshInput + lanes.cacheRead).toBe(1_000);
  });

  it("clamps a cache read larger than the input it was part of", () => {
    const lanes = resolveLanes({ inputTokens: 100, cacheReadInputTokens: 400 });
    expect(lanes.cacheRead).toBe(100);
    expect(lanes.freshInput).toBe(0);
    expect(lanesPartitionInput(lanes)).toBe(true);
  });

  it("clamps a cache write against what the cache read left, not against the total", () => {
    const lanes = resolveLanes({
      inputTokens: 100,
      cacheReadInputTokens: 80,
      cacheWriteInputTokens: 80,
    });
    expect(lanes.cacheRead).toBe(80);
    expect(lanes.cacheWrite).toBe(20);
    expect(lanes.freshInput).toBe(0);
    expect(lanesPartitionInput(lanes)).toBe(true);
  });

  it("never lets fresh input go negative, which would understate the bill", () => {
    const lanes = resolveLanes({
      inputTokens: 10,
      cacheReadInputTokens: 1_000,
      cacheWriteInputTokens: 1_000,
    });
    expect(lanes.freshInput).toBe(0);
    expect(lanes.freshInput).toBeGreaterThanOrEqual(0);
  });

  it("partitions the input under every combination of reported counters", () => {
    const counters = [0, 1, 7, 100, 1_000];
    for (const inputTokens of counters) {
      for (const cacheReadInputTokens of counters) {
        for (const cacheWriteInputTokens of counters) {
          const lanes = resolveLanes({ inputTokens, cacheReadInputTokens, cacheWriteInputTokens });
          expect(lanesPartitionInput(lanes)).toBe(true);
        }
      }
    }
  });

  it("treats every absent lane as zero rather than as unknown", () => {
    const lanes = resolveLanes(undefined);
    expect(lanes).toEqual({
      totalInput: 0,
      freshInput: 0,
      cacheRead: 0,
      cacheWrite: 0,
      output: 0,
      reasoning: 0,
    });
  });
});

describe("laneCosts — extended at the FROZEN rates", () => {
  const lanes = resolveLanes({
    inputTokens: 1_000,
    cacheReadInputTokens: 400,
    cacheWriteInputTokens: 100,
    outputTokens: 200,
  });

  it("extends each lane at its own rate", () => {
    const costs = laneCosts(lanes, {
      inputUsdPerToken: 0.000_01,
      cacheReadUsdPerToken: 0.000_001,
      cacheWriteUsdPerToken: 0.000_012_5,
      outputUsdPerToken: 0.000_03,
    });
    expect(costs.freshInput).toBe("0.005000000000");
    expect(costs.cacheRead).toBe("0.000400000000");
    expect(costs.cacheWrite).toBe("0.001250000000");
    expect(costs.output).toBe("0.006000000000");
  });

  it("prices a missing rate at zero rather than skipping the lane", () => {
    const costs = laneCosts(lanes, { inputUsdPerToken: 0.000_01 });
    expect(costs.freshInput).toBe("0.005000000000");
    expect(costs.cacheRead).toBe("0.000000000000");
    expect(costs.output).toBe("0.000000000000");
  });

  it("prices every lane at zero when no rates were recorded at all", () => {
    const costs = laneCosts(lanes, undefined);
    expect(Object.values(costs).every((value) => value === "0.000000000000")).toBe(true);
  });

  it("consults no catalogue: the same lanes at two rate cards give two costs", () => {
    const cheap = laneCosts(lanes, { inputUsdPerToken: 0.000_001 });
    const dear = laneCosts(lanes, { inputUsdPerToken: 0.000_01 });
    expect(cheap.freshInput).not.toBe(dear.freshInput);
  });
});
