// An eval criterion: the question a judge is asked, and the scale it answers on.
//
// A criterion is environment-scoped and OPTIONALLY agent-scoped. A null
// `agentId` is a criterion shared by every agent in the environment, which is
// why the listing filter for "criteria that apply to agent X" is `agentId = X OR
// agentId IS NULL` rather than an equality — a shared criterion that stopped
// appearing for one agent would silently stop being scored.
//
// THE SNAPSHOT IS WHY EDITING A CRITERION IS SAFE. Every `AgentEval` freezes the
// criterion it was scored against into `criterionSnapshot`, so editing the
// question does not retroactively move historical scores. `criterionSnapshot()`
// is that freeze, taken once here rather than assembled inline at the write, so
// a field added to a criterion cannot be added to the entity and forgotten at
// the snapshot.
//
// THE SCALE IS THE ONE FIELD WHOSE BREAKAGE IS SILENT. The source's normaliser
// answers 0 for every score when `scoreScaleMax - scoreScaleMin <= 0`, so a
// criterion saved with min 100 and max 0 reads as a criterion every conversation
// fails, forever, with no error anywhere. It is refused at admission with its
// own code, and `judge-verdict.ts` keeps the defensive branch as well because
// the two are different defences: this one stops such a criterion being stored,
// that one stops a criterion stored before this rule existed from scoring.

import { err, ok, type Result } from "@platos/kernel";

import {
  criterionNameInvalid,
  criterionPromptInvalid,
  criterionRubricInvalid,
  criterionScaleInvalid,
} from "./errors.js";
import type { ActorId, AgentId, EvalCriterionId } from "./identifiers.js";
import type { CriterionPolicy } from "./policy.js";

export interface EvalCriterion {
  readonly evalCriterionId: EvalCriterionId;
  readonly environmentId: string;
  /** Null means the criterion applies to every agent in the environment. */
  readonly agentId: AgentId | null;
  readonly name: string;
  readonly description: string | null;
  readonly judgePrompt: string;
  readonly rubric: string | null;
  /** Null falls back to the install's default judge at scoring time. */
  readonly judgeModel: string | null;
  readonly scoreScaleMin: number;
  readonly scoreScaleMax: number;
  readonly isActive: boolean;
  readonly createdBy: ActorId;
  readonly createdAt: Date;
  readonly updatedAt: Date;
}

export interface CriterionDraft {
  readonly agentId?: AgentId | null;
  readonly name: string;
  readonly description?: string | null;
  readonly judgePrompt: string;
  readonly rubric?: string | null;
  readonly judgeModel?: string | null;
  readonly scoreScaleMin?: number | null;
  readonly scoreScaleMax?: number | null;
}

/** A patch. An absent key means "leave it"; an explicit null means "clear it". */
export interface CriterionPatch {
  readonly agentId?: AgentId | null;
  readonly name?: string;
  readonly description?: string | null;
  readonly judgePrompt?: string;
  readonly rubric?: string | null;
  readonly judgeModel?: string | null;
  readonly scoreScaleMin?: number;
  readonly scoreScaleMax?: number;
  readonly isActive?: boolean;
}

export interface AdmittedCriterion {
  readonly agentId: AgentId | null;
  readonly name: string;
  readonly description: string | null;
  readonly judgePrompt: string;
  readonly rubric: string | null;
  readonly judgeModel: string | null;
  readonly scoreScaleMin: number;
  readonly scoreScaleMax: number;
}

/** The frozen copy an eval carries. Every scoring-relevant field, nothing else. */
export interface CriterionSnapshot {
  readonly name: string;
  readonly description: string | null;
  readonly judgePrompt: string;
  readonly rubric: string | null;
  readonly judgeModel: string | null;
  readonly scoreScaleMin: number;
  readonly scoreScaleMax: number;
}

export function admitCriterion(draft: CriterionDraft, policy: CriterionPolicy): Result<AdmittedCriterion> {
  const name = admitName(draft.name, policy.maxNameLength);
  if (!name.ok) return err(name.error);
  const prompt = admitPrompt(draft.judgePrompt, policy.maxPromptLength);
  if (!prompt.ok) return err(prompt.error);
  const scale = admitScale(
    draft.scoreScaleMin ?? policy.defaultScoreScaleMin,
    draft.scoreScaleMax ?? policy.defaultScoreScaleMax,
  );
  if (!scale.ok) return err(scale.error);
  const rubric = admitRubric(draft.rubric ?? null, policy.maxRubricLength);
  if (!rubric.ok) return err(rubric.error);

  return ok({
    agentId: draft.agentId ?? null,
    name: name.value,
    description: emptyToNull(draft.description ?? null),
    judgePrompt: prompt.value,
    rubric: rubric.value,
    judgeModel: emptyToNull(draft.judgeModel ?? null),
    scoreScaleMin: scale.value.minimum,
    scoreScaleMax: scale.value.maximum,
  });
}

