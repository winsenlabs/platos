import { asIdentifier } from "@platos/kernel";
import { describe, expect, it } from "vitest";

import {
  admitCriterion,
  appliesToAgent,
  applyCriterionPatch,
  criterionSnapshot,
  type CriterionDraft,
  type EvalCriterion,
} from "./criterion.js";
import type { ActorId, AgentId, EvalCriterionId } from "./identifiers.js";
import { COLUMN_SCORE_SCALE_MAX } from "./policy.js";

// Literals, not the shipped policy: a ceiling test derived from the constant it
// tests stays green when the constant moves.
const POLICY = {
  maxNameLength: 10,
  maxPromptLength: 20,
  maxRubricLength: 20,
  maxPageSize: 200,
  defaultPageSize: 50,
  defaultScoreScaleMin: 0,
  defaultScoreScaleMax: 100,
} as const;

const AGENT = asIdentifier<AgentId>("agent-1");
const AT = new Date("2026-03-01T12:00:00.000Z");
const LATER = new Date("2026-03-02T12:00:00.000Z");

function draft(overrides: Partial<CriterionDraft> = {}): CriterionDraft {
  return { name: "grounded", judgePrompt: "score it", ...overrides };
}

function stored(overrides: Partial<EvalCriterion> = {}): EvalCriterion {
  return {
    evalCriterionId: asIdentifier<EvalCriterionId>("criterion-1"),
    environmentId: "env-1",
    agentId: null,
    name: "grounded",
    description: null,
    judgePrompt: "score it",
    rubric: null,
    judgeModel: null,
    scoreScaleMin: 0,
    scoreScaleMax: 100,
    isActive: true,
    createdBy: asIdentifier<ActorId>("operator-1"),
    createdAt: AT,
    updatedAt: AT,
    ...overrides,
  };
}

describe("admitCriterion", () => {
  it("admits a well-formed draft and trims the name", () => {
    const admitted = admitCriterion(draft({ name: "  grounded  " }), POLICY);
    expect(admitted.ok && admitted.value.name).toBe("grounded");
  });

  it("REFUSES a blank name, with a `blank` field violation", () => {
    const admitted = admitCriterion(draft({ name: "   " }), POLICY);
    expect(!admitted.ok && admitted.error.code).toBe("GOVERNANCE_CRITERION_NAME_INVALID");
    expect(!admitted.ok && admitted.error.fields[0]?.code).toBe("blank");
  });

  it("REFUSES an over-long name, with a DIFFERENT field violation", () => {
    const admitted = admitCriterion(draft({ name: "01234567890" }), POLICY);
    expect(!admitted.ok && admitted.error.code).toBe("GOVERNANCE_CRITERION_NAME_INVALID");
    expect(!admitted.ok && admitted.error.fields[0]?.code).toBe("too_long");
  });

  it("admits a name at EXACTLY the ceiling", () => {
    expect(admitCriterion(draft({ name: "0123456789" }), POLICY).ok).toBe(true);
  });

  it("REFUSES a blank judge prompt, with its OWN code", () => {
    const admitted = admitCriterion(draft({ judgePrompt: "  " }), POLICY);
    expect(!admitted.ok && admitted.error.code).toBe("GOVERNANCE_CRITERION_PROMPT_INVALID");
  });

  it("REFUSES an over-long judge prompt", () => {
    const admitted = admitCriterion(draft({ judgePrompt: "x".repeat(21) }), POLICY);
    expect(!admitted.ok && admitted.error.code).toBe("GOVERNANCE_CRITERION_PROMPT_INVALID");
    expect(!admitted.ok && admitted.error.fields[0]?.code).toBe("too_long");
  });

  it("REFUSES a scale whose minimum is not below its maximum, with a THIRD code", () => {
    const equal = admitCriterion(draft({ scoreScaleMin: 5, scoreScaleMax: 5 }), POLICY);
    expect(!equal.ok && equal.error.code).toBe("GOVERNANCE_CRITERION_SCALE_INVALID");
    const inverted = admitCriterion(draft({ scoreScaleMin: 100, scoreScaleMax: 0 }), POLICY);
    expect(!inverted.ok && inverted.error.code).toBe("GOVERNANCE_CRITERION_SCALE_INVALID");
  });

  it("REFUSES a non-integer scale", () => {
    expect(admitCriterion(draft({ scoreScaleMin: 0.5, scoreScaleMax: 10 }), POLICY).ok).toBe(false);
    expect(admitCriterion(draft({ scoreScaleMin: 0, scoreScaleMax: Number.NaN }), POLICY).ok).toBe(false);
  });

  it("admits a scale one apart — the narrowest usable range", () => {
    const admitted = admitCriterion(draft({ scoreScaleMin: 0, scoreScaleMax: 1 }), POLICY);
    expect(admitted.ok && admitted.value.scoreScaleMax).toBe(1);
  });

  it("takes the SERVICE default scale when none is named", () => {
    const admitted = admitCriterion(draft(), POLICY);
    expect(admitted.ok && admitted.value.scoreScaleMin).toBe(0);
    expect(admitted.ok && admitted.value.scoreScaleMax).toBe(100);
  });

  it("names the COLUMN default too, so the disagreement is provable", () => {
    // The schema defaults `scoreScaleMax` to 1 while the service writes 100, so
    // a row written around the service scores on a different scale. Nothing
    // reads this constant; it exists to make the disagreement visible.
    expect(COLUMN_SCORE_SCALE_MAX).toBe(1);
    expect(POLICY.defaultScoreScaleMax).not.toBe(COLUMN_SCORE_SCALE_MAX);
  });

  it("normalises an empty description, rubric and judge model to null", () => {
    const admitted = admitCriterion(draft({ description: "  ", rubric: "", judgeModel: "  " }), POLICY);
    expect(admitted.ok && admitted.value.description).toBeNull();
    expect(admitted.ok && admitted.value.rubric).toBeNull();
    expect(admitted.ok && admitted.value.judgeModel).toBeNull();
  });

  it("defaults a shared criterion's agent to null rather than to undefined", () => {
    const admitted = admitCriterion(draft(), POLICY);
    expect(admitted.ok && admitted.value.agentId).toBeNull();
  });
});

