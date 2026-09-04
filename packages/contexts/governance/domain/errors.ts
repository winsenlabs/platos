// The `governance` error catalogue.
//
// M0.4 §2 fixes `code` as a SCREAMING_SNAKE string that is immutable within a
// major, and the kernel makes an error a VALUE rather than a thrown class. Every
// code this context can produce is minted here, once, so a transport builds its
// status table from one list and an operator grepping a log finds exactly one
// definition.
//
// TWO CODES PER ADJACENT GUARD, WHEREVER TWO GUARDS SIT NEXT TO EACH OTHER.
// The extraction source throws bare `Error("name required")`, `Error("Criterion
// not found")` and `Error("Golden set not found")` from a dozen places, and
// three of its refusals are genuinely different decisions wearing one sentence:
//
//   * a criterion whose NAME is unusable, whose PROMPT is unusable, and whose
//     SCORE SCALE is unusable are three codes below, because the operator's
//     remedy differs and because two checks sharing a code cannot be told apart
//     by a test;
//   * a golden set that is too wide, too deep, or too large in the PRODUCT of
//     the two are likewise three codes, since the same set can breach exactly
//     one of them;
//   * an inactive criterion, a judge model that will not parse, and a judge
//     that is the model under test are three codes, not one "cannot run".
//
// WHERE ONE CODE COVERS MORE THAN ONE DECISION IT IS SAID SO AT THE
// CONSTRUCTOR, and they fall into two kinds rather than one list.
//
// DELIBERATE CONCEALMENT, where telling the two apart would be the probe: a
// rating target that does not exist and one belonging to somebody else answer
// identically, a cross-scope read answers `not_found`, and
// `GOVERNANCE_TRANSCRIPT_NOT_FOUND` covers a thread that is absent and one that
// is present and another agent's.
//
// A SHARED SHAPE, where the remedy is the same and the payload says which: the
// `fields` violation carries a `field` and a `code`, so a blank name and an
// over-long one both answer `GOVERNANCE_CRITERION_NAME_INVALID`, a blank judge
// prompt and an over-long one both answer the prompt's code, and a negative
// offset and an unusable limit both answer `GOVERNANCE_PAGE_REQUEST_INVALID`.
// That is not the defect this file is guarding against — the caller reads
// `field` to fix its request — but it IS the reason `errors.test.ts` checking
// constructors for uniqueness is not enough on its own.
//
// This inventory is maintained by hand and its known limit is that
// `errors.test.ts` can only check CONSTRUCTORS for uniqueness, not guards. Two
// guards calling one constructor are invisible to it — which is how the rubric
// ceiling came to share the judge prompt's code until a review found it.

import { domainError, type DomainError, type FieldViolation } from "@platos/kernel";

export const GOVERNANCE_ERROR_CODES = [
  "GOVERNANCE_SCOPE_MISMATCH",
  "GOVERNANCE_LEDGER_UNAVAILABLE",
  "GOVERNANCE_QUEUE_UNAVAILABLE",
  "GOVERNANCE_PAGE_REQUEST_INVALID",
  "GOVERNANCE_SAFETY_RULE_MALFORMED",
  "GOVERNANCE_SAFETY_DETECTOR_UNKNOWN",
  "GOVERNANCE_SAFETY_ACTION_UNKNOWN",
  "GOVERNANCE_SAFETY_SEVERITY_UNKNOWN",
  "GOVERNANCE_RATING_VALUE_INVALID",
  "GOVERNANCE_RATING_COMMENT_TOO_LONG",
  "GOVERNANCE_RATING_ACTOR_FORBIDDEN",
  "GOVERNANCE_RATING_TARGET_NOT_FOUND",
  "GOVERNANCE_CRITERION_NOT_FOUND",
  "GOVERNANCE_CRITERION_ALREADY_EXISTS",
  "GOVERNANCE_CRITERION_INACTIVE",
  "GOVERNANCE_CRITERION_NAME_INVALID",
  "GOVERNANCE_CRITERION_PROMPT_INVALID",
  "GOVERNANCE_CRITERION_RUBRIC_INVALID",
  "GOVERNANCE_CRITERION_SCALE_INVALID",
  "GOVERNANCE_EVAL_NOT_FOUND",
  "GOVERNANCE_EVAL_SELF_JUDGED",
  "GOVERNANCE_EVALS_DISABLED",
  "GOVERNANCE_JUDGE_MODEL_INVALID",
  "GOVERNANCE_JUDGE_UNAVAILABLE",
  "GOVERNANCE_TRANSCRIPT_NOT_FOUND",
  "GOVERNANCE_GOLDEN_SET_NOT_FOUND",
  "GOVERNANCE_GOLDEN_SET_ALREADY_EXISTS",
  "GOVERNANCE_GOLDEN_SET_INVALID",
  "GOVERNANCE_GOLDEN_SET_TOO_MANY_THREADS",
  "GOVERNANCE_GOLDEN_SET_TOO_MANY_CRITERIA",
  "GOVERNANCE_GOLDEN_SET_TOO_MANY_PAIRS",
  "GOVERNANCE_AGENT_NOT_VISIBLE",
  "GOVERNANCE_ERASURE_PLAN_FOREIGN",
] as const;