/**
 * Apply a patch to a stored criterion.
 *
 * The scale is re-admitted as a PAIR even when only one half moved, because
 * raising the minimum above an untouched maximum is exactly how the source
 * produces an unscoreable criterion: its update writes each supplied field
 * independently and checks neither.
 */
export function applyCriterionPatch(
  existing: EvalCriterion,
  patch: CriterionPatch,
  policy: CriterionPolicy,
  updatedAt: Date,
): Result<EvalCriterion> {
  const name = patch.name === undefined ? ok(existing.name) : admitName(patch.name, policy.maxNameLength);
  if (!name.ok) return err(name.error);
  const prompt =
    patch.judgePrompt === undefined ? ok(existing.judgePrompt) : admitPrompt(patch.judgePrompt, policy.maxPromptLength);
  if (!prompt.ok) return err(prompt.error);
  const scale = admitScale(
    patch.scoreScaleMin ?? existing.scoreScaleMin,
    patch.scoreScaleMax ?? existing.scoreScaleMax,
  );
  if (!scale.ok) return err(scale.error);
  const rubric =
    patch.rubric === undefined ? ok(existing.rubric) : admitRubric(patch.rubric, policy.maxRubricLength);
  if (!rubric.ok) return err(rubric.error);

  return ok({
    ...existing,
    agentId: patch.agentId === undefined ? existing.agentId : patch.agentId,
    name: name.value,
    description: patch.description === undefined ? existing.description : emptyToNull(patch.description),
    judgePrompt: prompt.value,
    rubric: rubric.value,
    judgeModel: patch.judgeModel === undefined ? existing.judgeModel : emptyToNull(patch.judgeModel),
    scoreScaleMin: scale.value.minimum,
    scoreScaleMax: scale.value.maximum,
    isActive: patch.isActive ?? existing.isActive,
    updatedAt,
  });
}

export function criterionSnapshot(criterion: EvalCriterion): CriterionSnapshot {
  return Object.freeze({
    name: criterion.name,
    description: criterion.description,
    judgePrompt: criterion.judgePrompt,
    rubric: criterion.rubric,
    judgeModel: criterion.judgeModel,
    scoreScaleMin: criterion.scoreScaleMin,
    scoreScaleMax: criterion.scoreScaleMax,
  });
}

/** Does this criterion apply to this agent? A shared criterion applies to all. */
export function appliesToAgent(criterion: EvalCriterion, agentId: AgentId): boolean {
  return criterion.agentId === null || criterion.agentId === agentId;
}

function admitName(value: string, maxLength: number): Result<string> {
  const trimmed = (value ?? "").trim();
  if (trimmed === "") {
    return err(criterionNameInvalid([{ field: "name", code: "blank", message: "name is required" }]));
  }
  if (trimmed.length > maxLength) {
    return err(
      criterionNameInvalid([
        { field: "name", code: "too_long", message: `at most ${maxLength} characters` },
      ]),
    );
  }
  return ok(trimmed);
}

function admitPrompt(value: string, maxLength: number): Result<string> {
  if ((value ?? "").trim() === "") {
    return err(criterionPromptInvalid([{ field: "judgePrompt", code: "blank", message: "judgePrompt is required" }]));
  }
  if (value.length > maxLength) {
    return err(
      criterionPromptInvalid([
        { field: "judgePrompt", code: "too_long", message: `at most ${maxLength} characters` },
      ]),
    );
  }
  return ok(value);
}

function admitRubric(value: string | null, maxLength: number): Result<string | null> {
  if (value === null) return ok(null);
  if (value.trim() === "") return ok(null);
  if (value.length > maxLength) {
    return err(
      criterionRubricInvalid([{ field: "rubric", code: "too_long", message: `at most ${maxLength} characters` }]),
    );
  }
  return ok(value);
}

function admitScale(
  minimum: number,
  maximum: number,
): Result<{ readonly minimum: number; readonly maximum: number }> {
  if (!Number.isInteger(minimum) || !Number.isInteger(maximum)) return err(criterionScaleInvalid(minimum, maximum));
  if (minimum >= maximum) return err(criterionScaleInvalid(minimum, maximum));
  return ok({ minimum, maximum });
}

function emptyToNull(value: string | null): string | null {
  if (value === null) return null;
  const trimmed = value.trim();
  return trimmed === "" ? null : trimmed;
}
