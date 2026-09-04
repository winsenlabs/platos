// The shipped policy, pinned as literals.
//
// Every number here was transcribed from a running service. A test that
// re-derived them from the constant it is checking would stay green through any
// edit, so each is written out — an accidental change to a ceiling, a window or
// the judge's default model turns this file red and has to be argued for.
//
// The two numbers the source disagrees with itself about are pinned as a PAIR,
// so the disagreement is a fact in the suite rather than folklore in a comment.

import { describe, expect, it } from "vitest";

import { COLUMN_SCORE_SCALE_MAX, DEFAULT_GOVERNANCE_POLICY } from "./policy.js";

describe("the safety ledger's limits", () => {
  it("pins the detail ceiling, the page window and the day window", () => {
    expect(DEFAULT_GOVERNANCE_POLICY.safety).toEqual({
      maxDetailLength: 4000,
      maxPageSize: 200,
      defaultPageSize: 50,
      minWindowDays: 1,
      defaultWindowDays: 30,
      maxWindowDays: 365,
    });
  });
});

describe("the rating limits", () => {
  it("pins the comment ceiling and the satisfaction window", () => {
    expect(DEFAULT_GOVERNANCE_POLICY.ratings).toEqual({
      maxCommentLength: 2000,
      minWindowDays: 1,
      defaultWindowDays: 30,
      maxWindowDays: 365,
    });
  });
});

describe("the criterion limits", () => {
  it("pins the text ceilings, the page window and the SERVICE score scale", () => {
    expect(DEFAULT_GOVERNANCE_POLICY.criteria).toEqual({
      maxNameLength: 200,
      maxPromptLength: 20000,
      maxRubricLength: 20000,
      maxPageSize: 200,
      defaultPageSize: 50,
      defaultScoreScaleMin: 0,
      defaultScoreScaleMax: 100,
    });
  });

  it("records that the COLUMN's default disagrees with the service's", () => {
    // A criterion created through the API scores 0..100; one written around the
    // service scores 0..1, and every score against it normalises against a range
    // of one. Both numbers are named so the disagreement is provable.
    expect(COLUMN_SCORE_SCALE_MAX).toBe(1);
    expect(DEFAULT_GOVERNANCE_POLICY.criteria.defaultScoreScaleMax).toBe(100);
    expect(COLUMN_SCORE_SCALE_MAX).not.toBe(DEFAULT_GOVERNANCE_POLICY.criteria.defaultScoreScaleMax);
  });
});

describe("the eval limits", () => {
  it("ships with judging ENABLED", () => {
    expect(DEFAULT_GOVERNANCE_POLICY.evals.enabled).toBe(true);
  });

  it("pins the default judge model exactly", () => {
    expect(DEFAULT_GOVERNANCE_POLICY.evals.defaultJudgeModel).toBe(
      "anthropic:claude-haiku-4-5-20251001",
    );
  });

  it("pins the pass mark as a PERCENTAGE, which is what the parser compares", () => {
    expect(DEFAULT_GOVERNANCE_POLICY.evals.passMarkPercent).toBe(50);
  });

  it("pins the raw-response ceiling, the page window and the day window", () => {
    expect(DEFAULT_GOVERNANCE_POLICY.evals.maxRawResponseLength).toBe(20000);
    expect(DEFAULT_GOVERNANCE_POLICY.evals.maxPageSize).toBe(200);
    expect(DEFAULT_GOVERNANCE_POLICY.evals.defaultPageSize).toBe(50);
    expect(DEFAULT_GOVERNANCE_POLICY.evals.minWindowDays).toBe(1);
    expect(DEFAULT_GOVERNANCE_POLICY.evals.defaultWindowDays).toBe(30);
    expect(DEFAULT_GOVERNANCE_POLICY.evals.maxWindowDays).toBe(365);
  });
});

describe("the golden-set ceilings", () => {
  it("pins all three, and the pair ceiling is BELOW the product of the other two", () => {
    expect(DEFAULT_GOVERNANCE_POLICY.goldenSets).toEqual({
      maxNameLength: 200,
      maxThreads: 100,
      maxCriteria: 20,
      maxPairs: 500,
    });
    // If the pair ceiling were at or above 100 * 20 it could never bind, and the
    // third guard would be unreachable rather than merely unexercised.
    const product =
      DEFAULT_GOVERNANCE_POLICY.goldenSets.maxThreads * DEFAULT_GOVERNANCE_POLICY.goldenSets.maxCriteria;
    expect(DEFAULT_GOVERNANCE_POLICY.goldenSets.maxPairs).toBeLessThan(product);
  });
});

