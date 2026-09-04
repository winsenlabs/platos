// The tunable limits, in one place, as data.
//
// Every value here is transcribed from the behaviour the running
// `SafetyEventService`, `RatingService`, `CriterionService`, `EvalService`,
// `GoldenSetService` and `GovernanceService` already have. They are a POLICY
// VALUE passed into a use case, not a module constant read from an ambient
// environment, because a limit read from a process variable inside a domain rule
// is untestable and is exactly the coupling ADR M0.3 §2 bans.
//
// TWO NUMBERS ARE NAMED THAT THE SOURCE DISAGREES WITH ITSELF ABOUT, and both
// are named rather than reconciled silently:
//
//   `EvalCriterion.scoreScaleMax` has a SCHEMA default of 1 while the service
//   writes 100 when the caller omits it, so a criterion created through the API
//   scores 0..100 and one written around the service scores 0..1. Both numbers
//   are below; `COLUMN_SCORE_SCALE_MAX` is not read by any rule and exists to
//   make the disagreement provable rather than folklore.
//
//   The judge's pass mark is hard-coded at 50 in the source's parser while the
//   criterion carries its own scale. Because the parser NORMALISES to 0..100
//   before comparing, 50 is a percentage and not a raw score — so it is a
//   policy value here, named `passMarkPercent`, and the normalisation it
//   depends on is pinned in `judge-verdict.test.ts`.
//
// THE THREE CAPS ON A GOLDEN SET ARE THREE CAPS, not one. A set can be inside
// both list ceilings and still plan more judge calls than an install will pay
// for, which is why `maxPairs` exists and is checked separately.

export interface SafetyPolicy {
  /** `SafetyEvent.detail` is truncated to this, never refused. See `safety-event.ts`. */
  readonly maxDetailLength: number;
  readonly maxPageSize: number;
  readonly defaultPageSize: number;
  readonly minWindowDays: number;
  readonly defaultWindowDays: number;
  readonly maxWindowDays: number;
}

export interface RatingPolicy {
  readonly maxCommentLength: number;
  readonly minWindowDays: number;
  readonly defaultWindowDays: number;
  readonly maxWindowDays: number;
}

export interface CriterionPolicy {
  readonly maxNameLength: number;
  readonly maxPromptLength: number;
  readonly maxRubricLength: number;
  readonly maxPageSize: number;
  readonly defaultPageSize: number;
  /** The SERVICE defaults. See the note above for the column's own. */
  readonly defaultScoreScaleMin: number;
  readonly defaultScoreScaleMax: number;
}

export interface EvalPolicy {
  /** The kill switch. False refuses every judging and enqueueing path. */
  readonly enabled: boolean;
  readonly defaultJudgeModel: string;
  /** Normalised percentage at or above which an unopinionated judge passes. */
  readonly passMarkPercent: number;
  /** `AgentEval.rawResponse` is truncated to this so one judge cannot fill a page. */
  readonly maxRawResponseLength: number;
  readonly maxPageSize: number;
  readonly defaultPageSize: number;
  readonly minWindowDays: number;
  readonly defaultWindowDays: number;
  readonly maxWindowDays: number;
}

export interface GoldenSetPolicy {
  readonly maxNameLength: number;
  readonly maxThreads: number;
  readonly maxCriteria: number;
  /** Ceiling on `threads * criteria` — the number of judge calls a run makes. */
  readonly maxPairs: number;
}

export interface RegressionPolicy {
  /** Points of mean score below baseline that count as a regression. */
  readonly thresholdPoints: number;
  /** How far back a baseline's samples are read from. */
  readonly baselineWindowDays: number;
}

export interface RiskPolicy {
  readonly piiWeight: number;
  readonly injectionWeight: number;
  readonly toolErrorWeight: number;
  readonly approvalWeight: number;
  /** Risk at or above this is `high`; at or above `mediumBand` is `medium`. */
  readonly highBand: number;
  readonly mediumBand: number;
  readonly minWindowDays: number;
  readonly defaultWindowDays: number;
  readonly maxWindowDays: number;
}

export interface GovernancePolicy {
  readonly safety: SafetyPolicy;
  readonly ratings: RatingPolicy;
  readonly criteria: CriterionPolicy;
  readonly evals: EvalPolicy;
  readonly goldenSets: GoldenSetPolicy;
  readonly regression: RegressionPolicy;
  readonly risk: RiskPolicy;
}

/**
 * `EvalCriterion.scoreScaleMax`'s SCHEMA default, which the service never uses.
 *
 * Nothing in this package reads it: it exists so the two numbers can be compared
 * in one place.
 */
export const COLUMN_SCORE_SCALE_MAX = 1;

export const DEFAULT_GOVERNANCE_POLICY: GovernancePolicy = Object.freeze({
  safety: Object.freeze({
    maxDetailLength: 4_000,
    maxPageSize: 200,
    defaultPageSize: 50,
    minWindowDays: 1,
    defaultWindowDays: 30,
    maxWindowDays: 365,
  }),
  ratings: Object.freeze({
    maxCommentLength: 2_000,
    minWindowDays: 1,
    defaultWindowDays: 30,
    maxWindowDays: 365,
  }),
  criteria: Object.freeze({
    maxNameLength: 200,
    maxPromptLength: 20_000,
    maxRubricLength: 20_000,
    maxPageSize: 200,
    defaultPageSize: 50,
    defaultScoreScaleMin: 0,
    defaultScoreScaleMax: 100,
  }),
  evals: Object.freeze({
    enabled: true,
    defaultJudgeModel: "anthropic:claude-haiku-4-5-20251001",
    passMarkPercent: 50,
    maxRawResponseLength: 20_000,
    maxPageSize: 200,
    defaultPageSize: 50,
    minWindowDays: 1,
    defaultWindowDays: 30,
    maxWindowDays: 365,
  }),
  goldenSets: Object.freeze({
    maxNameLength: 200,
    maxThreads: 100,
    maxCriteria: 20,
    maxPairs: 500,
  }),
  regression: Object.freeze({
    thresholdPoints: 5,
    baselineWindowDays: 30,
  }),
  risk: Object.freeze({
    piiWeight: 0.4,
    injectionWeight: 0.3,
    toolErrorWeight: 0.2,
    approvalWeight: 0.1,
    highBand: 50,
    mediumBand: 20,
    minWindowDays: 1,
    defaultWindowDays: 7,
    maxWindowDays: 90,
  }),
});
