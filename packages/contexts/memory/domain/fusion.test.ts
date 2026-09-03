import { describe, expect, it } from "vitest";

import { rrfContribution, rrfFuse, RRF_K } from "./fusion.js";

function fuse(rankings: Record<string, readonly string[]>) {
  return rrfFuse(new Map(Object.entries(rankings)));
}

describe("the RRF constant", () => {
  it("is the canonical 60", () => {
    expect(RRF_K).toBe(60);
  });

  it("damps the head — rank 1 is worth only about 6% more than rank 5", () => {
    const first = rrfContribution(0);
    const fifth = rrfContribution(4);
    expect(first / fifth).toBeCloseTo(65 / 61, 6);
  });

  it("contributes 1 / (K + rank + 1) at every rank", () => {
    expect(rrfContribution(0)).toBeCloseTo(1 / 61, 12);
    expect(rrfContribution(9)).toBeCloseTo(1 / 70, 12);
  });
});

describe("rrfFuse", () => {
  it("a single signal preserves its own order", () => {
    expect(fuse({ dense: ["a", "b", "c"] }).map((entry) => entry.key)).toEqual(["a", "b", "c"]);
  });

  it("a candidate in TWO signals outranks one that is first in only one", () => {
    const fused = fuse({ dense: ["a", "b"], graph: ["b"] });
    expect(fused.map((entry) => entry.key)).toEqual(["b", "a"]);
  });

  it("records which signals surfaced each key, in sorted signal order", () => {
    const fused = fuse({ graph: ["b"], dense: ["a", "b"] });
    expect(fused.find((entry) => entry.key === "b")?.signals).toEqual(["dense", "graph"]);
    expect(fused.find((entry) => entry.key === "a")?.signals).toEqual(["dense"]);
  });

  it("is INDEPENDENT of the order the signals were inserted in", () => {
    const forwards = fuse({ dense: ["a", "b", "c"], graph: ["c", "a"] });
    const backwards = fuse({ graph: ["c", "a"], dense: ["a", "b", "c"] });
    expect(backwards).toEqual(forwards);
  });

  it("counts a duplicate WITHIN one signal ONCE, at its first position", () => {
    const honest = fuse({ dense: ["a", "b"] });
    const repeated = fuse({ dense: ["a", "a", "a", "b"] });
    expect(repeated.find((entry) => entry.key === "a")?.score).toBeCloseTo(
      honest.find((entry) => entry.key === "a")?.score ?? 0,
      12,
    );
  });

  it("does not let a repeating signal outrank a correct one", () => {
    const fused = fuse({ dense: ["b", "b", "b", "b"], graph: ["a"] });
    // `a` is first in `graph`; `b` is first in `dense` and cannot vote again.
    expect(fused[0]?.score).toBeCloseTo(fused[1]?.score ?? 0, 12);
  });

  it("breaks ties by key ASCENDING", () => {
    const fused = fuse({ dense: ["z"], graph: ["a"] });
    expect(fused.map((entry) => entry.key)).toEqual(["a", "z"]);
  });

  it("an empty ranking map fuses to nothing", () => {
    expect(fuse({})).toEqual([]);
  });

  it("an empty list inside a signal contributes nothing", () => {
    expect(fuse({ dense: [], graph: ["a"] }).map((entry) => entry.key)).toEqual(["a"]);
  });

  it("sums the exact contributions, so a score is checkable by hand", () => {
    const fused = fuse({ dense: ["a"], graph: ["a"] });
    expect(fused[0]?.score).toBeCloseTo(2 / 61, 12);
  });

  it("is deterministic across repeated runs", () => {
    const rankings = { dense: ["a", "b", "c", "d"], graph: ["d", "b"] };
    expect(fuse(rankings)).toEqual(fuse(rankings));
  });
});
