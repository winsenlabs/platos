import { describe, expect, it } from "vitest";

import { billableTokens, NO_TOKEN_USAGE, tokenUsage, totalTokens } from "./token-usage.js";

describe("admitting a usage report", () => {
  it("treats an absent count as zero", () => {
    const usage = tokenUsage({ inputTokens: 10 });
    if (!usage.ok) throw new Error("unreachable");
    expect(usage.value).toEqual({
      inputTokens: 10,
      outputTokens: 0,
      cacheReadInputTokens: 0,
      cacheWriteInputTokens: 0,
    });
  });

  it("refuses a negative or fractional count, naming the field", () => {
    for (const field of [
      "inputTokens",
      "outputTokens",
      "cacheReadInputTokens",
      "cacheWriteInputTokens",
    ] as const) {
      const denied = tokenUsage({ inputTokens: 100, [field]: -1 });
      expect(denied.ok).toBe(false);
      if (denied.ok) throw new Error("unreachable");
      expect(denied.error.code).toBe("PROVIDERS_TOKEN_USAGE_INVALID");
      expect(denied.error.message).toContain(field);
    }
    expect(tokenUsage({ inputTokens: 1.5 }).ok).toBe(false);
  });

  it("refuses a count beyond the safe integer range", () => {
    expect(tokenUsage({ inputTokens: Number.MAX_SAFE_INTEGER + 2 }).ok).toBe(false);
  });
});

describe("the cache counts are subsets of the input count", () => {
  it("REJECTS a report whose cache counts exceed its input count", () => {
    const denied = tokenUsage({
      inputTokens: 100,
      cacheReadInputTokens: 60,
      cacheWriteInputTokens: 60,
    });
    expect(denied.ok).toBe(false);
    if (denied.ok) throw new Error("unreachable");
    expect(denied.error.message).toContain("cannot exceed inputTokens");
  });

  it("does not clamp — a corrupt reading must not become a cheap turn", () => {
    const denied = tokenUsage({ inputTokens: 0, cacheReadInputTokens: 1 });
    expect(denied.ok).toBe(false);
  });

  it("admits a report whose cache counts exactly consume the input count", () => {
    const usage = tokenUsage({
      inputTokens: 100,
      cacheReadInputTokens: 40,
      cacheWriteInputTokens: 60,
    });
    if (!usage.ok) throw new Error("unreachable");
    expect(billableTokens(usage.value).freshInputTokens).toBe(0);
  });
});

describe("the billable split", () => {
  it("removes both cache counts from the input count", () => {
    const usage = tokenUsage({
      inputTokens: 1_000,
      outputTokens: 50,
      cacheReadInputTokens: 400,
      cacheWriteInputTokens: 100,
    });
    if (!usage.ok) throw new Error("unreachable");
    expect(billableTokens(usage.value)).toEqual({
      freshInputTokens: 500,
      outputTokens: 50,
      cacheReadInputTokens: 400,
      cacheWriteInputTokens: 100,
    });
  });

  it("counts a turn's size as input plus output, cache subsets included once", () => {
    const usage = tokenUsage({ inputTokens: 1_000, outputTokens: 50, cacheReadInputTokens: 400 });
    if (!usage.ok) throw new Error("unreachable");
    expect(totalTokens(usage.value)).toBe(1_050);
  });

  it("has an empty report that is all zeroes", () => {
    expect(billableTokens(NO_TOKEN_USAGE)).toEqual({
      freshInputTokens: 0,
      outputTokens: 0,
      cacheReadInputTokens: 0,
      cacheWriteInputTokens: 0,
    });
  });
});
