import { describe, it, expect } from "vitest";
import { rrfFuse, RRF_K } from "./rrf";

describe("rrfFuse", () => {
  it("ranks a key that appears in two signals above single-signal keys", () => {
    const out = rrfFuse(
      new Map<string, string[]>([
        ["dense", ["a", "b", "c"]],
        ["graph", ["b", "d"]],
      ]),
    );
    expect(out[0].key).toBe("b");
    expect(out[0].signals.sort()).toEqual(["dense", "graph"]);
  });

  it("is deterministic regardless of signal insertion order", () => {
    const a = rrfFuse(new Map([["dense", ["x", "y"]], ["graph", ["y", "z"]]]));
    const b = rrfFuse(new Map([["graph", ["y", "z"]], ["dense", ["x", "y"]]]));
    expect(a).toEqual(b);
  });

  it("breaks equal-score ties by key ASC", () => {
    const tie = rrfFuse(new Map([["s1", ["b"]], ["s2", ["a"]]]));
    expect(tie.map((e) => e.key)).toEqual(["a", "b"]);
  });

  it("counts a duplicate key within one signal once (first position wins)", () => {
    const out = rrfFuse(new Map([["s", ["a", "a", "b"]]]));
    const a = out.find((e) => e.key === "a")!;
    expect(a.score).toBeCloseTo(1 / (RRF_K + 1));
    expect(a.signals).toEqual(["s"]);
  });

  it("empty input yields empty output", () => {
    expect(rrfFuse(new Map())).toEqual([]);
  });
});
