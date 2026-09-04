import { describe, expect, it } from "vitest";

import type { CriterionSnapshot } from "./criterion.js";
import { UNREADABLE_RATIONALE_LENGTH, normalise, readJudgeVerdict } from "./judge-verdict.js";

const PASS_MARK = 50;

function criterion(overrides: Partial<CriterionSnapshot> = {}): CriterionSnapshot {
  return {
    name: "grounded",
    description: null,
    judgePrompt: "score it",
    rubric: null,
    judgeModel: null,
    scoreScaleMin: 0,
    scoreScaleMax: 100,
    ...overrides,
  };
}

describe("normalise", () => {
  it("maps a 0..10 scale onto 0..100", () => {
    expect(normalise(5, criterion({ scoreScaleMin: 0, scoreScaleMax: 10 })).score).toBe(50);
    expect(normalise(10, criterion({ scoreScaleMin: 0, scoreScaleMax: 10 })).score).toBe(100);
  });

  it("maps an offset scale from its own floor", () => {
    expect(normalise(3, criterion({ scoreScaleMin: 1, scoreScaleMax: 5 })).score).toBe(50);
    expect(normalise(1, criterion({ scoreScaleMin: 1, scoreScaleMax: 5 })).score).toBe(0);
  });

  it("clamps a score above the scale and SAYS it clamped", () => {
    const normalised = normalise(500, criterion());
    expect(normalised.score).toBe(100);
    expect(normalised.clamped).toBe(true);
  });

  it("clamps a score below the scale too", () => {
    const normalised = normalise(-20, criterion());
    expect(normalised.score).toBe(0);
    expect(normalised.clamped).toBe(true);
  });

  it("does not call an in-range score clamped", () => {
    expect(normalise(50, criterion()).clamped).toBe(false);
  });

  it("answers 0 for a non-positive range — the defence for rows written before admission", () => {
    expect(normalise(50, criterion({ scoreScaleMin: 5, scoreScaleMax: 5 })).score).toBe(0);
    expect(normalise(50, criterion({ scoreScaleMin: 100, scoreScaleMax: 0 })).score).toBe(0);
  });
});

describe("readJudgeVerdict — where the answer was found", () => {
  it("reads a fenced JSON block", () => {
    const verdict = readJudgeVerdict('```json\n{"score": 80, "passed": true}\n```', criterion(), PASS_MARK);
    expect(verdict.parsedFrom).toBe("fenced-json");
    expect(verdict.score).toBe(80);
  });

  it("digs a JSON object out of surrounding prose", () => {
    const verdict = readJudgeVerdict('Here is my answer: {"score": 40} — hope that helps.', criterion(), PASS_MARK);
    expect(verdict.parsedFrom).toBe("embedded-json");
    expect(verdict.score).toBe(40);
  });

  it("reads a bare object body", () => {
    const verdict = readJudgeVerdict('{"score": 40}', criterion(), PASS_MARK);
    // A bare object is also the first `{...}` in the body, so it is found by the
    // embedded reader; what matters is that it is NOT unreadable.
    expect(verdict.parsedFrom).not.toBe("unreadable");
    expect(verdict.score).toBe(40);
  });

  it("reports UNREADABLE for prose with no object at all", () => {
    const verdict = readJudgeVerdict("I would rather not say.", criterion(), PASS_MARK);
    expect(verdict.parsedFrom).toBe("unreadable");
    expect(verdict.score).toBe(0);
    expect(verdict.passed).toBe(false);
    expect(verdict.rationale).toBe("I would rather not say.");
  });

  it("keeps a bounded prefix of a very long unreadable body as the rationale", () => {
    const verdict = readJudgeVerdict("x".repeat(UNREADABLE_RATIONALE_LENGTH + 500), criterion(), PASS_MARK);
    expect(verdict.rationale).toHaveLength(UNREADABLE_RATIONALE_LENGTH);
  });

  it("reports UNREADABLE for a JSON ARRAY, which is not a verdict", () => {
    expect(readJudgeVerdict("[1,2,3]", criterion(), PASS_MARK).parsedFrom).toBe("unreadable");
  });
});

