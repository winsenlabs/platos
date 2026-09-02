// `EntityToolPolicy` — which of an entity's tools its INBOUND MCP surface
// exposes, and to whom.
//
// Not to be confused with `AgentToolPolicy`, which it sits beside in the same
// context and answers a different question. `AgentToolPolicy` is about an agent
// Platos runs calling OUT to a backend. This is about a third party calling IN
// to `/mcp/entity/:id` and asking what it may use. Same tool rows, opposite
// direction, and one of them is a public surface.
//
// DEFAULT-DENY, AND THE SYNTHETIC ROW IS HOW THAT SURVIVES A LISTING.
// `@@unique([environmentId, entityId, toolId])` means an exposure with no
// policy row simply has no policy — and a listing that showed only the rows
// that exist would show an operator nothing to switch on. `synthesizeDenial`
// mints the missing half at read time as an explicit, un-exposed row, so the
// surface is complete without a write and without a default that leans open.
//
// SCOPE LABELS CARRY TWO KINDS OF THING IN ONE `String[]`.
// The column holds free-form scope labels AND, prefixed `platos:pat:`, the ids
// of the personal access tokens permitted to use the tool. Two meanings, one
// array, and reading it wrong exposes a tool to every caller instead of one.
// `decodeLabels` / `encodeLabels` are the only places that know, and the prefix
// is declared once below.

import type { EnvironmentId, EntityId } from "@platos/kernel";

import type {
  ActorId,
  EntityToolPolicyId,
  ToolId,
  ToolName,
} from "./identifiers.js";
import type { PolicyEffect } from "./agent-policy.js";
import type { ToolAclPolicy } from "./policy.js";

/**
 * `EntityMcpConfig.identityMode` and `EntityToolPolicy.minIdentityMode`.
 *
 * A TOTAL ORDER, and the ordering is the rule: anonymous < bearer < oidc. A
 * caller may use a tool when its own mode ranks at least as high as the tool
 * demands, so raising a tool's minimum can only ever remove callers.
 */
export const IDENTITY_MODES = ["anonymous", "bearer", "oidc"] as const;

export type IdentityMode = (typeof IDENTITY_MODES)[number];

export function identityRank(mode: string): number {
  return mode === "oidc" ? 2 : mode === "bearer" ? 1 : 0;
}

/** The prefix that turns a scope label into a personal-access-token id. */
export const PAT_LABEL_PREFIX = "platos:pat:";

/** The prefix an MCP caller's own principal id carries. */
export const PAT_PRINCIPAL_PREFIX = "mcp:pat:";

export interface EntityToolPolicy {
  readonly entityToolPolicyId: EntityToolPolicyId;
  readonly environmentId: EnvironmentId;
  readonly entityId: EntityId;
  readonly toolId: ToolId;
  readonly toolName: ToolName;
  /** ALLOW means exposed on the inbound surface. DENY, and absence, do not. */
  readonly effect: PolicyEffect;
  readonly minIdentityMode: IdentityMode;
  /** Free-form labels the caller must hold ALL of. Never PAT ids. */
  readonly scopeLabels: readonly string[];
  /** Token ids permitted to use this tool. Empty means "any bearer". */
  readonly allowedPatIds: readonly string[];
  readonly addedBy: ActorId;
  /** Null on a synthesized denial — nothing was ever written. */
  readonly addedAt: Date | null;
  readonly lastReviewedAt: Date | null;
}

export interface DecodedLabels {
  readonly scopeLabels: readonly string[];
  readonly allowedPatIds: readonly string[];
}

export function decodeLabels(labels: readonly string[]): DecodedLabels {
  return {
    scopeLabels: labels.filter((label) => !label.startsWith(PAT_LABEL_PREFIX)),
    allowedPatIds: labels
      .filter((label) => label.startsWith(PAT_LABEL_PREFIX))
      .map((label) => label.slice(PAT_LABEL_PREFIX.length)),
  };
}

