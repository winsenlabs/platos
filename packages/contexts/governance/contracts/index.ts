// The published surface of the `governance` context.
//
// ADR M0.3 §2: another context may import THIS entrypoint and nothing else —
// never `domain/`, never `application/`, never an adapter. No context is
// permitted to reach it by the §1 DAG at all: `governance` is a DAG SINK,
// depended on by nobody and reached only through the composition root, which is
// exactly what the `auth -> monitoring` inversion bought. The two ways in are
// therefore both kernel ports — `safetyEventSink()` for the enforcement layer
// and `erasureTarget()` for `privacy` — plus this contract for the transports.
//
// IT CARRIES NO IMPLEMENTATION. Everything here is either a type or a frozen
// vocabulary — the error codes, the three safety enumerations, the judge
// providers, the shipped policy and the event names. All of them come from
// `domain/`, which imports nothing but the kernel, so importing this module
// pulls in a handful of arrays and cannot drag a use case, a port or a peer
// context's contract across a boundary with it. The implementation is
// `createGovernanceContract` in `application/`, and it is reached only through
// the composition root.
//
// The ten driven ports are NOT re-exported here. They are adapter-facing, not
// context-facing, and they are published from `application/ports/index.js` where
// their adapters import them (ADR M0.3 §13).
//
// THE FIVE ROWS ARE PUBLISHED AS THEMSELVES, NOT AS VIEWS. `SafetyEvent`,
// `MessageRating`, `EvalCriterion`, `AgentEval` and `GoldenSet` are flat,
// immutable records in which every field is a column this context owns; there is
// no envelope to strip and no other context's rows joined onto them. A mapping
// layer over that would be a place for a field to be silently dropped — the
// defect `agents` names on `AgentConfigurationView` — in exchange for nothing.
// Where a rollup IS a different shape from a row, it has its own type.
//
// WHAT THIS SURFACE DELIBERATELY WITHHOLDS.
//
//   * NO CENTRAL COST WRITE. `runJudge` prices the judge call and stores the
//     number on `AgentEval.costCents`, and `governance.eval.scored` carries it.
//     It does NOT write the spend ledger: `Budget` and the cost tables are
//     `cost-monitoring`'s rows (§1 row 13), which this context is neither the
//     writer of nor permitted to import. The extraction source calls
//     `CostService.recordAuxiliaryCost` from inside the eval path; that edge is
//     replaced by the event, and picking it up is the fan-out's job.
//
//   * NO BUDGET ROLLUP ON THE RISK BOARD. The source's governance dashboard
//     returns budget statuses beside the detector timeline, fanning out per
//     active user through two more services. Budgets are `cost-monitoring`'s
//     (§1 row 13). A surface that wants both asks both contexts and joins them
//     where a join is allowed: at the transport.
//
//   * NO RUN GROUPING COLUMN. The canonical `AgentEval` model has none, and the
//     source refuses rather than claim a grouping it cannot persist. That
//     refusal is kept: `enqueueEvalRun` answers a queue handle, and
//     `reportRegression` takes the SET OF EVAL IDS a run produced.
//
//   * NO END-USER AUTHENTICATION. A rating is an end user's, and
//     `identity-access` is not on this context's §1 row 14 allow-list, so the
//     end-user identity on a rating command is an assertion made by the
//     transport that authenticated the session. What this context checks is that
//     the asserted user OWNS the turn. `application/authorization.ts` states the
//     limit rather than hiding it.
//
// AND ONE AUTHORIZATION FACT WORTH READING TWICE. Every operator operation here
// is `metadata`-level, tenancy's default read/administer tier, so the grant that
// lets an operator READ this environment's safety ledger also lets them REWRITE
// its eval criteria. That is the running system's behaviour and it is recorded
// so a later decision to separate the two is deliberate.

import type { ErasureTarget, Result, SafetyEventSink } from "@platos/kernel";

// The identifier vocabulary a caller needs to build a command. Branded types, so
// a `TurnId` cannot reach a `ThreadId` parameter across the boundary any more
// than it can inside it.
export type {
  ActorId,
  AgentEvalId,
  AgentId,
  AgentVersionId,
  EndUserId,
  EvalCriterionId,
  EvalRunId,
  GoldenSetId,
  MessageRatingId,
  SafetyEventId,
  ThreadId,
  TurnId,
} from "../domain/index.js";

// The five owned rows, and the vocabularies they are written in.
export type {
  AgentEval,
  EvalCriterion,
  GoldenSet,
  MessageRating,
  RatingValue,
  SafetyAction,
  SafetyDetector,
  SafetyEvent,
  SafetyEventDraft,
  SafetySeverity,
} from "../domain/index.js";

export {
  GOVERNANCE_ERROR_CODES,
  GOVERNANCE_EVENT_NAMES,
  SAFETY_ACTIONS,
  SAFETY_DETECTORS,
  SAFETY_SEVERITIES,
  JUDGE_PROVIDERS,
  DEFAULT_GOVERNANCE_POLICY,
  COLUMN_SCORE_SCALE_MAX,
} from "../domain/index.js";

