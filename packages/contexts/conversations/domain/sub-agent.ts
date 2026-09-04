// Delegation: one agent asking another to do part of its turn.
//
// THE THREE CEILINGS ARE THREE DIFFERENT THINGS AND THE SOURCE ONLY HAS TWO.
//
//   DEPTH — how long the chain of delegations may get. `SUBAGENT_MAX_DEPTH = 2`
//   in the source, checked by `isSpawnDepthAllowed`, and the child is handed
//   `spawn_agent` only while it is still under the ceiling.
//   FAN-OUT — how many delegations ONE turn may make. `PLATOS_MAX_CHILDREN
//   _PER_TURN`, default 5, counted in Redis with a ten-minute expiry.
//   A CYCLE — an agent already on the chain being asked for again. The source
//   has NO check for this: A delegates to B delegates to A is inside both
//   ceilings and runs, and the two agents can hand work back and forth until the
//   depth ceiling stops them two levels down rather than at the first loop.
//
// A cycle is refused here even though the ceilings would eventually bound it,
// because a ceiling bounds the DAMAGE and this names the BUG. They are three
// codes for the reason the whole error catalogue gives: a chain that is too deep
// and a chain that is circular are different mistakes with different fixes, and
// a test that cannot tell them apart has not tested either.
//
// THE CHAIN IS CARRIED, NOT INFERRED. The source passes an integer depth down
// and nothing else, so no level can see who is above it — which is precisely why
// it cannot detect a cycle. `DelegationChain` carries the agent ids, so depth is
// the chain's LENGTH rather than a number a caller could get wrong, and the
// cycle check is a membership test.
//
// THE BILL GOES TO THE PARENT. The source attributes a sub-agent's spend to the
// PARENT agent while keeping the sub-agent's model on the row, and that is kept:
// a delegated call is work the parent's turn caused, so it lands on the parent's
// turn as a step. `turn-cost.ts` rolls those steps up with the rest, which is
// how a turn that delegated and then failed keeps its delegated money — the
// thing the source's failure path drops.

import { err, ok, type Result } from "@platos/kernel";

import {
  subAgentCycle,
  subAgentDepthExceeded,
  subAgentFanOutExceeded,
  subAgentsDisabled,
} from "./errors.js";
import type { AgentId } from "./identifiers.js";
import type { SubAgentPolicy } from "./policy.js";

/**
 * Who is already on the delegation chain, root first.
 *
 * The ROOT agent is element zero, so an ordinary turn has a chain of length one
 * and depth zero. That makes "depth" the number of delegations rather than the
 * number of agents, which is the reading both ceilings are written against.
 */
export interface DelegationChain {
  readonly agentIds: readonly AgentId[];
}

export function rootChain(agentId: AgentId): DelegationChain {
  return Object.freeze({ agentIds: Object.freeze([agentId]) });
}

/** How many delegations deep this chain already is. A root chain is zero. */
export function chainDepth(chain: DelegationChain): number {
  return Math.max(0, chain.agentIds.length - 1);
}

export interface DelegationRequest {
  readonly chain: DelegationChain;
  readonly childAgentId: AgentId;
  /** How many delegations this turn has already made. */
  readonly fanOutSoFar: number;
}

/**
 * Admit one delegation, or refuse it.
 *
 * FOUR GUARDS IN A FIXED ORDER, and the order is part of the design. The kill
 * switch is first because an installation that has turned delegation off should
 * not learn about its own ceilings. The cycle check is BEFORE the two ceilings
 * because a cycle inside both ceilings is still a cycle, and reporting it as a
 * depth breach would send an operator to raise a ceiling that is not the
 * problem. Depth then fan-out, because depth is the one the source enforces
 * first and the order is observable through which code comes back when a request
 * breaches both.
 */
export function admitDelegation(
  request: DelegationRequest,
  policy: SubAgentPolicy,
): Result<DelegationChain> {
  if (!policy.subAgentsEnabled) return err(subAgentsDisabled());

  if (request.chain.agentIds.includes(request.childAgentId)) {
    return err(subAgentCycle(request.childAgentId));
  }

  const depth = chainDepth(request.chain) + 1;
  if (depth > policy.maxDepth) return err(subAgentDepthExceeded(depth, policy.maxDepth));

  const fanOut = request.fanOutSoFar + 1;
  if (fanOut > policy.maxFanOut) return err(subAgentFanOutExceeded(fanOut, policy.maxFanOut));

  return ok(Object.freeze({ agentIds: Object.freeze([...request.chain.agentIds, request.childAgentId]) }));
}

/**
 * Whether a child may itself delegate.
 *
 * The source expresses this by handing the child a `spawn_agent` tool only while
 * `spawnDepth < SUBAGENT_MAX_DEPTH`, so the ceiling is enforced by ABSENCE of a
 * capability rather than by a refusal. That is the better mechanism — a model
 * cannot ask for what it was not offered — and it is kept, which is why this is
 * a predicate a caller uses to build a catalogue rather than a guard.
 */
export function mayDelegateFurther(chain: DelegationChain, policy: SubAgentPolicy): boolean {
  return policy.subAgentsEnabled && chainDepth(chain) + 1 <= policy.maxDepth;
}

/** The step ceiling one delegated call gets. Clamped, exactly as a turn's is. */
export function subAgentStepCeiling(requested: number | null, policy: SubAgentPolicy): number {
  const asked = requested === null || !Number.isInteger(requested) || requested < 1 ? 6 : requested;
  return Math.min(asked, policy.maxStepsPerSubAgent);
}