/**
 * Re-encode both halves into the one column.
 *
 * A scope label that already carries the PAT prefix is DROPPED rather than
 * escaped. Round-tripping it would let an operator grant a token by typing a
 * scope label, which is a privilege escalation through a text field.
 */
export function encodeLabels(
  scopeLabels: readonly string[],
  allowedPatIds: readonly string[],
): readonly string[] {
  return [
    ...new Set([
      ...scopeLabels.filter((label) => !label.startsWith(PAT_LABEL_PREFIX)),
      ...allowedPatIds.map((id) => `${PAT_LABEL_PREFIX}${id}`),
    ]),
  ];
}

/** Who is asking, as the inbound MCP surface resolved them. */
export interface McpCaller {
  readonly identityMode: IdentityMode;
  /** The caller's principal id, `mcp:pat:<id>` for a token. */
  readonly principalId: string;
  readonly scopes: readonly string[];
}

/**
 * May this caller use this tool?
 *
 * Three independent gates, ALL of which must pass:
 *
 *   the caller's identity mode must rank at or above the tool's minimum;
 *   if the tool names permitted tokens and the caller IS a token, it must be
 *   one of them;
 *   the caller must hold EVERY scope label the tool carries.
 *
 * The middle gate is conditional on `identityMode === "bearer"` in the source
 * and that is preserved: an OIDC caller is not a personal access token and has
 * no id to be on the list, so applying the check to them would deny every
 * strongly-authenticated caller in favour of weaker ones.
 *
 * The last gate is `every`, not `some`. Labels are a conjunction: a tool
 * labelled `mcp:tools` and `billing` needs a caller holding both.
 */
export function permitsCaller(policy: EntityToolPolicy, caller: McpCaller): boolean {
  if (policy.effect !== "ALLOW") return false;
  if (identityRank(caller.identityMode) < identityRank(policy.minIdentityMode)) return false;
  if (policy.allowedPatIds.length > 0 && caller.identityMode === "bearer") {
    const patId = caller.principalId.startsWith(PAT_PRINCIPAL_PREFIX)
      ? caller.principalId.slice(PAT_PRINCIPAL_PREFIX.length)
      : caller.principalId;
    if (!policy.allowedPatIds.includes(patId)) return false;
  }
  return policy.scopeLabels.every((label) => caller.scopes.includes(label));
}

export function filterForCaller(
  policies: readonly EntityToolPolicy[],
  caller: McpCaller,
): readonly EntityToolPolicy[] {
  return policies.filter((policy) => permitsCaller(policy, caller));
}

/**
 * The explicit denial an exposure with no policy row stands for.
 *
 * `addedAt` is null and `addedBy` is empty because nothing was written: the row
 * is a rendering of an absence, and dating it would tell an operator someone
 * made this decision.
 */
export function synthesizeDenial(
  input: {
    readonly environmentId: EnvironmentId;
    readonly entityId: EntityId;
    readonly toolId: ToolId;
    readonly toolName: ToolName;
  },
  policy: ToolAclPolicy,
): EntityToolPolicy {
  return {
    entityToolPolicyId: "" as EntityToolPolicyId,
    environmentId: input.environmentId,
    entityId: input.entityId,
    toolId: input.toolId,
    toolName: input.toolName,
    effect: "DENY",
    minIdentityMode: policy.defaultMinimumIdentityMode,
    scopeLabels: [policy.defaultScopeLabel],
    allowedPatIds: [],
    addedBy: "" as ActorId,
    addedAt: null,
    lastReviewedAt: null,
  };
}

/**
 * The allowlist `EntityMcpConfig.toolAllowlist` is kept in step with.
 *
 * It is a DERIVED cache of the exposed names and never an independent source of
 * truth — the source recomputes it from the policy rows after every mutation
 * for exactly that reason. Distinct, sorted: a name can be exposed by two tool
 * versions at once, and the config column holds names.
 */
export function exposedToolNames(policies: readonly EntityToolPolicy[]): readonly ToolName[] {
  return [...new Set(policies.filter((policy) => policy.effect === "ALLOW").map((policy) => policy.toolName))].sort();
}
