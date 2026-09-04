// Agent routing — the ordered rule list on `agentRouting`, and the resolution
// that reads it.
//
// A connection/app/installation carries a DEFAULT agent plus an optional ORDERED
// rule list that lets one channel fan out to many agents:
//
//   [{ "match": { "type": "channel", "id": "C123ABC" }, "agentId": "..." },
//    { "match": { "type": "prefix",  "value": "ada"   }, "agentId": "..." }]
//
// TWO HALVES, DELIBERATELY ASYMMETRIC, and this is the whole design:
//
//   `normalizeAgentRouting` runs at WRITE time and is STRICT. A malformed rule
//   is rejected with the index that caused it, so an operator learns at the
//   moment of the mistake.
//
//   `resolveAgent` runs at READ time and is TOTAL. It never throws and skips
//   anything it does not recognise, because it runs on the inbound path against
//   a column that may have been written by an older binary, and dropping a
//   customer's message over an unreadable rule is worse than ignoring the rule.
//
// The strict half is what makes the lenient half safe: nothing malformed can be
// stored, so a defensive skip at read time is a compatibility affordance rather
// than a way for a broken table to go unnoticed.
//
// Case sensitivity is settled ONCE, at write time: `prefix` values are stored
// lower-cased so the inbound comparison only has to lower-case the incoming
// side. Two places lower-casing independently is how they drift.

import { err, ok, type Result } from "@platos/kernel";

import { routingInvalid } from "./errors.js";
import type { AgentId } from "./identifiers.js";

/** Hard cap on rules per row. Schema-agnostic; enforced at write time. */
export const MAX_AGENT_ROUTING_RULES = 32;

export type ChannelRoutingMatch =
  | { readonly type: "channel"; readonly id: string }
  | { readonly type: "prefix"; readonly value: string };

export interface ChannelRoutingRule {
  readonly match: ChannelRoutingMatch;
  readonly agentId: AgentId;
}

/** What an inbound message offers the resolver. Nothing more is consulted. */
export interface RoutingSubject {
  /** The platform channel/group/guild-channel id, when the adapter knows one. */
  readonly platformChannelId: string | null;
  readonly text: string;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function readTrimmedString(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

/**
 * Validate and normalize a raw `agentRouting` value into the stored rule shape.
 *
 * Order is preserved — first-match-wins depends on it — and duplicate rules are
 * NOT de-duplicated: an operator may legitimately repeat a match, and silently
 * collapsing rules would change which one wins. Extra keys on a rule or a match
 * are dropped, so the stored table is exactly the shape the resolver reads.
 *
 * This does NOT check that the agents exist: that is the forged-id guard, which
 * needs a port and therefore lives in the application layer. This returns the
 * distinct ids it referenced so that guard has something to check.
 */
export function normalizeAgentRouting(raw: unknown): Result<readonly ChannelRoutingRule[]> {
  if (raw === null || raw === undefined) return ok([]);
  if (!Array.isArray(raw)) return err(routingInvalid("agentRouting must be an array of rules"));
  if (raw.length > MAX_AGENT_ROUTING_RULES) {
    return err(routingInvalid(`agentRouting supports at most ${MAX_AGENT_ROUTING_RULES} rules`));
  }

  const normalized: ChannelRoutingRule[] = [];
  for (const [index, rule] of raw.entries()) {
    if (!isPlainObject(rule)) return err(routingInvalid(`rule[${index}] must be an object`));
    if (!isPlainObject(rule["match"])) return err(routingInvalid(`rule[${index}].match must be an object`));

    const agentId = readTrimmedString(rule["agentId"]);
    if (agentId === "") return err(routingInvalid(`rule[${index}].agentId is required`));

    const match = normalizeMatch(rule["match"], index);
    if (!match.ok) return err(match.error);
    normalized.push({ match: match.value, agentId: agentId as AgentId });
  }
  return ok(normalized);
}

function normalizeMatch(match: Record<string, unknown>, index: number): Result<ChannelRoutingMatch> {
  const type = readTrimmedString(match["type"]).toLowerCase();

  if (type === "channel") {
    const id = readTrimmedString(match["id"]);
    if (id === "") return err(routingInvalid(`rule[${index}].match.id is required for a "channel" rule`));
    return ok({ type: "channel", id });
  }

  if (type === "prefix") {
    const value = readTrimmedString(match["value"]);
    if (value === "") return err(routingInvalid(`rule[${index}].match.value is required for a "prefix" rule`));
    // Canonicalized here, once, so the stored table and the inbound comparison
    // can never disagree about case.
    return ok({ type: "prefix", value: value.toLowerCase() });
  }

  return err(routingInvalid(`rule[${index}].match.type must be "channel" or "prefix"`));
}

/** The distinct agents a rule list references, in first-seen order. */
export function referencedAgentIds(rules: readonly ChannelRoutingRule[]): readonly AgentId[] {
  return [...new Set(rules.map((rule) => rule.agentId))];
}

/**
 * True when `text` is addressed to `value` — `"ada: hi"` or `"@ada hi"`.
 *
 * Leading whitespace is stripped first so an inbound message that arrives
 * indented still routes. Both forms are matched case-insensitively against the
 * already-lower-cased stored value.
 */
export function matchesPrefix(text: string, value: string): boolean {
  const lower = text.replace(/^\s+/u, "").toLowerCase();
  const needle = value.toLowerCase();
  return lower.startsWith(`${needle}:`) || lower.startsWith(`@${needle}`);
}

/**
 * Resolve which agent an inbound message routes to: the first matching rule,
 * else the default.
 *
 * TOTAL by construction — see the header. A rule shape this binary does not
 * understand is skipped, not fatal.
 *
 * Called only on FIRST contact for a channel thread. Once a thread is linked the
 * agent is pinned on the link row, so renaming a rule mid-conversation cannot
 * hand the rest of a conversation to a different agent.
 */
export function resolveAgent(
  rules: readonly ChannelRoutingRule[],
  defaultAgentId: AgentId | null,
  subject: RoutingSubject,
): AgentId | null {
  // Indexed access rather than property access throughout, because a value read
  // back from a JSON column is only TYPED as a rule — it is not known to be one.
  const text = typeof subject.text === "string" ? subject.text : "";
  for (const rule of rules) {
    // Every field is re-checked at runtime even though the TYPE guarantees it.
    // The type describes what the write path stores; this reads a JSON column
    // that an older binary may have written, so the type is a claim about the
    // present and these checks are what make it safe to read the past.
    if (!isPlainObject(rule)) continue;
    const agentId = rule["agentId"];
    if (typeof agentId !== "string" || agentId === "") continue;

    const match = rule["match"];
    if (!isPlainObject(match)) continue;

    if (match["type"] === "channel") {
      const id = match["id"];
      if (typeof id === "string" && id !== "" && subject.platformChannelId === id) return agentId as AgentId;
    } else if (match["type"] === "prefix") {
      const value = match["value"];
      if (typeof value === "string" && value !== "" && matchesPrefix(text, value)) return agentId as AgentId;
    }
  }
  return defaultAgentId;
}

/**
 * The inherited-routing rule for the hosted-app path: an installation's own
 * table overrides its app's, and an EMPTY table is not an override.
 *
 * Emptiness is the distinction that matters. `[]` is what the column defaults
 * to, so treating it as "override with nothing" would silently disable every
 * app-level rule the moment an installation row was created.
 */
export function inheritRouting(
  installationRules: readonly ChannelRoutingRule[],
  appRules: readonly ChannelRoutingRule[],
): readonly ChannelRoutingRule[] {
  return installationRules.length > 0 ? installationRules : appRules;
}
