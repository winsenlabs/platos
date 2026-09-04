// Use cases: satisfaction rollups.
//
// Two axes over the same rows — by agent version, which is what a canary
// decision reads, and by agent, which is what a scorecard lists. Both fold rows
// the repository already scoped, and both fold a type that carries no subject,
// so an aggregate that leaked one would not compile.
//
// THE VERSION LABELS COME FROM `agents`, ONE PAGE AT A TIME. `MessageRating`
// stores an `agentVersionId` and nothing else about the version; turning that
// into "v7" needs `AgentVersion.versionNumber`, which `agents` owns (ADR M0.3 §1
// row 5). This context asks for the agent's version page and builds the map. A
// version the page does not carry — pruned, or beyond the page — reports a null
// number rather than being dropped, so every vote is still accounted for even
// when its label is not available.
//
// THE SOURCE READS EVERY VERSION AN AGENT HAS EVER HAD, unbounded, on every
// dashboard load, to label at most a handful of buckets. Here the label lookup
// is bounded by the same page ceiling as everything else, and a rollup over more
// distinct versions than one page holds degrades to unlabelled buckets instead
// of an unbounded query.

import { err, ok, type Result } from "@platos/kernel";

import {
  satisfactionByAgent,
  satisfactionByVersion,
  windowFrom,
  type AgentId,
  type AgentSatisfaction,
  type VersionSatisfaction,
} from "../domain/index.js";
import { verifyOperator } from "./authorization.js";
import type { GovernanceDependencies } from "./dependencies.js";

export interface SatisfactionQuery {
  readonly authorization: unknown;
  readonly sinceDays?: number | null;
}

export interface VersionSatisfactionQuery extends SatisfactionQuery {
  readonly agentId: AgentId;
}

export interface VersionSatisfactionResult {
  readonly sinceDays: number;
  readonly total: number;
  readonly rows: readonly VersionSatisfaction[];
}

export interface AgentSatisfactionResult {
  readonly sinceDays: number;
  readonly rows: readonly AgentSatisfaction[];
}

export async function readVersionSatisfaction(
  dependencies: GovernanceDependencies,
  query: VersionSatisfactionQuery,
): Promise<Result<VersionSatisfactionResult>> {
  const grant = verifyOperator(dependencies, query.authorization);
  if (!grant.ok) return err(grant.error);
  const window = windowFrom(dependencies.clock.now(), query.sinceDays ?? null, dependencies.policy.ratings);
  const rows = await dependencies.ratings.sample(grant.value.scope, {
    since: window.since,
    agentId: query.agentId,
  });
  if (!rows.ok) return err(rows.error);
  const numbers = await versionNumbers(dependencies, query.authorization, query.agentId);
  return ok({
    sinceDays: window.days,
    total: rows.value.length,
    rows: satisfactionByVersion(rows.value, numbers),
  });
}

export async function readAgentSatisfaction(
  dependencies: GovernanceDependencies,
  query: SatisfactionQuery,
): Promise<Result<AgentSatisfactionResult>> {
  const grant = verifyOperator(dependencies, query.authorization);
  if (!grant.ok) return err(grant.error);
  const window = windowFrom(dependencies.clock.now(), query.sinceDays ?? null, dependencies.policy.ratings);
  const rows = await dependencies.ratings.sample(grant.value.scope, { since: window.since, agentId: null });
  if (!rows.ok) return err(rows.error);
  return ok({ sinceDays: window.days, rows: satisfactionByAgent(rows.value) });
}

/**
 * The version-id -> version-number map, from `agents`.
 *
 * A failure answers an EMPTY map rather than failing the rollup: a satisfaction
 * report without version labels is degraded, and a satisfaction report that
 * refuses to render because a label service is unavailable is useless.
 */
export async function versionNumbers(
  dependencies: GovernanceDependencies,
  authorization: unknown,
  agentId: AgentId,
): Promise<ReadonlyMap<string, number>> {
  const page = await dependencies.agents.pageVersions({
    authorization,
    agentId,
    take: dependencies.policy.evals.maxPageSize,
  });
  if (!page.ok) return new Map();
  const numbers = new Map<string, number>();
  for (const version of page.value.items) numbers.set(version.agentVersionId, version.versionNumber);
  return numbers;
}
