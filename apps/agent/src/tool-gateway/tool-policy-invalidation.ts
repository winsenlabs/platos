export const TOOL_POLICY_INVALIDATION_CHANNEL = "tool-registry:policy-invalidation";

// The shared Redis provider applies this key prefix to publish commands but
// ioredis does not apply it to subscribe commands.
export const TOOL_POLICY_INVALIDATION_SUBSCRIPTION_CHANNEL =
  `platos:${TOOL_POLICY_INVALIDATION_CHANNEL}`;

export type ToolPolicyInvalidationScope = {
  organizationId: string;
  projectId: string;
  environmentId: string;
};

export function parseToolPolicyInvalidation(
  value: string,
): ToolPolicyInvalidationScope | null {
  try {
    const parsed = JSON.parse(value) as Partial<ToolPolicyInvalidationScope>;
    if (
      typeof parsed.organizationId !== "string" || !parsed.organizationId ||
      typeof parsed.projectId !== "string" || !parsed.projectId ||
      typeof parsed.environmentId !== "string" || !parsed.environmentId
    ) {
      return null;
    }
    return {
      organizationId: parsed.organizationId,
      projectId: parsed.projectId,
      environmentId: parsed.environmentId,
    };
  } catch {
    return null;
  }
}