export type GovernanceErrorCode = (typeof GOVERNANCE_ERROR_CODES)[number];

/**
 * `forbidden`, not `not_found`: the grant resolves, but to a different place in
 * the tenant tree than the caller claimed. Transports that must not confirm
 * existence render it as a 404; the code stays distinct so that is a decision
 * rather than an accident.
 */
export function scopeMismatch(expectedPath: string, grantedPath: string): DomainError {
  return domainError("GOVERNANCE_SCOPE_MISMATCH", "forbidden", "authorization does not belong to the requested scope", {
    details: { expectedPath, grantedPath },
  });
}

export function ledgerUnavailable(reason: string): DomainError {
  return domainError("GOVERNANCE_LEDGER_UNAVAILABLE", "unavailable", "governance store is unavailable", {
    retryAfterSeconds: 5,
    details: { reason },
  });
}

/**
 * The durable seam an eval run is handed to would not take it.
 *
 * Distinct from `ledgerUnavailable` on purpose: "the dispatcher refused the
 * work" and "a table is down" are different incidents with different remedies,
 * and `EvalRunQueue` requires an implementation to use this one so the two stay
 * separable at every transport downstream.
 */
export function queueUnavailable(reason: string): DomainError {
  return domainError("GOVERNANCE_QUEUE_UNAVAILABLE", "unavailable", "eval run queue is unavailable", {
    retryAfterSeconds: 10,
    details: { reason },
  });
}

/**
 * A page a caller asked for that no clamp can rescue.
 *
 * TWO decisions answer this: a negative offset, and a limit that is not a whole
 * number of rows at least one. They share a code because they share a remedy —
 * fix the request — and are told apart by the `field` on the violation, which is
 * `offset` or `limit`. Both are refused rather than clamped: clamping a negative
 * offset to zero serves page one to something that believes it is reading page
 * minus-three.
 */
export function pageRequestInvalid(message: string, fields: readonly FieldViolation[] = []): DomainError {
  return domainError("GOVERNANCE_PAGE_REQUEST_INVALID", "invalid_input", message, { fields });
}

// --- the safety ledger -------------------------------------------------------

/**
 * A kernel `SafetyObservation` whose `rule` is not a dotted rule identity.
 *
 * Distinct from `safetyDetectorUnknown` because the remedy differs: a malformed
 * rule is a producer that never adopted the identity format, while an unknown
 * detector is a producer naming a detector this ledger has no column vocabulary
 * for.
 */
export function safetyRuleMalformed(rule: string): DomainError {
  return domainError(
    "GOVERNANCE_SAFETY_RULE_MALFORMED",
    "invalid_input",
    "safety rule identity must be dotted as <producer>.<detector>.<verdict>",
    { details: { rule } },
  );
}

export function safetyDetectorUnknown(detector: string): DomainError {
  return domainError("GOVERNANCE_SAFETY_DETECTOR_UNKNOWN", "invalid_input", "no such safety detector", {
    details: { detector },
  });
}

export function safetyActionUnknown(action: string): DomainError {
  return domainError("GOVERNANCE_SAFETY_ACTION_UNKNOWN", "invalid_input", "no such safety action", {
    details: { action },
  });
}

export function safetySeverityUnknown(severity: string): DomainError {
  return domainError("GOVERNANCE_SAFETY_SEVERITY_UNKNOWN", "invalid_input", "no such safety severity", {
    details: { severity },
  });
}

// --- ratings -----------------------------------------------------------------

/** A thumb is exactly `1` or `-1`. Zero is not a neutral vote; it is no vote. */
export function ratingValueInvalid(value: number): DomainError {
  return domainError("GOVERNANCE_RATING_VALUE_INVALID", "invalid_input", "a rating must be exactly 1 or -1", {
    details: { value: Number.isFinite(value) ? value : String(value) },
  });
}

export function ratingCommentTooLong(length: number, maximum: number): DomainError {
  return domainError("GOVERNANCE_RATING_COMMENT_TOO_LONG", "invalid_input", "rating comment is too long", {
    fields: [{ field: "comment", code: "too_long", message: `at most ${maximum} characters` }],
    details: { length, maximum },
  });
}

