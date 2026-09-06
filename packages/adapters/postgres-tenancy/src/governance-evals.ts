// The `EvalsRepository` — `governance`'s `AgentEval` half.
//
// ONE WRITE AND NO OTHERS. There is no UPDATE and no DELETE in this file,
// because the port has neither: an eval is a measurement, it carries the
// criterion it was taken against as a frozen snapshot precisely so that editing
// the criterion cannot move it, and a measurement that can be edited afterwards
// is not evidence. The rows DO go — `AgentEval.thread @relation(onDelete:
// Cascade)` and `AgentEval.criterion @relation(onDelete: Cascade)` take them —
// but neither deletion is issued here, which is what makes this context's
// erasure target honest when it reports `AgentEval` as a zero-count item.
//
// *** ONE FIELD OF THE PORT'S ROW HAS NO COLUMN, AND IT IS REPORTED ***
// `AgentEval.rawResponseTruncated` is declared "on the ROW, not only on the
// admitted draft", so a reader can tell "the judge said this" from "the judge
// said this and more". The canonical model has no column for it, and there is no
// metadata column to carry one in: `criterionSnapshot` is the FROZEN CRITERION
// and has a fixed seven-field shape, so widening it would corrupt the one field
// an audit of a historical score turns on.
//
// `append` therefore ECHOES the flag it was handed — the writer's own knowledge
// of the truncation it performed, not a value invented here — and every READ of
// the same row afterwards answers `false`, because nothing in the database
// remembers. That asymmetry is pinned as a named case in
// `governance-constraints.integration.test.ts` rather than smoothed over, and it
// is reported: the honest repair is a column, which expand/contract puts in an
// ordered migration and not in this tranche.
//
// `Decimal(18, 6)` AND `Float` ARE BOTH GUARDED, FOR OPPOSITE REASONS.
// `costCents` is a decimal that ROUNDS a longer fraction rather than refusing
// it, so a cost written and read back would silently differ; `score` is a double
// that ACCEPTS `NaN`, so one bad verdict would turn every mean taken over the
// column afterwards into `NaN` with no error anywhere. Both are refused before
// the statement is sent.

import type {
  AdmittedEval,
  AgentEval,
  AgentEvalId,
  BaselineSampleQuery,
  EnvironmentScope,
  EvalAggregateInput,
  EvalPage,
  EvalQuery,
  EvalSampleQuery,
  EvalsRepository,
  RegressionSample,
  Result,
  TransactionScope,
} from "@platos/context-governance/application/ports/index.js";
import {
  asGovernanceIdentifier,
  err,
  ledgerUnavailable,
  ok,
  type AgentVersionId,
  type EvalCriterionId,
} from "@platos/context-governance/application/ports/index.js";

import { guardEvalAppend } from "./governance-guards.js";
import { refuse } from "./governance-refusal.js";
import {
  readEval,
  scopedWhere,
  writeCriterionSnapshot,
  type AgentEvalRow,
} from "./governance-rows.js";
import type { TenancyTransactions } from "./transaction.js";

const EVAL_COLUMNS = {
  id: true,
  environmentId: true,
  agentId: true,
  agentVersionId: true,
  threadId: true,
  turnId: true,
  criterionId: true,
  criterionSnapshot: true,
  judgeModel: true,
  judgePromptUsed: true,
  rawResponse: true,
  score: true,
  rationale: true,
  passed: true,
  costCents: true,
  latencyMs: true,
  createdAt: true,
} as const;

/** The four fields an aggregate counts. Nothing wider is read on that path. */
const AGGREGATE_COLUMNS = {
  criterionId: true,
  agentVersionId: true,
  score: true,
  passed: true,
} as const;

/** The two fields a regression comparison reads. */
const REGRESSION_COLUMNS = { criterionId: true, score: true } as const;

function toRegressionSample(row: {
  readonly criterionId: string;
  readonly score: number;
}): RegressionSample {
  return { criterionId: asGovernanceIdentifier<EvalCriterionId>(row.criterionId), score: row.score };
}