export type { GovernanceErrorCode, GovernanceEventName } from "../domain/index.js";

// Policy, published so the composition root can change a ceiling or throw the
// eval kill switch without reaching into this package for the shape of one.
export type {
  CriterionPolicy,
  EvalPolicy,
  GoldenSetPolicy,
  GovernancePolicy,
  RatingPolicy,
  RegressionPolicy,
  RiskPolicy,
  SafetyPolicy,
} from "../domain/index.js";

// The rollups, which are genuinely a different shape from a row.
export type {
  AgentRisk,
  AgentSatisfaction,
  CriterionComparison,
  CriterionDraft,
  CriterionPatch,
  CriterionSnapshot,
  EvalAggregateRow,
  EvalPair,
  GoldenSetDraft,
  GoldenSetPatch,
  JudgeVerdict,
  RatingTally,
  RegressionReport,
  RegressionVerdict,
  RiskBand,
  SafetySummary,
  VersionSatisfaction,
} from "../domain/index.js";

// Commands and queries, from the use cases that define them.
export type { RatingActor } from "../application/authorization.js";
export type { RecordSafetyEventCommand } from "../application/record-safety-event.js";
export type {
  DescribeSafetyEventQuery,
  PageSafetyEventsQuery,
  SafetyEventPageResult,
  SafetySummaryResult,
  SummariseSafetyQuery,
} from "../application/read-safety.js";
export type {
  RateTurnCommand,
  ReadTurnRatingQuery,
  TurnRatingResult,
  WithdrawRatingCommand,
} from "../application/rate-turn.js";
export type {
  AgentSatisfactionResult,
  SatisfactionQuery,
  VersionSatisfactionQuery,
  VersionSatisfactionResult,
} from "../application/read-ratings.js";
export type {
  CreateCriterionCommand,
  CriterionPageResult,
  DescribeCriterionQuery,
  PageCriteriaQuery,
  UpdateCriterionCommand,
} from "../application/criteria.js";
export type { RunJudgeCommand } from "../application/run-judge.js";
export type {
  AggregateEvalsQuery,
  DescribeEvalQuery,
  EvalAggregateResult,
  EvalPageResult,
  PageEvalsQuery,
} from "../application/read-evals.js";
export type {
  CreateGoldenSetCommand,
  DescribeGoldenSetQuery,
  GoldenSetPageResult,
  PageGoldenSetsQuery,
  UpdateGoldenSetCommand,
} from "../application/golden-sets.js";
export type { EnqueueEvalRunCommand, EvalRunPlanned } from "../application/enqueue-eval-run.js";
export type { RegressionReportQuery } from "../application/regression-report.js";
export type { RiskBoardQuery, RiskBoardResult } from "../application/risk-report.js";
export type { GovernanceDependencies } from "../application/dependencies.js";

import type {
  AgentEval,
  EvalCriterion,
  GoldenSet,
  MessageRating,
  RegressionReport,
  SafetyEvent,
} from "../domain/index.js";
import type {
  DescribeSafetyEventQuery,
  PageSafetyEventsQuery,
  SafetyEventPageResult,
  SafetySummaryResult,
  SummariseSafetyQuery,
} from "../application/read-safety.js";
import type { RecordSafetyEventCommand } from "../application/record-safety-event.js";
import type {
  RateTurnCommand,
  ReadTurnRatingQuery,
  TurnRatingResult,
  WithdrawRatingCommand,
} from "../application/rate-turn.js";
import type {
  AgentSatisfactionResult,
  SatisfactionQuery,
  VersionSatisfactionQuery,
  VersionSatisfactionResult,
} from "../application/read-ratings.js";
import type {
  CreateCriterionCommand,
  CriterionPageResult,
  DescribeCriterionQuery,
  PageCriteriaQuery,
  UpdateCriterionCommand,
} from "../application/criteria.js";
import type { RunJudgeCommand } from "../application/run-judge.js";
import type {
  AggregateEvalsQuery,
  DescribeEvalQuery,
  EvalAggregateResult,
  EvalPageResult,
  PageEvalsQuery,
} from "../application/read-evals.js";
import type {
  CreateGoldenSetCommand,
  DescribeGoldenSetQuery,
  GoldenSetPageResult,
  PageGoldenSetsQuery,
  UpdateGoldenSetCommand,
} from "../application/golden-sets.js";
import type { EnqueueEvalRunCommand, EvalRunPlanned } from "../application/enqueue-eval-run.js";
import type { RegressionReportQuery } from "../application/regression-report.js";
import type { RiskBoardQuery, RiskBoardResult } from "../application/risk-report.js";

/**
 * The `governance` capability, as the composition root sees it.
 *
 * Every method returns the kernel's `Result`: a failure a caller must handle is
 * visible in the type, and no store or vendor exception crosses this boundary.
 */