/**
 * An operator principal moving an END USER's rating.
 *
 * The extraction source refuses this and the refusal is kept verbatim: a
 * satisfaction score an operator can write is not a satisfaction score. It is
 * `forbidden` rather than `invalid_input` because the input is well formed and
 * the actor is the problem.
 */
export function ratingActorForbidden(): DomainError {
  return domainError(
    "GOVERNANCE_RATING_ACTOR_FORBIDDEN",
    "forbidden",
    "operator principals cannot write an end user's rating",
  );
}

/**
 * DELIBERATELY ONE CODE FOR TWO INPUTS. A turn that does not exist in this
 * environment and a turn that exists but belongs to a different end user answer
 * identically, because telling them apart is exactly the probe that lets a
 * caller enumerate other people's turns. Both paths are exercised separately in
 * the suite by asserting that NO row was written, so the shared code hides no
 * untested branch.
 */
export function ratingTargetNotFound(turnId: string): DomainError {
  return domainError("GOVERNANCE_RATING_TARGET_NOT_FOUND", "not_found", "no rateable turn with that id", {
    details: { turnId },
  });
}

// --- criteria ----------------------------------------------------------------

export function criterionNotFound(criterionId: string): DomainError {
  return domainError("GOVERNANCE_CRITERION_NOT_FOUND", "not_found", "criterion is not visible in this scope", {
    details: { criterionId },
  });
}

/** The `@@unique([environmentId, name])` constraint, in the domain. */
export function criterionAlreadyExists(environmentId: string, name: string): DomainError {
  return domainError(
    "GOVERNANCE_CRITERION_ALREADY_EXISTS",
    "conflict",
    "a criterion with that name already exists in this environment",
    { details: { environmentId, name } },
  );
}

/**
 * `precondition_failed`, not `not_found`: the criterion is right there and the
 * operator fixes this by activating it, which is a different action from
 * finding the right id.
 */
export function criterionInactive(criterionId: string): DomainError {
  return domainError("GOVERNANCE_CRITERION_INACTIVE", "precondition_failed", "criterion is not active", {
    details: { criterionId },
  });
}

/**
 * The two name failures — blank and over the ceiling — share this code and are
 * told apart by `fields[0].code`, which is `blank` or `too_long`. Both are
 * asserted separately in `criterion.test.ts`.
 */
export function criterionNameInvalid(fields: readonly FieldViolation[]): DomainError {
  return domainError("GOVERNANCE_CRITERION_NAME_INVALID", "invalid_input", "criterion name is not usable", { fields });
}

/** Same two-violation shape as the name, for the judge prompt. */
export function criterionPromptInvalid(fields: readonly FieldViolation[]): DomainError {
  return domainError("GOVERNANCE_CRITERION_PROMPT_INVALID", "invalid_input", "judge prompt is not usable", { fields });
}

/**
 * The RUBRIC's own code, and it is separate for the reason rule 5 exists.
 *
 * It used to answer `GOVERNANCE_CRITERION_PROMPT_INVALID`, which made two
 * ceilings — the judge prompt's and the rubric's — indistinguishable to a caller
 * and, worse, to a test: a suite asserting only the code cannot tell which of
 * the two guards it reached, so deleting either one leaves the other's case
 * green. They are different remedies, so they are different codes.
 *
 * The rubric is OPTIONAL, so there is no blank violation here: a blank rubric is
 * no rubric, and `admitRubric` answers null for it.
 */
export function criterionRubricInvalid(fields: readonly FieldViolation[]): DomainError {
  return domainError("GOVERNANCE_CRITERION_RUBRIC_INVALID", "invalid_input", "criterion rubric is not usable", {
    fields,
  });
}

/**
 * A score scale that cannot normalise a judge's answer.
 *
 * Its own code because it is the one criterion field whose breakage is SILENT
 * downstream: the source's normaliser answers 0 for every score when the range
 * is not positive, so an unusable scale reads as a criterion every conversation
 * fails rather than as a criterion nobody can score.
 */
export function criterionScaleInvalid(minimum: number, maximum: number): DomainError {
  return domainError(
    "GOVERNANCE_CRITERION_SCALE_INVALID",
    "invalid_input",
    "score scale must be two integers with the minimum below the maximum",
    { details: { minimum: safeNumber(minimum), maximum: safeNumber(maximum) } },
  );
}

// --- evals -------------------------------------------------------------------

export function evalNotFound(evalId: string): DomainError {
  return domainError("GOVERNANCE_EVAL_NOT_FOUND", "not_found", "eval is not visible in this scope", {
    details: { evalId },
  });
}

