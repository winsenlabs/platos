import { asIdentifier } from "@platos/kernel";
import { describe, expect, it } from "vitest";

import type { AgentVersionId, EvalCriterionId } from "./identifiers.js";
import { compareToBaseline, type RegressionSample } from "./regression.js";

const GROUNDED = asIdentifier<EvalCriterionId>("criterion-grounded");
const TONE = asIdentifier<EvalCriterionId>("criterion-tone");
const V6 = asIdentifier<AgentVersionId>("version-6");

const NAMES = new Map([
  ["criterion-grounded", "grounded"],
  ["criterion-tone", "tone"],
]);

function sample(criterionId: EvalCriterionId, score: number): RegressionSample {
  return { criterionId, score };
}

function compare(
  candidate: readonly RegressionSample[],
  baseline: readonly RegressionSample[],
  expected: readonly EvalCriterionId[] = [GROUNDED],
  thresholdPoints = 5,
) {
  return compareToBaseline({
    candidate,
    baseline,
    expectedCriterionIds: expected,
    criterionNames: NAMES,
    baselineVersionId: V6,
    thresholdPoints,
  });
}

describe("the verdict per criterion", () => {
  it("calls a drop at exactly the threshold a REGRESSION", () => {
    const report = compare([sample(GROUNDED, 45)], [sample(GROUNDED, 50)]);
    expect(report.perCriterion[0]?.verdict).toBe("regressed");
    expect(report.regressed).toBe(true);
  });

  it("calls a drop a hair inside the threshold NEUTRAL", () => {
    const report = compare([sample(GROUNDED, 45.001)], [sample(GROUNDED, 50)]);
    expect(report.perCriterion[0]?.verdict).toBe("neutral");
    expect(report.regressed).toBe(false);
  });

  it("takes the verdict on the UNROUNDED delta", () => {
    // -4.996 displays as -5.00 and is NOT a regression; the source compares the
    // rounded numbers and calls it one, so its verdict and its rendered number
    // agree while both are wrong.
    const report = compare([sample(GROUNDED, 45.004)], [sample(GROUNDED, 50)]);
    expect(report.perCriterion[0]?.delta).toBe(-5);
    expect(report.perCriterion[0]?.verdict).toBe("neutral");
  });

  it("calls a rise at exactly the threshold an IMPROVEMENT", () => {
    expect(compare([sample(GROUNDED, 55)], [sample(GROUNDED, 50)]).perCriterion[0]?.verdict).toBe("improved");
  });

  it("uses the threshold it is GIVEN", () => {
    expect(compare([sample(GROUNDED, 49)], [sample(GROUNDED, 50)], [GROUNDED], 1).perCriterion[0]?.verdict).toBe(
      "regressed",
    );
    expect(compare([sample(GROUNDED, 49)], [sample(GROUNDED, 50)], [GROUNDED], 20).perCriterion[0]?.verdict).toBe(
      "neutral",
    );
  });

  it("calls a criterion the baseline never scored NO-BASELINE, and not a regression", () => {
    const report = compare([sample(GROUNDED, 10)], []);
    expect(report.perCriterion[0]?.verdict).toBe("no-baseline");
    expect(report.perCriterion[0]?.delta).toBe(0);
    expect(report.regressed).toBe(false);
  });

  it("means both sides before comparing", () => {
    const report = compare(
      [sample(GROUNDED, 40), sample(GROUNDED, 60)],
      [sample(GROUNDED, 80), sample(GROUNDED, 80)],
    );
    expect(report.perCriterion[0]?.candidateMean).toBe(50);
    expect(report.perCriterion[0]?.baselineMean).toBe(80);
    expect(report.perCriterion[0]?.verdict).toBe("regressed");
  });

  it("reports the sample count on both sides", () => {
    const report = compare([sample(GROUNDED, 10), sample(GROUNDED, 20)], [sample(GROUNDED, 30)]);
    expect(report.perCriterion[0]?.candidateSamples).toBe(2);
    expect(report.perCriterion[0]?.baselineSamples).toBe(1);
  });
});

describe("a run that produced nothing cannot read as a clean pass", () => {
  it("reports an expected criterion with NO candidate sample as no-candidate", () => {
    const report = compare([], [sample(GROUNDED, 90)]);
    expect(report.perCriterion[0]?.verdict).toBe("no-candidate");
  });

  it("marks the whole report INCOMPLETE when any expected criterion is missing", () => {
    // The source builds its list from the candidate's rows alone, so a run in
    // which every judge call failed produces an empty list, `regressed: false`,
    // and a report indistinguishable from a clean pass — read as permission to
    // ship.
    const report = compare([], [sample(GROUNDED, 90)]);
    expect(report.complete).toBe(false);
    expect(report.regressed).toBe(false);
  });

  it("is COMPLETE when every expected criterion produced a candidate sample", () => {
    const report = compare([sample(GROUNDED, 90)], [sample(GROUNDED, 90)]);
    expect(report.complete).toBe(true);
  });

  it("is incomplete when only SOME of the expected criteria came back", () => {
    const report = compare([sample(GROUNDED, 90)], [], [GROUNDED, TONE]);
    expect(report.complete).toBe(false);
    expect(report.perCriterion.find((row) => row.criterionId === TONE)?.verdict).toBe("no-candidate");
  });

  it("still reports the criteria that DID come back on an incomplete run", () => {
    const report = compare([sample(GROUNDED, 90)], [sample(GROUNDED, 10)], [GROUNDED, TONE]);
    expect(report.perCriterion.find((row) => row.criterionId === GROUNDED)?.verdict).toBe("improved");
  });
});

describe("the report as a whole", () => {
  it("names every criterion from the expectation, the candidate and the baseline", () => {
    const report = compare([sample(TONE, 10)], [sample(GROUNDED, 10)], []);
    expect(report.perCriterion.map((row) => row.criterionId).sort()).toEqual([GROUNDED, TONE].sort());
  });

  it("labels criteria it can name and leaves the rest null", () => {
    const report = compare([sample(asIdentifier<EvalCriterionId>("gone"), 10)], [], []);
    expect(report.perCriterion[0]?.criterionName).toBeNull();
  });

  it("orders by criterion id, so two runs over one input agree", () => {
    const report = compare([sample(TONE, 10), sample(GROUNDED, 10)], [], []);
    expect(report.perCriterion.map((row) => row.criterionId)).toEqual([GROUNDED, TONE]);
  });

  it("carries the baseline version it compared against", () => {
    expect(compare([sample(GROUNDED, 10)], []).baselineVersionId).toBe(V6);
  });

  it("rounds the rendered means and delta to two places", () => {
    const report = compare(
      [sample(GROUNDED, 1), sample(GROUNDED, 1), sample(GROUNDED, 2)],
      [sample(GROUNDED, 0)],
    );
    expect(report.perCriterion[0]?.candidateMean).toBe(1.33);
    expect(report.perCriterion[0]?.delta).toBe(1.33);
  });

  it("is complete and empty when nothing was expected and nothing was scored", () => {
    const report = compare([], [], []);
    expect(report).toEqual({ regressed: false, complete: true, baselineVersionId: V6, perCriterion: [] });
  });
});
