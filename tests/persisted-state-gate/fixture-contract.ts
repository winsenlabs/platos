import { createHash } from "node:crypto";

export type CanonicalScopeKey = "alpha" | "beta";

export function deterministicFixtureUuid(
  ...parts: Array<string | number>
): string {
  const hex = createHash("sha256")
    .update(["win235", ...parts].join(":"), "utf8")
    .digest("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-4${hex.slice(13, 16)}-a${hex.slice(
    17,
    20
  )}-${hex.slice(20, 32)}`;
}

export function canonicalOperatorScope(key: CanonicalScopeKey) {
  const operatorId = deterministicFixtureUuid(key, "operator");
  return {
    key,
    organizationId: deterministicFixtureUuid(key, "organization"),
    organizationSlug: `win235-${key}`,
    projectId: deterministicFixtureUuid(key, "project"),
    projectSlug: `win235-${key}-project`,
    environmentId: deterministicFixtureUuid(key, "environment"),
    environmentSlug: "development",
    operatorId,
    userId: operatorId,
    endUserId: deterministicFixtureUuid(key, "end-user"),
    externalUserId: `win235-${key}-end-user`,
    entityId: deterministicFixtureUuid(key, "entity"),
    clusterId: deterministicFixtureUuid(key, "cluster"),
    threadId: deterministicFixtureUuid(key, "thread"),
    agentId: deterministicFixtureUuid(key, "agent", 0),
    approvalId: deterministicFixtureUuid(key, "approval"),
    jobId: deterministicFixtureUuid(key, "job"),
  } as const;
}
