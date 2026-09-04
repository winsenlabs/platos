import { asIdentifier } from "@platos/kernel";
import { describe, expect, it } from "vitest";

import { aggregateEvals, meanOf, roundToTwo, type EvalAggregateInput } from "./eval-aggregate.js";
import type { AgentVersionId, EvalCriterionId } from "./identifiers.js";

const GROUNDED = asIdentifier<EvalCriterionId>("criterion-grounded");
const TONE = asIdentifier<EvalCriterionId>("criterion-tone");
const V6 = asIdentifier<AgentVersionId>("version-6");
const V7 = asIdentifier<AgentVersionId>("version-7");

function score(
  criterionId: EvalCriterionId,
  agentVersionId: AgentVersionId | null,
  value: number,
  passed = true,
): EvalAggregateInput {
  return { criterionId, agentVersionId, score: value, passed };
}

const NAMES = {
  criterionNames: new Map([
    ["criterion-grounded", "grounded"],
    ["criterion-tone", "tone"],
  ]),
  versionNumbers: new Map([
    ["version-6", 6],
    ["version-7", 7],
  ]),
};

describe("meanOf and roundToTwo", () => {
  it("means a list", () => {
    expect(meanOf([1, 2, 3])).toBe(2);
  });

  it("answers zero for an empty list rather than NaN", () => {
    expect(meanOf([])).toBe(0);
  });

  it("rounds to two places", () => {
    expect(roundToTwo(66.666_666)).toBe(66.67);
    expect(roundToTwo(0.005)).toBe(0.01);
  });
});

describe("aggregateEvals", () => {
  it("groups per (criterion, version) and means the scores", () => {
    const rows = aggregateEvals(
      [score(GROUNDED, V7, 80), score(GROUNDED, V7, 60), score(GROUNDED, V6, 40)],
      NAMES,
    );
    const seven = rows.find((row) => row.agentVersionId === V7);
    expect(seven?.sampleCount).toBe(2);
    expect(seven?.meanScore).toBe(70);
    expect(seven?.criterionName).toBe("grounded");
    expect(seven?.versionNumber).toBe(7);
  });

  it("publishes the UNROUNDED mean beside the rounded one", () => {
    const rows = aggregateEvals([score(GROUNDED, V7, 1), score(GROUNDED, V7, 2)], NAMES);
    expect(rows[0]?.meanScore).toBe(1.5);
    expect(rows[0]?.meanScoreExact).toBe(1.5);
    const thirds = aggregateEvals([score(GROUNDED, V7, 1), score(GROUNDED, V7, 1), score(GROUNDED, V7, 2)], NAMES);
    expect(thirds[0]?.meanScore).toBe(1.33);
    expect(thirds[0]?.meanScoreExact).toBeCloseTo(4 / 3, 12);
  });

  it("computes the pass rate over the bucket", () => {
    const rows = aggregateEvals(
      [score(GROUNDED, V7, 80, true), score(GROUNDED, V7, 10, false), score(GROUNDED, V7, 90, true)],
      NAMES,
    );
    expect(rows[0]?.passRate).toBeCloseTo(2 / 3, 12);
  });

  it("keeps a DELETED criterion's scores, with a null name", () => {
    // Dropping the bucket would improve the average every time an operator
    // tidied up.
    const rows = aggregateEvals([score(asIdentifier<EvalCriterionId>("gone"), V7, 10)], NAMES);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.criterionName).toBeNull();
    expect(rows[0]?.sampleCount).toBe(1);
  });

  it("never invents a display label for a deleted criterion", () => {
    const rows = aggregateEvals([score(asIdentifier<EvalCriterionId>("gone"), V7, 10)], NAMES);
    expect(rows[0]?.criterionName).not.toBe("(deleted criterion)");
  });

  it("keeps a version with no label, and one with no version at all, apart", () => {
    const rows = aggregateEvals(
      [score(GROUNDED, asIdentifier<AgentVersionId>("pruned"), 10), score(GROUNDED, null, 20)],
      NAMES,
    );
    expect(rows).toHaveLength(2);
    expect(rows.map((row) => row.versionNumber)).toEqual([null, null]);
    expect(new Set(rows.map((row) => row.agentVersionId))).toEqual(new Set(["pruned", null]));
  });

  it('keeps a version id spelled "null" separate from an absent version', () => {
    // The source keys buckets with `` `${criterionId}::${versionId ?? "null"}` ``
    // and splits the string back, which merges these two.
    const literal = asIdentifier<AgentVersionId>("null");
    const rows = aggregateEvals([score(GROUNDED, literal, 10), score(GROUNDED, null, 90)], NAMES);
    expect(rows).toHaveLength(2);
    const byId = new Map(rows.map((row) => [row.agentVersionId, row.meanScore]));
    expect(byId.get(literal)).toBe(10);
    expect(byId.get(null)).toBe(90);
  });

  it("keeps an identifier containing the source's separator intact", () => {
    const odd = asIdentifier<EvalCriterionId>("a::b");
    const rows = aggregateEvals([score(odd, V7, 50)], NAMES);
    expect(rows[0]?.criterionId).toBe("a::b");
  });

  it("orders named criteria alphabetically, then newest version first", () => {
    const rows = aggregateEvals(
      [score(TONE, V6, 10), score(GROUNDED, V6, 10), score(GROUNDED, V7, 10)],
      NAMES,
    );
    expect(rows.map((row) => [row.criterionName, row.versionNumber])).toEqual([
      ["grounded", 7],
      ["grounded", 6],
      ["tone", 6],
    ]);
  });

  it("puts unnamed criteria after named ones rather than sorting on a fallback", () => {
    const rows = aggregateEvals(
      [score(asIdentifier<EvalCriterionId>("aaa-unknown"), V7, 10), score(TONE, V7, 10)],
      NAMES,
    );
    expect(rows.map((row) => row.criterionName)).toEqual(["tone", null]);
  });

  it("answers nothing for no rows", () => {
    expect(aggregateEvals([], NAMES)).toEqual([]);
  });
});
