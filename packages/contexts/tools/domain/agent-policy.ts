// `AgentToolPolicy` — which tools an agent VERSION may call.
//
// The row hangs off `AgentVersion`, not `Agent`, and that is the whole design:
// a tool loadout is part of what a version IS, so rolling a version back rolls
// its permissions back with it, and a canary running the previous version keeps
// the previous loadout while the new one is live beside it. A policy attached
// to the agent would leak the new version's permissions into the old one.
//
// `@@unique([agentVersionId, toolId])` — one opinion per version per tool.
//
// THE DEFAULT LIVES ON THE VERSION, NOT HERE. `AgentVersion.toolDefaultPolicy`
// is `ALL` or `NONE`, and the rows below are the exceptions to it. That yields
// the two useful shapes with no third: `NONE` plus ALLOW rows is an allow-list,
// `ALL` plus DENY rows is a deny-list. An operator picks the one whose
// exception set is small and the other is expressible without them.
//
// `priority` EXISTS ON THE ROW AND CANNOT MATTER HERE. The column is ordered by
// in the source's tier-3 read (`priority desc, createdAt desc, take 1`), but
// the unique key already admits at most one row per (version, tool), so the
// ordering can never choose between two rows. It is preserved on the aggregate
// because it is a column this context is sole writer of and dropping it from
// the model would lose it at the next migration — not because it decides
// anything. `sole-writer` ownership is not the same as "load-bearing".

import type { AgentId, AgentVersionId, AgentToolPolicyId, ToolId } from "./identifiers.js";

/** `PolicyEffect`, transcribed. Two-valued: there is no third column state. */
export const POLICY_EFFECTS = ["ALLOW", "DENY"] as const;

export type PolicyEffect = (typeof POLICY_EFFECTS)[number];

/** `AgentVersion.toolDefaultPolicy` — what an unmentioned tool gets. */
export const AGENT_TOOL_DEFAULT_POLICIES = ["ALL", "NONE"] as const;

export type AgentToolDefaultPolicy = (typeof AGENT_TOOL_DEFAULT_POLICIES)[number];

export interface AgentToolPolicy {
  readonly agentToolPolicyId: AgentToolPolicyId;
  readonly agentVersionId: AgentVersionId;
  readonly toolId: ToolId;
  readonly effect: PolicyEffect;
  /** Recorded, never consulted. See the header note. */
  readonly priority: number;
  readonly createdAt: Date;
}

/** An agent, its active version's default, and that version's exceptions. */
export interface AgentPolicyBinding {
  readonly agentId: AgentId;
  readonly agentVersionId: AgentVersionId;
  readonly defaultPolicy: AgentToolDefaultPolicy;
  readonly policies: readonly AgentToolPolicy[];
}

/** This version's opinion about one tool, or null when it has none. */
export function effectFor(binding: AgentPolicyBinding, toolId: ToolId): PolicyEffect | null {
  return binding.policies.find((policy) => policy.toolId === toolId)?.effect ?? null;
}

/** Resolve the default into a decision for a tool this version never named. */
export function permitsTool(binding: AgentPolicyBinding, toolId: ToolId): boolean {
  const explicit = effectFor(binding, toolId);
  if (explicit !== null) return explicit === "ALLOW";
  return binding.defaultPolicy === "ALL";
}

/**
 * The agents that may see one tool, across an environment's bindings.
 *
 * Sorted, because it is written onto every exposure of that tool and read back
 * by an equality comparison the invalidation path uses to decide whether
 * anything changed. An unsorted list would make a no-op policy refresh look
 * like a change on every rebuild.
 */
export function allowedAgentIds(
  bindings: readonly AgentPolicyBinding[],
  toolId: ToolId,
): readonly AgentId[] {
  return bindings
    .filter((binding) => permitsTool(binding, toolId))
    .map((binding) => binding.agentId)
    .sort();
}