export interface GovernanceContract {
  readonly name: "governance";

  // ---- the safety ledger -------------------------------------------------
  /** Append one event through an operator grant. */
  recordSafetyEvent(command: RecordSafetyEventCommand): Promise<Result<SafetyEvent>>;
  pageSafetyEvents(query: PageSafetyEventsQuery): Promise<Result<SafetyEventPageResult>>;
  describeSafetyEvent(query: DescribeSafetyEventQuery): Promise<Result<SafetyEvent | null>>;
  /** Declared histograms: every bucket present, at zero when nothing hit it. */
  summariseSafety(query: SummariseSafetyQuery): Promise<Result<SafetySummaryResult>>;

  /**
   * This context's `SafetyEventSink`, for the composition root to hand to the
   * enforcement layer (ADR M0.3 §3). It never throws and never fails a caller's
   * decision; a dropped observation is logged, not raised.
   */
  safetyEventSink(): SafetyEventSink;

  // ---- ratings -----------------------------------------------------------
  /** An END USER's thumb. An operator actor is refused. */
  rateTurn(command: RateTurnCommand): Promise<Result<MessageRating>>;
  /** Idempotent. Withdrawing nothing answers false, not an error. */
  withdrawRating(command: WithdrawRatingCommand): Promise<Result<boolean>>;
  readTurnRating(query: ReadTurnRatingQuery): Promise<Result<TurnRatingResult>>;
  /** The canary axis. Version labels come from `agents`; absent ones are null. */
  readVersionSatisfaction(query: VersionSatisfactionQuery): Promise<Result<VersionSatisfactionResult>>;
  /** The scorecard axis, in one pass over the environment. */
  readAgentSatisfaction(query: SatisfactionQuery): Promise<Result<AgentSatisfactionResult>>;

  // ---- criteria ----------------------------------------------------------
  createCriterion(command: CreateCriterionCommand): Promise<Result<EvalCriterion>>;
  /** Re-admits the MERGED criterion, so a half-patched scale cannot be stored. */
  updateCriterion(command: UpdateCriterionCommand): Promise<Result<EvalCriterion>>;
  removeCriterion(query: DescribeCriterionQuery): Promise<Result<boolean>>;
  describeCriterion(query: DescribeCriterionQuery): Promise<Result<EvalCriterion>>;
  pageCriteria(query: PageCriteriaQuery): Promise<Result<CriterionPageResult>>;

  // ---- evals -------------------------------------------------------------
  /**
   * Score one conversation against one criterion, now.
   *
   * Refused when judging is disabled, when the criterion is inactive, and when
   * the judge resolves to the same model that produced the conversation.
   */
  runJudge(command: RunJudgeCommand): Promise<Result<AgentEval>>;
  pageEvals(query: PageEvalsQuery): Promise<Result<EvalPageResult>>;
  describeEval(query: DescribeEvalQuery): Promise<Result<AgentEval>>;
  aggregateAgentEvals(query: AggregateEvalsQuery): Promise<Result<EvalAggregateResult>>;

  // ---- golden sets and runs ----------------------------------------------
  createGoldenSet(command: CreateGoldenSetCommand): Promise<Result<GoldenSet>>;
  updateGoldenSet(command: UpdateGoldenSetCommand): Promise<Result<GoldenSet>>;
  removeGoldenSet(query: DescribeGoldenSetQuery): Promise<Result<boolean>>;
  describeGoldenSet(query: DescribeGoldenSetQuery): Promise<Result<GoldenSet>>;
  pageGoldenSets(query: PageGoldenSetsQuery): Promise<Result<GoldenSetPageResult>>;
  /**
   * Plan a run and hand it to the durable seam. Answers the PLAN and a handle,
   * never the scores: the fan-out does not happen inside the request.
   */
  enqueueEvalRun(command: EnqueueEvalRunCommand): Promise<Result<EvalRunPlanned>>;
  /** A report that is not `complete` has NOT cleared the version. */
  reportRegression(query: RegressionReportQuery): Promise<Result<RegressionReport>>;

  // ---- the risk board ----------------------------------------------------
  /** One number per agent. `complete` is false when the denominators are guessed. */
  readRiskBoard(query: RiskBoardQuery): Promise<Result<RiskBoardResult>>;

  /**
   * This context's `ErasureTarget` for the rows it is sole writer of. The
   * composition root collects one of these per context and injects the array
   * into `privacy` (ADR M0.3 §3). All five owned models are named on every plan;
   * see `application/governance-erasure-target.ts` for the method chosen per
   * model and why three of them are always zero.
   */
  erasureTarget(): ErasureTarget;
}

/**
 * Retained from the generated skeleton so no sibling placeholder breaks. The
 * "aggregate" this context hands out is one safety event — the row it exists to
 * be the sole writer of.
 */
export type GovernanceAggregate = SafetyEvent;
