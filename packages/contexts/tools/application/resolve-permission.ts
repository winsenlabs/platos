// Use case: resolve the four-tier permission for one tool call.
//
// The algebra is in `domain/permission.ts` and every line of it is pure. What
// this file adds is the two READS the algebra needs — the organization's
// policy rows and the agent's active version — and the order it does them in.
//
// THE ORDER IS SHORT-CIRCUITING AND THAT IS A COST DECISION, NOT A SEMANTIC
// ONE. Tier 1 is a table lookup, tier 2 is one indexed read, tier 3 is a
// four-table join, tier 4 is already in memory. A `block` at any tier is
// terminal, so evaluating cheapest-first means the calls a platform baseline
// refuses outright never touch the database at all — and a scope being probed
// with a blocked tool name cannot be made to do work by the probing.
//
// The composed ANSWER does not depend on the order: `mostRestrictive` is a max
// over a total order. Only the reported tier does, and reporting the tier that
// actually blocked is what makes an audit line actionable.

import { err, ok, type EnvironmentScope, type Result } from "@platos/kernel";

import {
  agentOpinion,
  decidePermission,
  effectFor,
  organizationOpinion,
  platformMinimumFor,
  sessionOpinion,
  type AgentId,
  type PermissionDecision,
  type PermissionState,
  type ToolId,
  type ToolName,
  type TokenTier,
} from "../domain/index.js";
import type { ToolsDependencies } from "./dependencies.js";

export interface ResolvePermissionQuery {
  readonly scope: EnvironmentScope;
  readonly toolName: ToolName;
  /** Null when the caller is not an agent — an operator or an MCP client. */
  readonly agentId: AgentId | null;
  /** Needed only for tier 3, which is keyed on the row and not the name. */
  readonly toolId: ToolId | null;
  readonly sessionOverrides?: Readonly<Record<string, PermissionState>> | null;
  readonly tokenTier?: TokenTier;
}

export async function resolvePermission(
  dependencies: ToolsDependencies,
  query: ResolvePermissionQuery,
): Promise<Result<PermissionDecision>> {
  const platform = platformMinimumFor(query.toolName);
  if (platform === "block") {
    return ok({ state: "block", tier: 1, reason: "platform-tier block" });
  }

  const policies = await dependencies.repository.listOrganizationPolicies(query.scope);
  if (!policies.ok) return err(policies.error);
  const organization = organizationOpinion(policies.value, query.toolName);
  if (organization === "block") {
    return ok({ state: "block", tier: 2, reason: "org-policy block" });
  }

  const agent = await readAgentOpinion(dependencies, query);
  if (!agent.ok) return err(agent.error);
  if (agent.value === "block") {
    return ok({ state: "block", tier: 3, reason: "agent-policy block" });
  }

  const session = sessionOpinion(query.sessionOverrides ?? null, query.toolName);
  return ok(
    decidePermission(
      query.toolName,
      { platform, organization, agent: agent.value, session },
      query.tokenTier ?? "scope",
    ),
  );
}

/**
 * Tier 3, or nothing.
 *
 * NO AGENT MEANS NO OPINION, not a denial. An operator invoking a tool from the
 * console and an MCP client calling the hosted surface are both legitimate
 * non-agent callers, and defaulting them to `block` would take the whole
 * operator surface offline. The default-deny that tier 3 does carry applies
 * only when there IS an agent — see `domain/permission.ts` on why that
 * asymmetry is not an inconsistency.
 *
 * AN AGENT WITH NO BINDING IN THIS SCOPE IS A DENIAL. Transcribed: the source
 * logs "scoped AgentBinding was not found" and returns `block`. An agent whose
 * active version cannot be resolved in the environment it is calling in is not
 * an agent with no restrictions — it is an agent that is not deployed here.
 */
async function readAgentOpinion(
  dependencies: ToolsDependencies,
  query: ResolvePermissionQuery,
): Promise<Result<PermissionState | null>> {
  if (query.agentId === null) return ok(null);

  const binding = await dependencies.repository.findAgentPolicyBinding(query.scope, query.agentId);
  if (!binding.ok) return err(binding.error);
  if (binding.value === null) return ok(agentOpinion(null));

  return ok(
    agentOpinion({
      defaultPolicy: binding.value.defaultPolicy,
      explicitEffect: query.toolId === null ? null : effectFor(binding.value, query.toolId),
    }),
  );
}
