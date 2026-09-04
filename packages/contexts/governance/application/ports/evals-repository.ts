// The `EvalsRepository` port — the AgentEval table, seen as an interface.
//
// ADR M0.3 §1 row 14 makes this context the SOLE WRITER of `AgentEval`.
//
// THERE IS NO UPDATE AND NO DELETE, AND THAT IS THE MODEL RATHER THAN AN
// OMISSION. An eval is a measurement: it carries the criterion it was taken
// against as a frozen snapshot precisely so that editing the criterion cannot
// move it, and a measurement that can be edited afterwards is not evidence. The
// rows do go — the schema cascades them from their `Thread` — but that deletion
// belongs to the context that owns the thread, which is why the erasure target
// here reports `AgentEval` as a zero-count item rather than claiming a deletion
// it does not perform.
//
// THE RUN GROUPING IS NOT A COLUMN. `sampleByIds` exists because a golden-set
// run identifies its own output by the SET of ids it wrote — the canonical model
// has no run column and this context does not pretend otherwise.

import type { EnvironmentScope, Result, TransactionScope } from "@platos/kernel";

import type {
  AdmittedEval,
  AgentEval,
  AgentEvalId,
  AgentId,
  AgentVersionId,
  EvalAggregateInput,
  EvalCriterionId,
  RegressionSample,
  ThreadId,
} from "../../domain/index.js";

export interface EvalQuery {
  readonly since: Date;
  readonly limit: number;
  readonly offset: number;
  readonly agentId: AgentId | null;
  readonly agentVersionId: AgentVersionId | null;
  readonly criterionId: EvalCriterionId | null;
  readonly threadId: ThreadId | null;
  /** Case-insensitive substring over the rationale and the judge model. */
  readonly search: string | null;
}

export interface EvalPage {
  readonly items: readonly AgentEval[];
  readonly total: number;
}

export interface EvalSampleQuery {
  readonly agentId: AgentId;
  readonly since: Date;
  /** Empty means every version. */
  readonly versionIds: readonly AgentVersionId[];
}

export interface BaselineSampleQuery {
  readonly agentId: AgentId;
  readonly agentVersionId: AgentVersionId;
  readonly since: Date;
}

export interface EvalsRepository {
  /** Append one measurement. The only write. */
  append(
    scope: EnvironmentScope,
    admitted: AdmittedEval,
    transaction: TransactionScope | null,
  ): Promise<Result<AgentEval>>;

  findById(scope: EnvironmentScope, evalId: AgentEvalId): Promise<Result<AgentEval | null>>;

  page(scope: EnvironmentScope, query: EvalQuery): Promise<Result<EvalPage>>;

  /** Rows an aggregate folds. Already scoped and windowed. */
  sample(scope: EnvironmentScope, query: EvalSampleQuery): Promise<Result<readonly EvalAggregateInput[]>>;

  /** The scores a specific run produced, addressed by the ids it wrote. */
  sampleByIds(
    scope: EnvironmentScope,
    evalIds: readonly AgentEvalId[],
  ): Promise<Result<readonly RegressionSample[]>>;

  /** The baseline version's scores inside the comparison window. */
  sampleBaseline(
    scope: EnvironmentScope,
    query: BaselineSampleQuery,
  ): Promise<Result<readonly RegressionSample[]>>;
}
