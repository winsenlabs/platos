// Use cases: read measurements.
//
// A page, one row, and the per-(criterion, version) rollup a canary decision is
// taken on. Every one takes its environment from the grant and its window from
// the injected clock.
//
// THE ROLLUP'S LABELS COME FROM TWO PLACES AND NEITHER IS A JOIN. Criterion
// names come from this context's own table, by id, in one lookup rather than a
// row-by-row left join; version numbers come from `agents`, which owns them.
// Both are bounded lookups, and a label neither can supply is null — a bucket
// with no name still carries its scores, because dropping it would improve the
// average every time an operator deleted a criterion.

import { err, ok, type Result } from "@platos/kernel";

import {
  admitPage,
  aggregateEvals,
  evalNotFound,
  windowFrom,
  type AgentEval,
  type AgentEvalId,
  type AgentId,
  type AgentVersionId,
  type EvalAggregateRow,
  type EvalCriterionId,
  type ThreadId,
} from "../domain/index.js";
import { verifyOperator } from "./authorization.js";
import type { GovernanceDependencies } from "./dependencies.js";
import { versionNumbers } from "./read-ratings.js";

export interface PageEvalsQuery {
  readonly authorization: unknown;
  readonly limit?: number | null;
  readonly offset?: number | null;
  readonly sinceDays?: number | null;
  readonly agentId?: AgentId | null;
  readonly agentVersionId?: AgentVersionId | null;
  readonly criterionId?: EvalCriterionId | null;
  readonly threadId?: ThreadId | null;
  readonly search?: string | null;
}

export interface EvalPageResult {
  readonly items: readonly AgentEval[];
  readonly total: number;
  readonly limit: number;
  readonly offset: number;
  readonly sinceDays: number;
}

export interface DescribeEvalQuery {
  readonly authorization: unknown;
  readonly evalId: AgentEvalId;
}

export interface AggregateEvalsQuery {
  readonly authorization: unknown;
  readonly agentId: AgentId;
  readonly sinceDays?: number | null;
  readonly versionIds?: readonly AgentVersionId[];
}

export interface EvalAggregateResult {
  readonly sinceDays: number;
  readonly rows: readonly EvalAggregateRow[];
}

export async function pageEvals(
  dependencies: GovernanceDependencies,
  query: PageEvalsQuery,
): Promise<Result<EvalPageResult>> {
  const grant = verifyOperator(dependencies, query.authorization);
  if (!grant.ok) return err(grant.error);
  const policy = dependencies.policy.evals;
  const page = admitPage({ limit: query.limit ?? null, offset: query.offset ?? null }, policy);
  if (!page.ok) return err(page.error);
  const window = windowFrom(dependencies.clock.now(), query.sinceDays ?? null, policy);

  const read = await dependencies.evals.page(grant.value.scope, {
    since: window.since,
    limit: page.value.limit,
    offset: page.value.offset,
    agentId: query.agentId ?? null,
    agentVersionId: query.agentVersionId ?? null,
    criterionId: query.criterionId ?? null,
    threadId: query.threadId ?? null,
    search: blankToNull(query.search ?? null),
  });
  if (!read.ok) return err(read.error);
  return ok({
    items: read.value.items,
    total: read.value.total,
    limit: page.value.limit,
    offset: page.value.offset,
    sinceDays: window.days,
  });
}

export async function describeEval(
  dependencies: GovernanceDependencies,
  query: DescribeEvalQuery,
): Promise<Result<AgentEval>> {
  const grant = verifyOperator(dependencies, query.authorization);
  if (!grant.ok) return err(grant.error);
  const found = await dependencies.evals.findById(grant.value.scope, query.evalId);
  if (!found.ok) return err(found.error);
  if (found.value === null) return err(evalNotFound(query.evalId));
  return ok(found.value);
}

export async function aggregateAgentEvals(
  dependencies: GovernanceDependencies,
  query: AggregateEvalsQuery,
): Promise<Result<EvalAggregateResult>> {
  const grant = verifyOperator(dependencies, query.authorization);
  if (!grant.ok) return err(grant.error);
  const window = windowFrom(dependencies.clock.now(), query.sinceDays ?? null, dependencies.policy.evals);
  const rows = await dependencies.evals.sample(grant.value.scope, {
    agentId: query.agentId,
    since: window.since,
    versionIds: query.versionIds ?? [],
  });
  if (!rows.ok) return err(rows.error);

  const criterionIds = [...new Set(rows.value.map((row) => row.criterionId))] as EvalCriterionId[];
  const named = await dependencies.criteria.findMany(grant.value.scope, criterionIds);
  const criterionNames = new Map<string, string>();
  if (named.ok) {
    for (const criterion of named.value) criterionNames.set(criterion.evalCriterionId, criterion.name);
  }
  const numbers = await versionNumbers(dependencies, query.authorization, query.agentId);

  return ok({
    sinceDays: window.days,
    rows: aggregateEvals(rows.value, { criterionNames, versionNumbers: numbers }),
  });
}

function blankToNull(value: string | null): string | null {
  if (value === null) return null;
  const trimmed = value.trim();
  return trimmed === "" ? null : trimmed;
}