describe("readJudgeVerdict — what counts as a score", () => {
  it("accepts a number", () => {
    expect(readJudgeVerdict('{"score": 73}', criterion(), PASS_MARK).score).toBe(73);
  });

  it("accepts a numeric string", () => {
    expect(readJudgeVerdict('{"score": "73"}', criterion(), PASS_MARK).score).toBe(73);
  });

  it("falls back to `rating` when `score` is absent — the source's own alias", () => {
    expect(readJudgeVerdict('{"rating": 73}', criterion(), PASS_MARK).score).toBe(73);
  });

  it("REFUSES a boolean rather than scoring `true` as one point", () => {
    // `Number(true)` is 1, so the source scores `{"score": true}` a hair above
    // the floor, and the eval reads as a real, very low score rather than as an
    // unparseable answer.
    const verdict = readJudgeVerdict('{"score": true}', criterion(), PASS_MARK);
    expect(verdict.parsedFrom).toBe("unreadable");
    expect(verdict.score).toBe(0);
  });

  it("REFUSES an array rather than scoring `[]` as zero and `[7]` as seven", () => {
    expect(readJudgeVerdict('{"score": []}', criterion(), PASS_MARK).parsedFrom).toBe("unreadable");
    expect(readJudgeVerdict('{"score": [7]}', criterion(), PASS_MARK).parsedFrom).toBe("unreadable");
  });

  it("REFUSES null rather than scoring it as zero", () => {
    expect(readJudgeVerdict('{"score": null}', criterion(), PASS_MARK).parsedFrom).toBe("unreadable");
  });

  it("REFUSES a non-numeric string and an empty one", () => {
    expect(readJudgeVerdict('{"score": "high"}', criterion(), PASS_MARK).parsedFrom).toBe("unreadable");
    expect(readJudgeVerdict('{"score": "  "}', criterion(), PASS_MARK).parsedFrom).toBe("unreadable");
  });

  it("REFUSES a non-finite number", () => {
    expect(readJudgeVerdict('{"score": "Infinity"}', criterion(), PASS_MARK).parsedFrom).toBe("unreadable");
  });
});

describe("readJudgeVerdict — the pass decision", () => {
  it("respects an explicit `passed: false` even on a high score", () => {
    // The judge was given the criterion's own rubric and is entitled to
    // disagree with a global threshold.
    const verdict = readJudgeVerdict('{"score": 95, "passed": false}', criterion(), PASS_MARK);
    expect(verdict.passed).toBe(false);
  });

  it("respects an explicit `passed: true` on a low score", () => {
    expect(readJudgeVerdict('{"score": 5, "passed": true}', criterion(), PASS_MARK).passed).toBe(true);
  });

  it("falls back to the pass mark when the judge expressed no opinion", () => {
    expect(readJudgeVerdict('{"score": 50}', criterion(), PASS_MARK).passed).toBe(true);
    expect(readJudgeVerdict('{"score": 49.9}', criterion(), PASS_MARK).passed).toBe(false);
  });

  it("takes the pass mark it is GIVEN, not a module constant", () => {
    expect(readJudgeVerdict('{"score": 60}', criterion(), 80).passed).toBe(false);
    expect(readJudgeVerdict('{"score": 60}', criterion(), 20).passed).toBe(true);
  });

  it("compares the NORMALISED score, not the raw one", () => {
    // 6 out of 10 normalises to 60, which is above a pass mark of 50; the raw 6
    // is not.
    const verdict = readJudgeVerdict('{"score": 6}', criterion({ scoreScaleMax: 10 }), PASS_MARK);
    expect(verdict.score).toBe(60);
    expect(verdict.passed).toBe(true);
  });

  it("ignores a non-boolean `passed` and uses the mark", () => {
    expect(readJudgeVerdict('{"score": 90, "passed": "yes"}', criterion(), PASS_MARK).passed).toBe(true);
  });
});

describe("readJudgeVerdict — the rationale", () => {
  it("reads `rationale`, then `reasoning`, then `explanation`", () => {
    expect(readJudgeVerdict('{"score": 1, "rationale": "a"}', criterion(), PASS_MARK).rationale).toBe("a");
    expect(readJudgeVerdict('{"score": 1, "reasoning": "b"}', criterion(), PASS_MARK).rationale).toBe("b");
    expect(readJudgeVerdict('{"score": 1, "explanation": "c"}', criterion(), PASS_MARK).rationale).toBe("c");
  });

  it("prefers `rationale` when more than one is present", () => {
    const verdict = readJudgeVerdict('{"score": 1, "rationale": "a", "reasoning": "b"}', criterion(), PASS_MARK);
    expect(verdict.rationale).toBe("a");
  });

  it("answers null rather than stringifying a non-string rationale", () => {
    expect(readJudgeVerdict('{"score": 1, "rationale": 5}', criterion(), PASS_MARK).rationale).toBeNull();
  });
});
