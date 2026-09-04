// `ToolHealth` — what an operator looks at when a tool stops working.
//
// One row per `@@unique([environmentId, toolId, entityExternalId])`. Keyed by
// the entity's EXTERNAL id rather than its primary key, and nullable, because
// the same `Tool` row can be exposed by several entities and "this tool is
// failing" is only a useful sentence once it says whose.
//
// FIVE COUNTERS, AND THE INTERESTING ONE IS THE ONE THAT RESETS.
//
//   failCount      CONSECUTIVE failures. Reset to zero by any success.
//   totalCalls     monotonic.
//   totalFailures  monotonic.
//   avgLatencyMs   the mean over `totalCalls`.
//   p95LatencyMs   declared by the schema and never written. See below.
//
// `failCount` is the only counter that answers "is it broken NOW". A tool with
// nine thousand lifetime failures and a `failCount` of zero is a busy tool that
// works; a tool with four lifetime failures and a `failCount` of four is one
// that has just died. Collapsing it into `totalFailures` — the tempting
// simplification, since the ratio looks like the same information — loses the
// distinction entirely, because a long-lived tool's ratio barely moves when it
// stops working.
//
// THE AVERAGE IS COMPUTED HERE, WHICH THE SOURCE COULD NOT DO. The running
// system writes `avgLatencyMs: latencyMs` — the LAST latency, under an
// average's name — inside a single Prisma `upsert`, because that statement
// cannot read the `totalCalls` it is incrementing in the same breath. Extracting
// the rule to a value removes the constraint: `applyOutcome` takes the previous
// row and returns the next one, so the incremental mean is available and is
// what the column now holds. The behaviour change is deliberate, is confined to
// a field whose name already claimed it, and is the one place this file departs
// from the source.
//
// `p95LatencyMs` STAYS NULL. It is in the schema, nothing writes it, and a
// percentile cannot be derived from the four counters that are kept — it needs
// the distribution, which lives in `observability`. Modelling it as null rather
// than quietly filling it with the mean is what stops a dashboard reporting a
// p95 that is not one.

import type { EnvironmentId } from "@platos/kernel";

import type { ExternalEntityId, ToolHealthId, ToolId } from "./identifiers.js";

/**
 * `ToolHealth.lastStatus`. Free text in the column; three values in practice.
 *
 * `timeout` is kept apart from `failed` because they send an operator to
 * different places: a timeout is a slow backend or a budget set too low, and a
 * failure is a backend that answered and said no.
 */
export const HEALTH_OUTCOMES = ["success", "failed", "timeout"] as const;

export type HealthOutcome = (typeof HEALTH_OUTCOMES)[number];

export interface ToolHealth {
  readonly toolHealthId: ToolHealthId;
  readonly environmentId: EnvironmentId;
  readonly toolId: ToolId;
  /** Null for a tool no entity owns — a runtime or meta tool. */
  readonly entityExternalId: ExternalEntityId | null;
  readonly lastCalledAt: Date | null;
  readonly lastStatus: HealthOutcome | null;
  /** Consecutive failures. Any success resets it. */
  readonly failCount: number;
  readonly totalCalls: number;
  readonly totalFailures: number;
  readonly avgLatencyMs: number | null;
  /** Declared by the schema, never written. See the header note. */
  readonly p95LatencyMs: number | null;
  readonly updatedAt: Date;
}

export function freshHealth(
  toolHealthId: ToolHealthId,
  environmentId: EnvironmentId,
  toolId: ToolId,
  entityExternalId: ExternalEntityId | null,
  at: Date,
): ToolHealth {
  return {
    toolHealthId,
    environmentId,
    toolId,
    entityExternalId,
    lastCalledAt: null,
    lastStatus: null,
    failCount: 0,
    totalCalls: 0,
    totalFailures: 0,
    avgLatencyMs: null,
    p95LatencyMs: null,
    updatedAt: at,
  };
}

/**
 * Fold one call's outcome into a health row.
 *
 * The mean is computed in the incremental form
 * `previous + (latency - previous) / n` rather than by re-deriving a running
 * sum. Both are correct for the counts involved; the incremental form is the
 * one that does not need a total this row has never stored, and it does not
 * overflow at a call count a busy tool actually reaches.
 *
 * A negative latency is clamped to zero. It is reachable — the source measures
 * with `Date.now()`, which is not monotonic across a clock adjustment — and a
 * negative sample would drag the mean below every observation in it.
 */
export function applyOutcome(
  health: ToolHealth,
  outcome: HealthOutcome,
  latencyMs: number,
  at: Date,
): ToolHealth {
  const latency = Math.max(0, Math.round(latencyMs));
  const totalCalls = health.totalCalls + 1;
  const succeeded = outcome === "success";
  const previous = health.avgLatencyMs ?? 0;

  return {
    ...health,
    lastCalledAt: at,
    lastStatus: outcome,
    failCount: succeeded ? 0 : health.failCount + 1,
    totalCalls,
    totalFailures: health.totalFailures + (succeeded ? 0 : 1),
    avgLatencyMs: previous + (latency - previous) / totalCalls,
    updatedAt: at,
  };
}

/** Lifetime failure ratio. Null before the first call — not zero. */
export function failureRatio(health: ToolHealth): number | null {
  if (health.totalCalls === 0) return null;
  return health.totalFailures / health.totalCalls;
}

/**
 * Is this tool failing right now?
 *
 * Consecutive failures at or above the threshold. Deliberately NOT a ratio: the
 * ratio is a lifetime statistic and answers a different question, and a tool
 * that has served a million calls cannot move it fast enough to alert on.
 */
export function isFailing(health: ToolHealth, consecutiveFailureThreshold: number): boolean {
  return health.failCount >= consecutiveFailureThreshold;
}

/** The health-row key, so the cache and the store agree by construction. */
export function healthKey(
  environmentId: EnvironmentId,
  toolId: ToolId,
  entityExternalId: ExternalEntityId | null,
): string {
  return `${environmentId}/${toolId}/${entityExternalId ?? ""}`;
}
