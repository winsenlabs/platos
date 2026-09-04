// Satisfaction rollups — the same fold along two different axes.
//
// J.2 in the extraction source: group the current-state ratings by
// `agentVersionId` so a canary dashboard can plot satisfaction beside cost and
// latency, and by `agentId` so a scorecard can list every agent in one query.
// Both are pure folds over rows the repository already scoped, so neither can
// reach another tenant however it is called.
//
// RATINGS ARE ANONYMISED IN THE AGGREGATE, AND THAT IS STRUCTURAL HERE RATHER
// THAN A CONVENTION. The source's invariant is that no `userId` surfaces to a
// cross-user reader; it holds there because each mapper happens not to copy the
// field. Here the fold's INPUT type carries no subject at all, so an aggregate
// that leaked one would not compile.
//
// A SCORE OF ZERO IS NOT A SCORE. `score` is `ups / (ups + downs)`, which is
// undefined with no votes; the source answers 0, which renders identically to
// "everybody voted it down". The number is kept for compatibility and `total` is
// published beside it, so a surface can tell the two apart — and `discarded` is
// published too, so a row the fold could not read is visible rather than
// silently changing the denominator.

import type { AgentId, AgentVersionId } from "./identifiers.js";
import { tally } from "./rating.js";

/** One row, reduced to what a rollup may see. No subject, by construction. */
export interface SatisfactionInput {
  readonly agentId: AgentId;
  readonly agentVersionId: AgentVersionId | null;
  readonly rating: number;
}

export interface SatisfactionRow {
  readonly ups: number;
  readonly downs: number;
  readonly total: number;
  readonly discarded: number;
  /** `ups / total`, and 0 when `total` is 0. Read it beside `total`. */
  readonly score: number;
}

export interface VersionSatisfaction extends SatisfactionRow {
  readonly agentVersionId: AgentVersionId | null;
  /** Null when the version is unknown to `agents`, or when there is none. */
  readonly versionNumber: number | null;
}

export interface AgentSatisfaction extends SatisfactionRow {
  readonly agentId: AgentId;
}

function scored(counted: { ups: number; downs: number; discarded: number }): SatisfactionRow {
  const total = counted.ups + counted.downs;
  return {
    ups: counted.ups,
    downs: counted.downs,
    total,
    discarded: counted.discarded,
    score: total === 0 ? 0 : counted.ups / total,
  };
}

/**
 * Group by version.
 *
 * `versionNumbers` is supplied by the caller from the `agents` contract — this
 * context never reads an `AgentVersion` row. A version the map does not carry
 * reports `null` rather than being dropped, so a rollup over versions that have
 * since been pruned still accounts for every vote.
 */
export function satisfactionByVersion(
  rows: readonly SatisfactionInput[],
  versionNumbers: ReadonlyMap<string, number>,
): readonly VersionSatisfaction[] {
  const buckets = new Map<string | null, SatisfactionInput[]>();
  for (const row of rows) {
    const key = row.agentVersionId ?? null;
    const held = buckets.get(key);
    if (held === undefined) buckets.set(key, [row]);
    else held.push(row);
  }
  const out: VersionSatisfaction[] = [];
  for (const [agentVersionId, bucket] of buckets) {
    out.push({
      agentVersionId: agentVersionId as AgentVersionId | null,
      versionNumber: agentVersionId === null ? null : versionNumbers.get(agentVersionId) ?? null,
      ...scored(tally(bucket)),
    });
  }
  return out.sort(byVersionThenVolume);
}

/** Group by agent. The scorecard axis; one pass, no per-agent fan-out. */
export function satisfactionByAgent(rows: readonly SatisfactionInput[]): readonly AgentSatisfaction[] {
  const buckets = new Map<string, SatisfactionInput[]>();
  for (const row of rows) {
    const held = buckets.get(row.agentId);
    if (held === undefined) buckets.set(row.agentId, [row]);
    else held.push(row);
  }
  const out: AgentSatisfaction[] = [];
  for (const [agentId, bucket] of buckets) {
    out.push({ agentId: agentId as AgentId, ...scored(tally(bucket)) });
  }
  return out.sort((left, right) => left.agentId.localeCompare(right.agentId));
}

/** Newest version first; ties broken by the busier bucket. The source's order. */
function byVersionThenVolume(left: VersionSatisfaction, right: VersionSatisfaction): number {
  const leftNumber = left.versionNumber ?? 0;
  const rightNumber = right.versionNumber ?? 0;
  if (leftNumber !== rightNumber) return rightNumber - leftNumber;
  return right.total - left.total;
}
