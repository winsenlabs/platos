// Rolling evals up per (criterion, version).
//
// The canary question — "did v7 score better than v6 on groundedness?" — is one
// fold over rows the repository already scoped. It is pure, so the arithmetic
// that a release decision rests on is exercisable without a store.
//
// THE GROUPING KEY IS A PAIR, NOT A STRING. The source builds
// `` `${criterionId}::${agentVersionId ?? "null"}` `` and later splits it back on
// `"::"`, which makes two assumptions it never checks: that no identifier
// contains the separator, and that no version id is spelled `null`. Both hold
// for uuids today and neither is a property of the code. Here the buckets are
// keyed by a nested map, so a version id spelled `"null"` and an absent version
// are two buckets rather than one, and no identifier can ever be split apart.
//
// A DELETED CRITERION KEEPS ITS SCORES. The source labels such a bucket
// "(deleted criterion)" from a left-join that returned no name. That label is
// kept — an aggregate that dropped the rows would silently improve the average
// every time an operator tidied up — but it is a NULL name here and the fallback
// text is the reader's to choose, because a display string baked into a domain
// rollup ends up in a database export.

import type { AgentVersionId, EvalCriterionId } from "./identifiers.js";

/** One eval, reduced to the four fields a rollup counts. */
export interface EvalAggregateInput {
  readonly criterionId: EvalCriterionId;
  readonly agentVersionId: AgentVersionId | null;
  readonly score: number;
  readonly passed: boolean;
}

export interface EvalAggregateRow {
  readonly criterionId: EvalCriterionId;
  /** Null when the criterion has since been deleted. Never a display string. */
  readonly criterionName: string | null;
  readonly agentVersionId: AgentVersionId | null;
  readonly versionNumber: number | null;
  readonly sampleCount: number;
  /** Mean of the normalised 0..100 scores, rounded to two places for display. */
  readonly meanScore: number;
  /** Unrounded mean. Comparisons are taken on this; see `regression.ts`. */
  readonly meanScoreExact: number;
  readonly passRate: number;
}

export interface AggregateNames {
  readonly criterionNames: ReadonlyMap<string, string>;
  readonly versionNumbers: ReadonlyMap<string, number>;
}

/** Mean of a non-empty list. Zero for an empty one; callers never build one. */
export function meanOf(scores: readonly number[]): number {
  if (scores.length === 0) return 0;
  let total = 0;
  for (const score of scores) total += score;
  return total / scores.length;
}

export function roundToTwo(value: number): number {
  return Math.round(value * 100) / 100;
}

export function aggregateEvals(
  rows: readonly EvalAggregateInput[],
  names: AggregateNames,
): readonly EvalAggregateRow[] {
  const byCriterion = new Map<string, Map<string | null, EvalAggregateInput[]>>();
  for (const row of rows) {
    let versions = byCriterion.get(row.criterionId);
    if (versions === undefined) {
      versions = new Map();
      byCriterion.set(row.criterionId, versions);
    }
    const key = row.agentVersionId ?? null;
    const bucket = versions.get(key);
    if (bucket === undefined) versions.set(key, [row]);
    else bucket.push(row);
  }

  const out: EvalAggregateRow[] = [];
  for (const [criterionId, versions] of byCriterion) {
    for (const [agentVersionId, bucket] of versions) {
      const scores = bucket.map((row) => row.score);
      const exact = meanOf(scores);
      const passes = bucket.filter((row) => row.passed).length;
      out.push({
        criterionId: criterionId as EvalCriterionId,
        criterionName: names.criterionNames.get(criterionId) ?? null,
        agentVersionId: agentVersionId as AgentVersionId | null,
        versionNumber: agentVersionId === null ? null : names.versionNumbers.get(agentVersionId) ?? null,
        sampleCount: bucket.length,
        meanScore: roundToTwo(exact),
        meanScoreExact: exact,
        passRate: bucket.length === 0 ? 0 : passes / bucket.length,
      });
    }
  }
  return out.sort(byCriterionThenVersion);
}

/**
 * Named criteria first, alphabetically; then the unnamed; newest version first.
 *
 * The source sorts on the display string, which puts every deleted criterion
 * together under the same literal. Sorting on the id for unnamed rows keeps that
 * grouping stable without letting a fallback label decide an order.
 */
function byCriterionThenVersion(left: EvalAggregateRow, right: EvalAggregateRow): number {
  if (left.criterionName !== null && right.criterionName === null) return -1;
  if (left.criterionName === null && right.criterionName !== null) return 1;
  const leftKey = left.criterionName ?? left.criterionId;
  const rightKey = right.criterionName ?? right.criterionId;
  if (leftKey !== rightKey) return leftKey.localeCompare(rightKey);
  return (right.versionNumber ?? 0) - (left.versionNumber ?? 0);
}
