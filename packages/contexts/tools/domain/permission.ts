// The four-tier permission lattice.
//
// Effective policy = MOST_RESTRICTIVE(platform, organization, agent, session).
// Each tier may only TIGHTEN, never loosen. That single sentence is the whole
// safety argument: a platform baseline cannot be argued away by an organization
// policy, an organization policy cannot be argued away by an agent's tool
// policy, and a session override can add friction but never remove it.
//
//   auto_allow        the handler runs, the audit row is written, the result
//                     is streamed.
//   require_approval  an operator decision is created and the turn parks on it.
//   block             an immediate refusal. No approval, no retry.
//
// THE ORDER IS A TOTAL ORDER AND THAT IS WHY THE COMPOSITION IS SAFE.
// `mostRestrictive` is `max` over a three-element chain, so it is associative,
// commutative and idempotent — the tiers can be evaluated in any order, a tier
// that has nothing to say contributes nothing, and re-applying a tier changes
// nothing. None of that is true of an "allow list wins / deny list wins" scheme,
// which is what this replaced.
//
// TIER 3 IS DEFAULT-DENY AND TIERS 1, 2 AND 4 ARE DEFAULT-ALLOW. That looks
// inconsistent and is not. Tiers 1, 2 and 4 answer "does anyone want this
// tightened?", and silence means no. Tier 3 answers "does this agent's active
// version permit this tool?", and silence there means the agent was never
// granted it — `toolDefaultPolicy: "NONE"` with no matching row is a denial the
// operator wrote, not an absence of opinion. An unresolvable binding is a
// `block` for the same reason: an agent whose active version cannot be found in
// the scope is not an agent with no restrictions.

import type { AgentToolDefaultPolicy, PolicyEffect } from "./agent-policy.js";

export const PERMISSION_STATES = ["auto_allow", "require_approval", "block"] as const;

export type PermissionState = (typeof PERMISSION_STATES)[number];

/** The tier that produced a decision. Carried into every audit line. */
export type PermissionTier = 1 | 2 | 3 | 4;

/** `McpToken.tier` — a scope token is pinned to one scope, an admin token is not. */
export const TOKEN_TIERS = ["scope", "admin"] as const;

export type TokenTier = (typeof TOKEN_TIERS)[number];

export function stateRank(state: PermissionState): number {
  return state === "block" ? 2 : state === "require_approval" ? 1 : 0;
}

/** `max` over the chain. A tier with nothing to say passes `null`. */
export function mostRestrictive(
  ...states: readonly (PermissionState | null)[]
): PermissionState {
  let winner: PermissionState = "auto_allow";
  for (const state of states) {
    if (state !== null && stateRank(state) > stateRank(winner)) winner = state;
  }
  return winner;
}

/**
 * Does a policy pattern cover a tool name?
 *
 * Three forms, transcribed: `*` matches everything, an exact name matches
 * itself, and `<prefix>.*` matches the prefix and anything under it. There is
 * no general glob, deliberately — a pattern language a policy author can get
 * subtly wrong is a policy language that fails open.
 *
 * `gdpr.*` matching the bare `gdpr` is intentional and is in the source: a
 * namespace rule that missed the namespace's own root tool would leave exactly
 * the tool the rule was written for ungoverned.
 */
export function matchesPattern(pattern: string, toolName: string): boolean {
  if (pattern === "*") return true;
  if (pattern === toolName) return true;
  if (pattern.endsWith(".*")) {
    const prefix = pattern.slice(0, -2);
    return toolName === prefix || toolName.startsWith(`${prefix}.`);
  }
  return false;
}

/**
 * `PolicyEffect` is two-valued and `PermissionState` is three-valued, so the
 * mapping between them loses information in one direction and only one.
 */
export function stateFromEffect(effect: PolicyEffect): PermissionState {
  return effect === "DENY" ? "block" : "auto_allow";
}

/** The inverse, where it exists. `require_approval` has no column to live in. */
export function effectFromState(state: PermissionState): PolicyEffect | null {
  if (state === "block") return "DENY";
  if (state === "auto_allow") return "ALLOW";
  return null;
}

/** What each tier said, or null where it had nothing to say. */
export interface TierOpinions {
  readonly platform: PermissionState;
  readonly organization: PermissionState | null;
  readonly agent: PermissionState | null;
  readonly session: PermissionState | null;
}

export interface PermissionDecision {
  readonly state: PermissionState;
  readonly tier: PermissionTier;
  readonly reason: string;
}

/**
 * Tier 2: the strictest organization pattern that covers this name.
 *
 * Several patterns can match one name (`*`, `channels.*`, `channels.delete`)
 * and the strictest wins rather than the most specific. Specificity is a
 * plausible rule and it is the wrong one: it would let an organization write a
 * narrow `auto_allow` that punches a hole through its own broad `block`.
 */
export function organizationOpinion(
  policies: readonly { readonly pattern: string; readonly effect: PolicyEffect }[],
  toolName: string,
): PermissionState | null {
  let winner: PermissionState | null = null;
  for (const policy of policies) {
    if (!matchesPattern(policy.pattern, toolName)) continue;
    const state = stateFromEffect(policy.effect);
    if (winner === null || stateRank(state) > stateRank(winner)) winner = state;
  }
  return winner;
}

