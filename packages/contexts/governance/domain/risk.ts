// The per-agent risk score.
//
// A weighted blend of four rates, each "events per 100 turns" capped at 100:
//
//   risk = piiWeight * piiRate + injectionWeight * injectionRate
//        + toolErrorWeight * toolErrorRate + approvalWeight * approvalRate
//
// It is an operator-facing heuristic and the source says so; keeping it means
// keeping a number operators already read, and keeping it PURE means the number
// can be checked against a spreadsheet.
//
// THE DENOMINATOR SUBSTITUTION IS THE ONE THING THAT WAS SILENT. The source
// writes `Math.max(1, turns)`, so an agent with three PII events and NO turns
// scores as though it had one turn: a 300% rate capped to 100, weighted to 40,
// and a `medium` band on a agent that never ran. That is arguably the right
// answer — safety events with no turns behind them are genuinely anomalous — but
// nothing in the output says the denominator was invented. `denominatorSubstituted`
// says it, so a dashboard can mark the row rather than presenting a rate that
// was never measured.
//
// THE BANDS ARE INCLUSIVE AT THE BOTTOM. `risk >= high` is high and
// `risk >= medium` is medium, exactly as the source. The boundaries are pinned
// with literals in the suite because an off-by-one at 50 moves every agent
// sitting on the line.

import type { AgentId } from "./identifiers.js";
import type { RiskPolicy } from "./policy.js";

export type RiskBand = "low" | "medium" | "high";

/** What one agent did in the window. Every count is supplied, never read here. */
export interface AgentActivity {
  readonly agentId: AgentId;
  readonly turns: number;
  readonly piiEvents: number;
  readonly injectionEvents: number;
  readonly toolErrors: number;
  readonly approvalEvents: number;
}

export interface AgentRisk extends AgentActivity {
  /** Null when `agents` does not name it, or the agent is gone. */
  readonly agentName: string | null;
  readonly risk: number;
  readonly band: RiskBand;
  /** True when `turns` was zero and 1 was used in its place. */
  readonly denominatorSubstituted: boolean;
}

/** Events per 100 turns, capped at 100. Never above 100, never below 0. */
export function rateOf(events: number, denominator: number): number {
  if (events <= 0) return 0;
  return Math.min(100, (events / denominator) * 100);
}

export function bandOf(risk: number, policy: RiskPolicy): RiskBand {
  if (risk >= policy.highBand) return "high";
  if (risk >= policy.mediumBand) return "medium";
  return "low";
}

/**
 * Score one agent.
 *
 * The blend is clamped to 0..100 as a belt-and-braces measure: the four weights
 * are configuration, and an install that raised them past a sum of 1 would
 * otherwise be able to produce a risk above the scale its own bands are drawn on.
 */
export function scoreAgentRisk(
  activity: AgentActivity,
  agentName: string | null,
  policy: RiskPolicy,
): AgentRisk {
  const denominatorSubstituted = activity.turns <= 0;
  const denominator = denominatorSubstituted ? 1 : activity.turns;
  const blended =
    policy.piiWeight * rateOf(activity.piiEvents, denominator) +
    policy.injectionWeight * rateOf(activity.injectionEvents, denominator) +
    policy.toolErrorWeight * rateOf(activity.toolErrors, denominator) +
    policy.approvalWeight * rateOf(activity.approvalEvents, denominator);
  const risk = Math.max(0, Math.min(100, blended));
  return {
    ...activity,
    agentName,
    risk: Math.round(risk * 10) / 10,
    band: bandOf(risk, policy),
    denominatorSubstituted,
  };
}

/**
 * Score every agent, riskiest first.
 *
 * Ties are broken by agent id rather than left to the sort's stability, so two
 * runs over the same data list the same agents in the same order.
 */
export function scoreAgents(
  activities: readonly AgentActivity[],
  names: ReadonlyMap<string, string>,
  policy: RiskPolicy,
): readonly AgentRisk[] {
  return activities
    .map((activity) => scoreAgentRisk(activity, names.get(activity.agentId) ?? null, policy))
    .sort((left, right) => {
      if (left.risk !== right.risk) return right.risk - left.risk;
      return left.agentId.localeCompare(right.agentId);
    });
}

/**
 * Which detectors feed the two safety rates.
 *
 * `tool_param` folds into the injection rate, which is the source's own
 * grouping: a poisoned tool argument is an injection that arrived through a
 * different door. Stated as data so a reader can see the grouping without
 * reading the fold.
 */
export const INJECTION_DETECTORS: readonly string[] = Object.freeze(["injection", "tool_param"]);
export const PII_DETECTORS: readonly string[] = Object.freeze(["pii"]);
