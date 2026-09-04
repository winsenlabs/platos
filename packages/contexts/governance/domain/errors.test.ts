import { describe, expect, it } from "vitest";

import {
  GOVERNANCE_ERROR_CODES,
  agentNotVisible,
  criterionAlreadyExists,
  criterionInactive,
  criterionNameInvalid,
  criterionNotFound,
  criterionPromptInvalid,
  criterionScaleInvalid,
  erasurePlanForeign,
  evalNotFound,
  evalSelfJudged,
  evalsDisabled,
  goldenSetAlreadyExists,
  goldenSetInvalid,
  goldenSetNotFound,
  goldenSetTooManyCriteria,
  goldenSetTooManyPairs,
  goldenSetTooManyThreads,
  judgeModelInvalid,
  judgeUnavailable,
  ledgerUnavailable,
  pageRequestInvalid,
  queueUnavailable,
  ratingActorForbidden,
  ratingCommentTooLong,
  ratingTargetNotFound,
  ratingValueInvalid,
  safetyActionUnknown,
  safetyDetectorUnknown,
  safetyRuleMalformed,
  safetySeverityUnknown,
  scopeMismatch,
  transcriptNotFound,
} from "./errors.js";

const EVERY_CONSTRUCTOR = [
  scopeMismatch("a", "b"),
  ledgerUnavailable("down"),
  queueUnavailable("down"),
  pageRequestInvalid("bad"),
  safetyRuleMalformed("nope"),
  safetyDetectorUnknown("nope"),
  safetyActionUnknown("nope"),
  safetySeverityUnknown("nope"),
  ratingValueInvalid(0),
  ratingCommentTooLong(10, 5),
  ratingActorForbidden(),
  ratingTargetNotFound("turn-1"),
  criterionNotFound("criterion-1"),
  criterionAlreadyExists("env-1", "name"),
  criterionInactive("criterion-1"),
  criterionNameInvalid([{ field: "name", code: "blank", message: "required" }]),
  criterionPromptInvalid([{ field: "judgePrompt", code: "blank", message: "required" }]),
  criterionScaleInvalid(5, 5),
  evalNotFound("eval-1"),
  evalSelfJudged("a", "a"),
  evalsDisabled(),
  judgeModelInvalid("::", "leading-separator"),
  judgeUnavailable("down"),
  transcriptNotFound("thread-1"),
  goldenSetNotFound("golden-1"),
  goldenSetAlreadyExists("env-1", "agent-1", "name"),
  goldenSetInvalid([{ field: "name", code: "blank", message: "required" }]),
  goldenSetTooManyThreads(4, 3),
  goldenSetTooManyCriteria(4, 3),
  goldenSetTooManyPairs(9, 8),
  agentNotVisible("agent-1"),
  erasurePlanForeign("files"),
];

describe("the catalogue", () => {
  it("mints every declared code and nothing else", () => {
    const minted = new Set(EVERY_CONSTRUCTOR.map((error) => error.code));
    expect([...minted].sort()).toEqual([...GOVERNANCE_ERROR_CODES].sort());
  });

  it("declares each code exactly once", () => {
    expect(new Set(GOVERNANCE_ERROR_CODES).size).toBe(GOVERNANCE_ERROR_CODES.length);
  });

  it("gives every constructor its OWN code — no two guards answer alike", () => {
    // Two adjacent checks sharing a code cannot be told apart by a test, which
    // is how a guard comes to be unfalsifiable. Only the two DELIBERATE sharings
    // exist in this context, and both are between two INPUTS to one constructor
    // rather than between two constructors, so this stays exact.
    expect(new Set(EVERY_CONSTRUCTOR.map((error) => error.code)).size).toBe(EVERY_CONSTRUCTOR.length);
  });

  it("uses SCREAMING_SNAKE codes the kernel accepts", () => {
    for (const code of GOVERNANCE_ERROR_CODES) expect(code).toMatch(/^[A-Z][A-Z0-9_]*$/u);
  });

  it("prefixes every code with the context name, so a log grep finds one owner", () => {
    for (const code of GOVERNANCE_ERROR_CODES) expect(code.startsWith("GOVERNANCE_")).toBe(true);
  });

  it("freezes the value, so a transport cannot rewrite an error in flight", () => {
    expect(Object.isFrozen(criterionNotFound("criterion-1"))).toBe(true);
  });
});

