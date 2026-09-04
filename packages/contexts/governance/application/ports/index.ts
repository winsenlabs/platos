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