export function createEvalsRepository(
  transactions: TenancyTransactions,
  now: () => Date,
): EvalsRepository {
  return {
    async append(
      scope: EnvironmentScope,
      admitted: AdmittedEval,
      transaction: TransactionScope | null,
    ): Promise<Result<AgentEval>> {
      return refuse(async () => {
        guardEvalAppend(admitted);
        // A null scope resolves through `reader()`, so an append issued inside
        // an open transaction joins it rather than escaping to the pool — the
        // same argument `governance-safety.ts` makes for the same nullable
        // parameter.
        const client = transaction === null ? transactions.reader() : transactions.writer(transaction);
        const written = await client.agentEval.createManyAndReturn({
          data: [
            {
              environmentId: scope.environmentId,
              agentId: admitted.agentId,
              agentVersionId: admitted.agentVersionId,
              threadId: admitted.threadId,
              turnId: admitted.turnId,
              criterionId: admitted.criterionId,
              criterionSnapshot: writeCriterionSnapshot(admitted.criterionSnapshot),
              judgeModel: admitted.judgeModel,
              judgePromptUsed: admitted.judgePromptUsed,
              rawResponse: admitted.rawResponse,
              score: admitted.score,
              rationale: admitted.rationale,
              passed: admitted.passed,
              costCents: admitted.costCents,
              latencyMs: admitted.latencyMs,
              createdAt: now(),
            },
          ],
          select: EVAL_COLUMNS,
        });
        const row = written[0];
        if (row === undefined) return err(ledgerUnavailable("eval append wrote no row"));
        // The ONLY place `rawResponseTruncated` is answered truthfully: the
        // writer knows what it truncated, and the row it just wrote does not.
        return ok({ ...readEval(row as AgentEvalRow), rawResponseTruncated: admitted.rawResponseTruncated });
      }, "evals append");
    },

    async findById(scope: EnvironmentScope, evalId: AgentEvalId): Promise<Result<AgentEval | null>> {
      return refuse(async () => {
        const row = await transactions.reader().agentEval.findFirst({
          where: { id: evalId, ...scopedWhere(scope) },
          select: EVAL_COLUMNS,
        });
        return ok(row === null ? null : readEval(row as AgentEvalRow));
      }, "evals findById");
    },

    async page(scope: EnvironmentScope, query: EvalQuery): Promise<Result<EvalPage>> {
      return refuse(async () => {
        const where = {
          ...scopedWhere(scope),
          createdAt: { gte: query.since },
          ...(query.agentId === null ? {} : { agentId: query.agentId }),
          ...(query.agentVersionId === null ? {} : { agentVersionId: query.agentVersionId }),
          ...(query.criterionId === null ? {} : { criterionId: query.criterionId }),
          ...(query.threadId === null ? {} : { threadId: query.threadId }),
          // The port says the substring runs over the rationale AND the judge
          // model, so it is one OR rather than two filters: a search that
          // matched only the first would silently stop finding evals by the
          // model that produced them.
          ...(query.search === null
            ? {}
            : {
                OR: [
                  { rationale: { contains: query.search, mode: "insensitive" as const } },
                  { judgeModel: { contains: query.search, mode: "insensitive" as const } },
                ],
              }),
        };
        const reader = transactions.reader();
        const rows = await reader.agentEval.findMany({
          where,
          select: EVAL_COLUMNS,
          orderBy: [{ createdAt: "desc" }, { id: "desc" }],
          skip: query.offset,
          take: query.limit,
        });
        const total = await reader.agentEval.count({ where });
        return ok({ items: rows.map((row) => readEval(row as AgentEvalRow)), total });
      }, "evals page");
    },

    async sample(
      scope: EnvironmentScope,
      query: EvalSampleQuery,
    ): Promise<Result<readonly EvalAggregateInput[]>> {
      return refuse(async () => {
        const rows = await transactions.reader().agentEval.findMany({
          where: {
            ...scopedWhere(scope),
            agentId: query.agentId,
            createdAt: { gte: query.since },
            // EMPTY MEANS EVERY VERSION, which is the port's word and not a
            // convenience: an empty `IN ()` would match nothing and a scorecard
            // asked for "all versions" would read as an agent with no evals.
            ...(query.versionIds.length === 0
              ? {}
              : { agentVersionId: { in: [...query.versionIds] } }),
          },
          select: AGGREGATE_COLUMNS,
          orderBy: [{ createdAt: "asc" }, { id: "asc" }],
        });
        return ok(
          rows.map((row) => ({
            criterionId: asGovernanceIdentifier<EvalCriterionId>(row.criterionId),
            agentVersionId:
              row.agentVersionId === null
                ? null
                : asGovernanceIdentifier<AgentVersionId>(row.agentVersionId),
            score: row.score,
            passed: row.passed,
          })),
        );
      }, "evals sample");
    },

    async sampleByIds(
      scope: EnvironmentScope,
      evalIds: readonly AgentEvalId[],
    ): Promise<Result<readonly RegressionSample[]>> {
      return refuse(async () => {
        // The run grouping is NOT a column: a golden-set run identifies its own
        // output by the SET of ids it wrote. One statement for the whole set, so
        // a run of a thousand pairs is one read rather than a thousand.
        if (evalIds.length === 0) return ok([]);
        const rows = await transactions.reader().agentEval.findMany({
          where: { id: { in: [...evalIds] }, ...scopedWhere(scope) },
          select: REGRESSION_COLUMNS,
          orderBy: [{ createdAt: "asc" }, { id: "asc" }],
        });
        return ok(rows.map(toRegressionSample));
      }, "evals sampleByIds");
    },

    async sampleBaseline(
      scope: EnvironmentScope,
      query: BaselineSampleQuery,
    ): Promise<Result<readonly RegressionSample[]>> {
      return refuse(async () => {
        const rows = await transactions.reader().agentEval.findMany({
          where: {
            ...scopedWhere(scope),
            agentId: query.agentId,
            agentVersionId: query.agentVersionId,
            createdAt: { gte: query.since },
          },
          select: REGRESSION_COLUMNS,
          orderBy: [{ createdAt: "asc" }, { id: "asc" }],
        });
        return ok(rows.map(toRegressionSample));
      }, "evals sampleBaseline");
    },
  };
}