/**
 * Tier 3: this agent's active version.
 *
 * An explicit row wins. With no row the version's default decides, and `NONE`
 * means `block` — see the header note on why this tier alone is default-deny.
 */
export function agentOpinion(
  binding: {
    readonly defaultPolicy: AgentToolDefaultPolicy;
    readonly explicitEffect: PolicyEffect | null;
  } | null,
): PermissionState | null {
  if (binding === null) return "block";
  if (binding.explicitEffect !== null) return stateFromEffect(binding.explicitEffect);
  return binding.defaultPolicy === "ALL" ? "auto_allow" : "block";
}

/**
 * Tier 4: the caller's own session overrides.
 *
 * An exact key wins over a pattern, and among patterns the FIRST match in
 * insertion order wins. That is the source's behaviour and it is left alone:
 * a session override is a per-call convenience a caller wrote seconds ago, and
 * making it obey a different precedence rule from the one the author typed
 * would be a surprise in the one tier a human is watching in real time.
 */
export function sessionOpinion(
  overrides: Readonly<Record<string, PermissionState>> | null,
  toolName: string,
): PermissionState | null {
  if (overrides === null) return null;
  const exact = overrides[toolName];
  if (exact !== undefined) return exact;
  for (const [pattern, state] of Object.entries(overrides)) {
    if (matchesPattern(pattern, toolName)) return state;
  }
  return null;
}

/**
 * Compose the four opinions into one decision.
 *
 * A `block` returns IMMEDIATELY at the tier that raised it, before any later
 * tier is consulted. The composed answer would be identical — `block` is the
 * top of the lattice — but the reported tier would not, and "org-policy block"
 * and "session-override block" send an operator to two different places.
 *
 * When nothing blocks, the reported tier is the LAST one holding the winning
 * state. With several tiers agreeing on `require_approval`, the last is the
 * most proximate to the caller and is the one whose configuration they can
 * actually change.
 *
 * THE ADMIN ESCALATION IS ONE CONDITION, NOT THE SOURCE'S TWO. The source
 * fires when `state !== "block" && (isMutating || platform ===
 * "require_approval") && state !== "require_approval"`, which leaves `state ===
 * "auto_allow"` as the only surviving case — and `platform ===
 * "require_approval"` cannot hold there, because tier 1 participates in the
 * composition that produced `state`. The second disjunct is dead code in the
 * source and is not reproduced. What IS reproduced is the rule it protects:
 * an admin token gets extra friction on mutating tools and none on reads,
 * which is what stopped `platos.whoami` from queueing an approval per call.
 */
export function decidePermission(
  toolName: string,
  opinions: TierOpinions,
  tokenTier: TokenTier = "scope",
): PermissionDecision {
  const ordered: readonly { readonly tier: PermissionTier; readonly state: PermissionState | null; readonly label: string }[] = [
    { tier: 1, state: opinions.platform, label: "platform-tier" },
    { tier: 2, state: opinions.organization, label: "org-policy" },
    { tier: 3, state: opinions.agent, label: "agent-policy" },
    { tier: 4, state: opinions.session, label: "session-override" },
  ];

  for (const entry of ordered) {
    if (entry.state === "block") {
      return { state: "block", tier: entry.tier, reason: `${entry.label} block` };
    }
  }

  const state = mostRestrictive(
    opinions.platform,
    opinions.organization,
    opinions.agent,
    opinions.session,
  );
  let tier: PermissionTier = 1;
  for (const entry of ordered) {
    if (entry.state !== null && stateRank(entry.state) === stateRank(state)) tier = entry.tier;
  }

  if (tokenTier === "admin" && state === "auto_allow" && isMutatingToolName(toolName)) {
    return {
      state: "require_approval",
      tier,
      reason: `tier-${tier} require_approval (admin-token auto-escalate, mutating)`,
    };
  }
  return { state, tier, reason: `tier-${tier} ${state}` };
}

/**
 * Read-only name shapes, transcribed.
 *
 * The bias is CONSERVATIVE IN ONE DIRECTION ONLY: a name matching none of these
 * is treated as mutating. Adding a read pattern here weakens the admin-token
 * escalation for every tool it covers, so the list is suffix- and
 * prefix-anchored rather than substring-matched — `.list` at the end, never
 * `list` anywhere.
 */
const READ_ONLY_PATTERNS: readonly RegExp[] = [
  /\.list$/u,
  /\.list_[a-z_]+$/u,
  /\.get$/u,
  /\.get_[a-z_]+$/u,
  /\.search$/u,
  /\.census$/u,
  /\.whoami$/u,
  /\.list_accessible_scopes$/u,
  /\.test_credentials$/u,
  /\.test$/u,
  /\.validate_handler$/u,
  /^monitoring\./u,
  /^events\.recent$/u,
  /^events\.subscribe$/u,
  /^audit\./u,
  /^tool_calls\./u,
  /^reflection\./u,
  /^macros\.list$/u,
  /^macros\.replay_log$/u,
];

/** True unless the name matches a known read shape. Unknown means mutating. */
export function isMutatingToolName(toolName: string): boolean {
  return !READ_ONLY_PATTERNS.some((pattern) => pattern.test(toolName));
}
