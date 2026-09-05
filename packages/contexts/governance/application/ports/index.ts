// Driven ports this context needs. Implemented by `packages/adapters/*`, wired
// in `apps/core-api`. Never imported by `domain/`.
//
// ADR M0.3 §13: these are ADAPTER-FACING, not context-facing, which is why they
// are published from here and NOT re-exported from `contracts/index.ts`. A peer
// context has no business holding this context's repository; its adapter has
// nothing else.
//
// TEN INTERFACES IN EIGHT MODULES, and the counts differ because `read-seams.ts`
// declares three. Five of the eight modules are stores — one per canonical row
// this context is sole writer of. The other three are not: `read-seams.ts`
// inverts the three questions whose answers belong to contexts the §1 DAG does
// not let this one import, `judge.ts` is the entire vendor surface of the eval
// pipeline, and `eval-run-queue.ts` is the durable seam a golden-set run is
// handed to.

export type {
  AgentDetectorCounts,
  SafetyEventPage,
  SafetyEventQuery,
  SafetyLedger,
  SafetySubjectSelector,
} from "./safety-ledger.js";

export type {
  RatingSampleQuery,
  RatingSubjectSelector,
  RatingWrite,
  RatingsRepository,
} from "./ratings-repository.js";

export type { CriteriaRepository, CriterionPage, CriterionQuery } from "./criteria-repository.js";

export type {
  BaselineSampleQuery,
  EvalPage,
  EvalQuery,
  EvalSampleQuery,
  EvalsRepository,
} from "./evals-repository.js";

export type { GoldenSetPage, GoldenSetQuery, GoldenSetsRepository } from "./golden-sets-repository.js";

export type {
  ActivityReader,
  AgentActivityCounts,
  RatingTarget,
  RatingTargetReader,
  Transcript,
  TranscriptReader,
} from "./read-seams.js";

export type { Judge, JudgeAnswer, JudgeRequest, JudgeUsage } from "./judge.js";

export type { EnqueuedEvalRun, EvalRunQueue, EvalRunRequest } from "./eval-run-queue.js";

// WIN-258 T5 — the domain values the five canonical-store ports' SIGNATURES
// already name.
//
// WITHOUT THIS BLOCK ALL FIVE ARE UNIMPLEMENTABLE OUTSIDE THIS PACKAGE. Each
// port module above imports its entities from `../../domain/index.js` as TYPES
// and re-exports none of them, and `contracts/index.ts` publishes the read VIEWS
// rather than the aggregates — so `SafetyLedger.append` was declared in terms of
// `AdmittedSafetyEvent`, a name an adapter package had no way to spell. The same
// omission was found on `EndUserStore`, on `SessionRevocationOrder` and on
// `cost-monitoring`'s whole aggregate set; this is the fourth, repaired the same
// way. The port entry point publishes exactly what the port's own signatures
// use, and nothing more.
//
// THE PREDICATES AND THE TWO DETECTOR LISTS ARE HERE FOR A STRONGER REASON.
// `detector`, `action` and `severity` are plain `String` COLUMNS: the closed set
// lives in `domain/safety-event.ts` and nowhere in the database. A row written
// by the legacy source — or by a future binary that learned a detector this one
// has not — is therefore readable as a string and unreadable as a
// `SafetyDetector`, and a store that CAST it would put a value outside the union
// into `summarise`, whose histogram is keyed by the union. The three predicates
// are what let the adapter refuse such a row by name instead. `PII_DETECTORS`
// and `INJECTION_DETECTORS` are published for the same reason `byListingOrder`
// is on the cost port: `countByAgent`'s contract IS those two memberships, and
// an adapter that re-listed them would be a second copy of a rule the risk score
// divides by.
//
// The kernel values these signatures name are republished for the reason
// `identity-access`'s and `cost-monitoring`'s port entry points republish
// theirs: `EnvironmentScope`, `TenantScope`, `TransactionScope` and `Result` are
// in every method above, and an adapter reaching for `@platos/kernel` directly
// would be a second import edge into the kernel from a package whose only
// declared dependency is the context whose ports it satisfies.
export type { EnvironmentScope, JsonValue, Result, TenantScope, TransactionScope } from "@platos/kernel";
export { asIdentifier, contains, environmentScope, err, ok } from "@platos/kernel";

export type {
  ActorId,
  AdmittedCriterion,
  AdmittedEval,
  AdmittedGoldenSet,
  AdmittedSafetyEvent,
  AgentEval,
  AgentEvalId,
  AgentId,
  AgentVersionId,
  CriterionSnapshot,
  EndUserId,
  EvalAggregateInput,
  EvalCriterion,
  EvalCriterionId,
  GoldenSet,
  GoldenSetId,
  MessageRating,
  MessageRatingId,
  RatingValue,
  RegressionSample,
  SafetyAction,
  SafetyDetector,
  SafetyEvent,
  SafetyEventId,
  SafetySeverity,
  SafetyTally,
  SatisfactionInput,
  ThreadId,
  TurnId,
} from "../../domain/index.js";
export {
  asGovernanceIdentifier,
  criterionAlreadyExists,
  goldenSetAlreadyExists,
  INJECTION_DETECTORS,
  isSafetyAction,
  isSafetyDetector,
  isSafetySeverity,
  ledgerUnavailable,
  PII_DETECTORS,
} from "../../domain/index.js";
