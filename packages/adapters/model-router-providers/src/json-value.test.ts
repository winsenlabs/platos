import { describe, expect, it } from "vitest";

import {
  CIRCULAR_MARKER,
  EMPTY_TOOL_RESULT,
  UNSERIALISABLE_TOOL_RESULT,
  embeddableToolResult,
} from "./json-value.js";

describe("making a tool result embeddable", () => {
  it("turns the two shapes that fail a tool turn into a valid part", () => {
    expect(embeddableToolResult(undefined)).toEqual(EMPTY_TOOL_RESULT);
    expect(embeddableToolResult(null)).toEqual(EMPTY_TOOL_RESULT);
  });

  it("drops an undefined FIELD exactly as the serialiser does", () => {
    // An `undefined` sitting on a required field is the shape that surfaces as
    // "expected string, received undefined" and fails the whole turn.
    expect(embeddableToolResult({ kept: "a", dropped: undefined })).toEqual({ kept: "a" });
  });

  it("turns an array hole into null, exactly as the serialiser does", () => {
    expect(embeddableToolResult([1, undefined, 3])).toEqual([1, null, 3]);
  });

  it("converts the JavaScript values that are not JSON values", () => {
    const at = new Date("2026-01-02T03:04:05.000Z");

    expect(
      embeddableToolResult({
        big: 10n ** 20n,
        when: at,
        map: new Map([["k", 1]]),
        set: new Set([1, 2]),
        fn: () => 1,
        sym: Symbol("s"),
      }),
    ).toEqual({
      big: "100000000000000000000",
      when: "2026-01-02T03:04:05.000Z",
      map: { k: 1 },
      set: [1, 2],
    });
  });

  it("survives a circular reference instead of throwing", () => {
    const node: Record<string, unknown> = { name: "root" };
    node.self = node;

    expect(embeddableToolResult(node)).toEqual({ name: "root", self: CIRCULAR_MARKER });
  });

  it("serialises two siblings that share one object twice, as the serialiser does", () => {
    // Path-based and not visit-based. A visited-set would replace the second
    // sibling with the marker and silently lose real data.
    const shared = { id: 1 };

    expect(embeddableToolResult({ left: shared, right: shared })).toEqual({
      left: { id: 1 },
      right: { id: 1 },
    });
  });

  it("does not wrap a bare string or array, which would change the tool's contract", () => {
    expect(embeddableToolResult("just text")).toBe("just text");
    expect(embeddableToolResult([1, 2])).toEqual([1, 2]);
  });

  it("reads a non-finite number as null rather than emitting invalid JSON", () => {
    expect(embeddableToolResult({ a: Number.NaN, b: Number.POSITIVE_INFINITY })).toEqual({
      a: null,
      b: null,
    });
  });

  it("reads an invalid Date as null rather than throwing on toISOString", () => {
    expect(embeddableToolResult({ when: new Date("not a date") })).toEqual({ when: null });
  });

  it("still yields a valid part when a getter throws", () => {
    const hostile = {
      get boom(): unknown {
        throw new Error("no");
      },
    };

    expect(embeddableToolResult(hostile)).toEqual(UNSERIALISABLE_TOOL_RESULT);
  });

  it("round-trips through JSON, which is the whole guarantee", () => {
    const value = embeddableToolResult({ n: 1n, d: new Date(0), s: new Set([1]) });

    expect(JSON.parse(JSON.stringify(value))).toEqual(value);
  });
});
