// Use case: compare one run's scores against a baseline version.
//
// The run is identified by the SET OF EVAL IDS it produced, because the
// canonical `AgentEval` model carries no run column and this context does not
// pretend otherwise — see `domain/identifiers.ts`. The runner that carried out
// the queued fan-out reports the ids it wrote; this use case turns them into a
// verdict.
//
// THE EXPECTED CRITERIA COME FROM THE SET, NOT FROM THE RESULTS. That is what
// makes `no-candidate` reachable and what stops a run in which every judge call
// failed from reporting a clean pass. `domain/regression.ts` records why the
// source cannot report that at all.

import { err, ok, type Result } from "@platos/kernel";

import {
  compareToBaseline,
  goldenSetNotFound,
  windowFrom,
  type AgentEvalId,
  type AgentVersionId,
  type EvalCriterionId,
  type GoldenSetId,
  type RegressionReport,
} from "../domain/index.js";
import { verifyOperator } from "./authorization.js";
import type { GovernanceDependencies } from "./dependencies.js";

export interface RegressionReportQuery {
  readonly authorization: unknown;
  readonly goldenSetId: GoldenSetId;
  /** The ids the run wrote. Empty is a legitimate input: every pair failed. */
  readonly evalIds: readonly AgentEvalId[];
  readonly baselineVersionId?: AgentVersionId | null;
}

export async function reportRegression(
  dependencies: GovernanceDependencies,
  query: RegressionReportQuery,
): Promise<Result<RegressionReport>> {
  const grant = verifyOperator(dependencies, query.authorization);
  if (!grant.ok) return err(grant.error);
  const scope = grant.value.scope;

  const set = await dependencies.goldenSets.findById(scope, query.goldenSetId);
  if (!set.ok) return err(set.error);
  if (set.value === null) return err(goldenSetNotFound(query.goldenSetId));

  const candidate = await dependencies.evals.sampleByIds(scope, query.evalIds);
  if (!candidate.ok) return err(candidate.error);

  const baselineVersionId = query.baselineVersionId ?? null;
  let baseline: readonly { readonly criterionId: EvalCriterionId; readonly score: number }[] = [];
  if (baselineVersionId !== null) {
    const window = windowFrom(dependencies.clock.now(), dependencies.policy.regression.baselineWindowDays, {
      minWindowDays: dependencies.policy.evals.minWindowDays,
      defaultWindowDays: dependencies.policy.regression.baselineWindowDays,
      maxWindowDays: dependencies.policy.evals.maxWindowDays,
    });
    const sampled = await dependencies.evals.sampleBaseline(scope, {
      agentId: set.value.agentId,
      agentVersionId: baselineVersionId,
      since: window.since,
    });
    if (!sampled.ok) return err(sampled.error);
    baseline = sampled.value;
  }

  const named = await dependencies.criteria.findMany(scope, set.value.criterionIds);
  const criterionNames = new Map<string, string>();
  if (named.ok) {
    for (const criterion of named.value) criterionNames.set(criterion.evalCriterionId, criterion.name);
  }

  return ok(
    compareToBaseline({
      candidate: candidate.value,
      baseline,
      expectedCriterionIds: set.value.criterionIds,
      criterionNames,
      baselineVersionId,
      thresholdPoints: dependencies.policy.regression.thresholdPoints,
    }),
  );
}