/**
 * The no-self-evaluation invariant.
 *
 * `conflict` rather than `invalid_input`: both the judge model and the agent's
 * model are individually valid, and it is the PAIR that is refused.
 */
export function evalSelfJudged(judgeModel: string, agentModel: string): DomainError {
  return domainError(
    "GOVERNANCE_EVAL_SELF_JUDGED",
    "conflict",
    "the judge model is the model that produced the conversation being scored",
    { details: { judgeModel, agentModel } },
  );
}

/** The kill switch. Every judging path checks it; nothing routes around it. */
export function evalsDisabled(): DomainError {
  return domainError("GOVERNANCE_EVALS_DISABLED", "precondition_failed", "eval judging is disabled for this install");
}

export function judgeModelInvalid(spec: string, reason: string): DomainError {
  return domainError("GOVERNANCE_JUDGE_MODEL_INVALID", "invalid_input", "judge model specification is not usable", {
    details: { spec, reason },
  });
}

export function judgeUnavailable(reason: string): DomainError {
  return domainError("GOVERNANCE_JUDGE_UNAVAILABLE", "unavailable", "the judge could not be reached", {
    retryAfterSeconds: 10,
    details: { reason },
  });
}

/**
 * No conversation to score.
 *
 * TWO decisions answer this, and the sharing is deliberate concealment in the
 * same way `ratingTargetNotFound` is: the thread may be absent from this
 * environment, or it may be present and belong to a DIFFERENT agent than the
 * caller named. Distinguishing them would let an operator with a grant for one
 * agent enumerate another's threads by id.
 */
export function transcriptNotFound(threadId: string): DomainError {
  return domainError("GOVERNANCE_TRANSCRIPT_NOT_FOUND", "not_found", "no conversation with that id in this scope", {
    details: { threadId },
  });
}

// --- golden sets -------------------------------------------------------------

export function goldenSetNotFound(goldenSetId: string): DomainError {
  return domainError("GOVERNANCE_GOLDEN_SET_NOT_FOUND", "not_found", "golden set is not visible in this scope", {
    details: { goldenSetId },
  });
}

/** The `@@unique([environmentId, agentId, name])` constraint, in the domain. */
export function goldenSetAlreadyExists(environmentId: string, agentId: string, name: string): DomainError {
  return domainError(
    "GOVERNANCE_GOLDEN_SET_ALREADY_EXISTS",
    "conflict",
    "a golden set with that name already exists for this agent",
    { details: { environmentId, agentId, name } },
  );
}

export function goldenSetInvalid(fields: readonly FieldViolation[]): DomainError {
  return domainError("GOVERNANCE_GOLDEN_SET_INVALID", "invalid_input", "golden set is not usable", { fields });
}

export function goldenSetTooManyThreads(count: number, maximum: number): DomainError {
  return domainError("GOVERNANCE_GOLDEN_SET_TOO_MANY_THREADS", "invalid_input", "golden set names too many threads", {
    details: { count, maximum },
  });
}

export function goldenSetTooManyCriteria(count: number, maximum: number): DomainError {
  return domainError("GOVERNANCE_GOLDEN_SET_TOO_MANY_CRITERIA", "invalid_input", "golden set names too many criteria", {
    details: { count, maximum },
  });
}

/**
 * The product cap. A run fans out one judge call per pair, so this is the cap
 * that bounds SPEND, where the other two bound a LIST.
 *
 * Each of the three is breachable on its own — under the shipped ceilings, 101
 * threads by 1 criterion trips only the thread cap, 21 criteria by 1 thread
 * trips only the criterion cap, and 30 by 20 trips only this one — which is why
 * there are three codes and not one.
 */
export function goldenSetTooManyPairs(pairs: number, maximum: number): DomainError {
  return domainError("GOVERNANCE_GOLDEN_SET_TOO_MANY_PAIRS", "invalid_input", "golden set plans too many judge calls", {
    details: { pairs, maximum },
  });
}

// --- peers and erasure -------------------------------------------------------

/** `agents` does not show this agent to this environment. Never confirms one exists. */
export function agentNotVisible(agentId: string): DomainError {
  return domainError("GOVERNANCE_AGENT_NOT_VISIBLE", "not_found", "agent is not visible in this scope", {
    details: { agentId },
  });
}

/** An erasure plan this context did not mint, handed back to it to carry out. */
export function erasurePlanForeign(targetName: string): DomainError {
  return domainError(
    "GOVERNANCE_ERASURE_PLAN_FOREIGN",
    "invalid_input",
    "erasure plan was not minted by this target",
    { details: { targetName } },
  );
}

function safeNumber(value: number): number | string {
  return Number.isFinite(value) ? value : String(value);
}
