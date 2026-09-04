// Use case: the per-agent risk board.
//
// One number per agent, blended from four rates. The formula is
// `domain/risk.ts`; this file is what supplies its inputs, and where they come
// from is the interesting part.
//
// THE NUMERATORS ARE THIS CONTEXT'S OWN. PII and injection counts come from the
// safety ledger, which this context is sole writer of.
//
// THE DENOMINATORS BELONG TO THREE OTHER CONTEXTS AND ARRIVE THROUGH ONE PORT.
// Turn counts are `conversations`', tool failures are `tools`', approvals are
// `jobs`' — none of which ADR M0.3 §1 row 14 permits this context to import. The
// source reads all three tables directly from inside the monitoring module. Here
// they arrive through `ActivityReader`, declared in this context's vocabulary and
// implemented at the composition root; `ports/read-seams.ts` records why.
//
// AN AGENT WITH SAFETY EVENTS AND NO ACTIVITY STILL APPEARS. The two sources are
// merged by union, not by intersection, so an agent that produced three PII
// events and no turns is on the board — with `denominatorSubstituted` set, so a
// reader can see the rate was computed against an invented denominator rather
// than a measured one. The source substitutes the same denominator and says
// nothing.
//
// A FAILING ACTIVITY READER DEGRADES THE BOARD RATHER THAN EMPTYING IT. Safety
// counts alone still produce a board, marked; a safety ledger that fails is a
// refusal, because a risk board with no safety input is not a degraded risk
// board, it is a different and reassuring picture.

import { err, ok, type Result } from "@platos/kernel";

import {
  scoreAgents,
  windowFrom,
  type AgentActivity,
  type AgentId,
  type AgentRisk,
} from "../domain/index.js";
import { verifyOperator } from "./authorization.js";
import type { GovernanceDependencies } from "./dependencies.js";

export interface RiskBoardQuery {
  readonly authorization: unknown;
  readonly sinceDays?: number | null;
}

export interface RiskBoardResult {
  readonly sinceDays: number;
  readonly rows: readonly AgentRisk[];
  /**
   * False when the activity reader could not answer, so every denominator on
   * this board was substituted. A board that is not complete has NOT cleared
   * anything.
   */
  readonly complete: boolean;
}

export async function readRiskBoard(
  dependencies: GovernanceDependencies,
  query: RiskBoardQuery,
): Promise<Result<RiskBoardResult>> {
  const grant = verifyOperator(dependencies, query.authorization);
  if (!grant.ok) return err(grant.error);
  const scope = grant.value.scope;
  const window = windowFrom(dependencies.clock.now(), query.sinceDays ?? null, dependencies.policy.risk);

  const detectors = await dependencies.safety.countByAgent(scope, window.since);
  if (!detectors.ok) return err(detectors.error);
  const activity = await dependencies.activity.countByAgent(scope, window.since);

  const merged = new Map<string, AgentActivity>();
  if (activity.ok) {
    for (const row of activity.value) {
      merged.set(row.agentId, {
        agentId: row.agentId,
        turns: row.turns,
        piiEvents: 0,
        injectionEvents: 0,
        toolErrors: row.toolErrors,
        approvalEvents: row.approvalEvents,
      });
    }
  }
  for (const row of detectors.value) {
    const held = merged.get(row.agentId);
    merged.set(row.agentId, {
      agentId: row.agentId,
      turns: held?.turns ?? 0,
      piiEvents: row.piiEvents,
      injectionEvents: row.injectionEvents,
      toolErrors: held?.toolErrors ?? 0,
      approvalEvents: held?.approvalEvents ?? 0,
    });
  }

  const names = await agentNames(dependencies, query.authorization, [...merged.keys()] as AgentId[]);
  return ok({
    sinceDays: window.days,
    rows: scoreAgents([...merged.values()], names, dependencies.policy.risk),
    complete: activity.ok,
  });
}

/**
 * Agent names, from `agents`, in one page.
 *
 * A name this context cannot resolve is null on the row rather than a reason to
 * drop the agent: an unnamed high-risk agent is still a high-risk agent.
 */
async function agentNames(
  dependencies: GovernanceDependencies,
  authorization: unknown,
  agentIds: readonly AgentId[],
): Promise<ReadonlyMap<string, string>> {
  const names = new Map<string, string>();
  if (agentIds.length === 0) return names;
  const page = await dependencies.agents.pageAgents({
    authorization,
    limit: dependencies.policy.evals.maxPageSize,
    offset: 0,
  });
  if (!page.ok) return names;
  const wanted = new Set<string>(agentIds);
  for (const agent of page.value.items) {
    if (wanted.has(agent.agentId)) names.set(agent.agentId, agent.name);
  }
  return names;
}
