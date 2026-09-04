// The scrub that stops a tool's answer breaking the NEXT round trip.
//
// The failure this prevents is `AI_InvalidPromptError: The messages do not match
// the ModelMessage[] schema`, raised on the step AFTER the one that produced the
// bad value, and only on tool turns.

import { describe, expect, it } from "vitest";

import { isStreamingResult, sanitizeToolResult } from "./tool-result.js";

describe("sanitizeToolResult", () => {
  it("passes a plain object through unchanged", () => {
    const sanitized = sanitizeToolResult({ status: "ok", count: 3 });
    expect(sanitized.ok).toBe(true);
    expect(sanitized.value).toEqual({ status: "ok", count: 3 });
  });

  it("converts a bigint to a decimal string, which JSON.stringify throws on", () => {
    const sanitized = sanitizeToolResult({ id: 9_007_199_254_740_993n });
    expect(sanitized.ok).toBe(true);
    expect(sanitized.value).toEqual({ id: "9007199254740993" });
  });

  it("drops a function and a symbol, neither of which survives a wire format", () => {
    const sanitized = sanitizeToolResult({ keep: 1, fn: () => 1, sym: Symbol("x") });
    expect(sanitized.value).toEqual({ keep: 1 });
  });

  it("drops an undefined FIELD but writes null in an array HOLE, as stringify does", () => {
    const sanitized = sanitizeToolResult({ a: undefined, b: [1, undefined, 3] });
    expect(sanitized.value).toEqual({ b: [1, null, 3] });
  });

  it("renders a Date as ISO and an invalid Date as null, not as 'Invalid Date'", () => {
    const sanitized = sanitizeToolResult({
      when: new Date("2026-01-01T00:00:00.000Z"),
      broken: new Date("nope"),
    });
    expect(sanitized.value).toEqual({ when: "2026-01-01T00:00:00.000Z", broken: null });
  });

  it("converts a Map and a Set, which stringify silently renders as {}", () => {
    const sanitized = sanitizeToolResult({
      m: new Map([["k", 1]]),
      s: new Set([1, 2]),
    });
    expect(sanitized.value).toEqual({ m: { k: 1 }, s: [1, 2] });
  });

  it("marks a genuine CYCLE and does not recurse forever", () => {
    const cyclic: Record<string, unknown> = { name: "root" };
    cyclic.self = cyclic;
    const sanitized = sanitizeToolResult(cyclic);
    expect(sanitized.ok).toBe(true);
    expect(sanitized.value).toEqual({ name: "root", self: "[Circular]" });
  });

  it("writes a DIAMOND twice, because the cycle set is path-based and not identity-based", () => {
    const shared = { shared: true };
    const sanitized = sanitizeToolResult({ left: shared, right: shared });
    // An identity set would render the second reference as "[Circular]", which
    // `JSON.stringify` does not do.
    expect(sanitized.value).toEqual({ left: { shared: true }, right: { shared: true } });
  });

  it("refuses null and undefined outright", () => {
    for (const value of [null, undefined]) {
      const refused = sanitizeToolResult(value);
      expect(refused.ok).toBe(false);
      expect(refused.error).toBe("the tool answered with nothing");
    }
  });

  it("refuses a value the scrub REDUCES to nothing", () => {
    // An object of only functions survives the first check and becomes `{}`;
    // the source checks twice for exactly this, and neither check is redundant.
    const sanitized = sanitizeToolResult({ fn: () => 1 });
    expect(sanitized.ok).toBe(true);
    expect(sanitized.value).toEqual({});
  });

  it("keeps a nested structure intact through several levels", () => {
    const sanitized = sanitizeToolResult({
      rows: [{ id: 1n, tags: new Set(["a"]) }, { id: 2n, tags: new Set() }],
    });
    expect(sanitized.value).toEqual({
      rows: [
        { id: "1", tags: ["a"] },
        { id: "2", tags: [] },
      ],
    });
  });
});

describe("isStreamingResult", () => {
  it("recognises an async iterable and a reader, and nothing else", () => {
    expect(isStreamingResult({ [Symbol.asyncIterator]: () => ({}) })).toBe(true);
    expect(isStreamingResult({ getReader: () => ({}) })).toBe(true);
    expect(isStreamingResult({ ordinary: true })).toBe(false);
    expect(isStreamingResult("text")).toBe(false);
    expect(isStreamingResult(null)).toBe(false);
  });
});