describe("the regression thresholds", () => {
  it("pins the drop that counts and the baseline window", () => {
    expect(DEFAULT_GOVERNANCE_POLICY.regression).toEqual({
      thresholdPoints: 5,
      baselineWindowDays: 30,
    });
  });
});

describe("the risk weights and bands", () => {
  it("pins the four weights, which sum to one", () => {
    const risk = DEFAULT_GOVERNANCE_POLICY.risk;
    expect(risk.piiWeight).toBe(0.4);
    expect(risk.injectionWeight).toBe(0.3);
    expect(risk.toolErrorWeight).toBe(0.2);
    expect(risk.approvalWeight).toBe(0.1);
    const total = risk.piiWeight + risk.injectionWeight + risk.toolErrorWeight + risk.approvalWeight;
    expect(Math.round(total * 100) / 100).toBe(1);
  });

  it("pins the bands and the SHORTER window the risk board uses", () => {
    // Seven days and ninety, not the thirty and three-sixty-five every other
    // read uses — the source's governance dashboard is deliberately narrower.
    expect(DEFAULT_GOVERNANCE_POLICY.risk.highBand).toBe(50);
    expect(DEFAULT_GOVERNANCE_POLICY.risk.mediumBand).toBe(20);
    expect(DEFAULT_GOVERNANCE_POLICY.risk.minWindowDays).toBe(1);
    expect(DEFAULT_GOVERNANCE_POLICY.risk.defaultWindowDays).toBe(7);
    expect(DEFAULT_GOVERNANCE_POLICY.risk.maxWindowDays).toBe(90);
  });
});

describe("the policy is data, not a mutable module", () => {
  it("is frozen at every level a use case reads", () => {
    expect(Object.isFrozen(DEFAULT_GOVERNANCE_POLICY)).toBe(true);
    expect(Object.isFrozen(DEFAULT_GOVERNANCE_POLICY.safety)).toBe(true);
    expect(Object.isFrozen(DEFAULT_GOVERNANCE_POLICY.ratings)).toBe(true);
    expect(Object.isFrozen(DEFAULT_GOVERNANCE_POLICY.criteria)).toBe(true);
    expect(Object.isFrozen(DEFAULT_GOVERNANCE_POLICY.evals)).toBe(true);
    expect(Object.isFrozen(DEFAULT_GOVERNANCE_POLICY.goldenSets)).toBe(true);
    expect(Object.isFrozen(DEFAULT_GOVERNANCE_POLICY.regression)).toBe(true);
    expect(Object.isFrozen(DEFAULT_GOVERNANCE_POLICY.risk)).toBe(true);
  });

  it("keeps every default page size inside its own ceiling", () => {
    expect(DEFAULT_GOVERNANCE_POLICY.safety.defaultPageSize).toBeLessThanOrEqual(
      DEFAULT_GOVERNANCE_POLICY.safety.maxPageSize,
    );
    expect(DEFAULT_GOVERNANCE_POLICY.criteria.defaultPageSize).toBeLessThanOrEqual(
      DEFAULT_GOVERNANCE_POLICY.criteria.maxPageSize,
    );
    expect(DEFAULT_GOVERNANCE_POLICY.evals.defaultPageSize).toBeLessThanOrEqual(
      DEFAULT_GOVERNANCE_POLICY.evals.maxPageSize,
    );
  });

  it("keeps every default window between its own floor and ceiling", () => {
    const windows = [
      DEFAULT_GOVERNANCE_POLICY.safety,
      DEFAULT_GOVERNANCE_POLICY.ratings,
      DEFAULT_GOVERNANCE_POLICY.evals,
      DEFAULT_GOVERNANCE_POLICY.risk,
    ];
    for (const bounds of windows) {
      expect(bounds.minWindowDays).toBeLessThanOrEqual(bounds.defaultWindowDays);
      expect(bounds.defaultWindowDays).toBeLessThanOrEqual(bounds.maxWindowDays);
    }
  });
});
