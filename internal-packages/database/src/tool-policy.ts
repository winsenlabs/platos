import { AgentToolDefaultPolicy, PolicyEffect } from "../generated/control";

export interface ToolPolicyInput {
  readonly toolId: string;
  readonly effect: PolicyEffect;
}

/**
 * Resolves explicit rows over the version's database-persisted default.
 *
 * NONE + zero rows means no tools. ALL + zero rows means all candidate tools,
 * including tools registered after the version was created. Explicit ALLOW and
 * DENY rows override either default, so unlisted-tool behavior is never inferred
 * from an ambiguous empty relation.
 */
export function resolveAgentToolIds(
  defaultPolicy: AgentToolDefaultPolicy,
  policies: readonly ToolPolicyInput[],
  candidateToolIds: readonly string[]
): string[] {
  const effects = new Map(policies.map((policy) => [policy.toolId, policy.effect]));
  const selected = new Set<string>();

  for (const toolId of candidateToolIds) {
    const effect = effects.get(toolId);
    const allowed =
      effect === PolicyEffect.ALLOW ||
      (effect === undefined && defaultPolicy === AgentToolDefaultPolicy.ALL);
    if (allowed) selected.add(toolId);
  }

  return [...selected].sort();
}