describe("categories carry the decision, not just the sentence", () => {
  it("a cross-scope grant is FORBIDDEN — the grant resolved, elsewhere", () => {
    expect(scopeMismatch("a", "b").category).toBe("forbidden");
  });

  it("an operator writing an end user's rating is FORBIDDEN, not invalid input", () => {
    expect(ratingActorForbidden().category).toBe("forbidden");
  });

  it("a missing rating target is NOT_FOUND, so probing cannot enumerate turns", () => {
    expect(ratingTargetNotFound("turn-1").category).toBe("not_found");
  });

  it("an inactive criterion is PRECONDITION_FAILED — it is there, and switched off", () => {
    expect(criterionInactive("criterion-1").category).toBe("precondition_failed");
  });

  it("self-judging is CONFLICT — both models are valid and the PAIR is refused", () => {
    expect(evalSelfJudged("a", "a").category).toBe("conflict");
  });

  it("the kill switch is PRECONDITION_FAILED, not forbidden: nobody is denied", () => {
    expect(evalsDisabled().category).toBe("precondition_failed");
  });

  it("both uniqueness constraints are CONFLICT", () => {
    expect(criterionAlreadyExists("env-1", "n").category).toBe("conflict");
    expect(goldenSetAlreadyExists("env-1", "agent-1", "n").category).toBe("conflict");
  });

  it("an unreachable store or judge is UNAVAILABLE and says when to retry", () => {
    expect(ledgerUnavailable("x").category).toBe("unavailable");
    expect(ledgerUnavailable("x").retryAfterSeconds).toBe(5);
    expect(queueUnavailable("x").retryAfterSeconds).toBe(10);
    expect(judgeUnavailable("x").retryAfterSeconds).toBe(10);
  });

  it("only retryable categories carry a retry hint", () => {
    for (const error of EVERY_CONSTRUCTOR) {
      if (error.retryAfterSeconds !== null) expect(error.category).toBe("unavailable");
    }
  });
});

describe("the three golden-set ceilings are three codes", () => {
  it("names threads, criteria and pairs separately", () => {
    // A set can breach exactly one of the three, so one shared code would make
    // two of the three guards unprovable.
    expect(goldenSetTooManyThreads(4, 3).code).toBe("GOVERNANCE_GOLDEN_SET_TOO_MANY_THREADS");
    expect(goldenSetTooManyCriteria(4, 3).code).toBe("GOVERNANCE_GOLDEN_SET_TOO_MANY_CRITERIA");
    expect(goldenSetTooManyPairs(9, 8).code).toBe("GOVERNANCE_GOLDEN_SET_TOO_MANY_PAIRS");
  });

  it("reports the observed count and the ceiling it broke", () => {
    expect(goldenSetTooManyPairs(9, 8).details).toEqual({ pairs: 9, maximum: 8 });
  });
});

describe("details never carry a value that could be a secret", () => {
  it("reports a non-finite rating as a string rather than as NaN", () => {
    expect(ratingValueInvalid(Number.NaN).details).toEqual({ value: "NaN" });
  });

  it("reports a non-finite score scale as a string too", () => {
    expect(criterionScaleInvalid(Number.NaN, 10).details).toEqual({ minimum: "NaN", maximum: 10 });
  });
});

describe("field violations tell the two name failures apart", () => {
  it("carries a `blank` violation for an empty name", () => {
    const error = criterionNameInvalid([{ field: "name", code: "blank", message: "name is required" }]);
    expect(error.fields[0]?.code).toBe("blank");
  });

  it("carries a `too_long` violation for an oversized one", () => {
    const error = criterionNameInvalid([{ field: "name", code: "too_long", message: "at most 5" }]);
    expect(error.fields[0]?.code).toBe("too_long");
  });
});