describe("applyCriterionPatch", () => {
  it("leaves an absent key alone and clears an explicit null", () => {
    const patched = applyCriterionPatch(stored({ description: "old" }), { description: null }, POLICY, LATER);
    expect(patched.ok && patched.value.description).toBeNull();
    const untouched = applyCriterionPatch(stored({ description: "old" }), {}, POLICY, LATER);
    expect(untouched.ok && untouched.value.description).toBe("old");
  });

  it("stamps the supplied instant", () => {
    const patched = applyCriterionPatch(stored(), { name: "renamed" }, POLICY, LATER);
    expect(patched.ok && patched.value.updatedAt).toBe(LATER);
    expect(patched.ok && patched.value.createdAt).toBe(AT);
  });

  it("RE-ADMITS THE SCALE AS A PAIR when only one half moved", () => {
    // The source writes each supplied field independently and checks neither, so
    // raising the minimum above an untouched maximum stores a criterion whose
    // every future score normalises to zero — an agent that appears to fail
    // everything, with no error anywhere.
    const patched = applyCriterionPatch(stored({ scoreScaleMax: 10 }), { scoreScaleMin: 50 }, POLICY, LATER);
    expect(patched.ok).toBe(false);
    expect(!patched.ok && patched.error.code).toBe("GOVERNANCE_CRITERION_SCALE_INVALID");
  });

  it("admits a scale patch that stays coherent", () => {
    const patched = applyCriterionPatch(stored(), { scoreScaleMin: 1, scoreScaleMax: 5 }, POLICY, LATER);
    expect(patched.ok && patched.value.scoreScaleMin).toBe(1);
    expect(patched.ok && patched.value.scoreScaleMax).toBe(5);
  });

  it("re-checks the NAME ceiling on a patch, not only on a create", () => {
    const patched = applyCriterionPatch(stored(), { name: "01234567890" }, POLICY, LATER);
    expect(!patched.ok && patched.error.code).toBe("GOVERNANCE_CRITERION_NAME_INVALID");
  });

  it("moves `isActive` and leaves it alone when absent", () => {
    const off = applyCriterionPatch(stored(), { isActive: false }, POLICY, LATER);
    expect(off.ok && off.value.isActive).toBe(false);
    const same = applyCriterionPatch(stored({ isActive: false }), {}, POLICY, LATER);
    expect(same.ok && same.value.isActive).toBe(false);
  });

  it("re-scopes a shared criterion onto one agent, and back", () => {
    const scoped = applyCriterionPatch(stored(), { agentId: AGENT }, POLICY, LATER);
    expect(scoped.ok && scoped.value.agentId).toBe(AGENT);
    const shared = applyCriterionPatch(stored({ agentId: AGENT }), { agentId: null }, POLICY, LATER);
    expect(shared.ok && shared.value.agentId).toBeNull();
  });
});

describe("criterionSnapshot", () => {
  it("carries every scoring-relevant field and nothing else", () => {
    const snapshot = criterionSnapshot(stored({ rubric: "0 bad, 100 good", judgeModel: "openai:gpt-5" }));
    expect(snapshot).toEqual({
      name: "grounded",
      description: null,
      judgePrompt: "score it",
      rubric: "0 bad, 100 good",
      judgeModel: "openai:gpt-5",
      scoreScaleMin: 0,
      scoreScaleMax: 100,
    });
  });

  it("does NOT carry the id, the environment, the actor or the timestamps", () => {
    const snapshot = criterionSnapshot(stored()) as unknown as Record<string, unknown>;
    for (const key of ["evalCriterionId", "environmentId", "createdBy", "createdAt", "updatedAt", "isActive"]) {
      expect(key in snapshot).toBe(false);
    }
  });

  it("is frozen, so an eval's stored question cannot be edited after the fact", () => {
    expect(Object.isFrozen(criterionSnapshot(stored()))).toBe(true);
  });
});

describe("appliesToAgent", () => {
  it("applies a SHARED criterion to every agent", () => {
    expect(appliesToAgent(stored({ agentId: null }), AGENT)).toBe(true);
  });

  it("applies an agent-scoped criterion to that agent only", () => {
    expect(appliesToAgent(stored({ agentId: AGENT }), AGENT)).toBe(true);
    expect(appliesToAgent(stored({ agentId: AGENT }), asIdentifier<AgentId>("agent-2"))).toBe(false);
  });
});
