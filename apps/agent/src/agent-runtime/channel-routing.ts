/**
 * Connect reimagining — agentRouting validation + normalization (ONE source of
 * truth, shared by the channels.* MCP tools, the dashboard REST controller, and
 * the inbound RUNTIME slice).
 *
 * A `PlatosChannelConnection.agentId` is the DEFAULT agent for a channel. The
 * optional `agentRouting` column (`Json?`) is an ORDERED rule list that lets one
 * connection fan out to MANY agents:
 *
 *   [{ "match": { "type": "channel", "id": "C123ABC" }, "agentId": "..." },
 *    { "match": { "type": "prefix",  "value": "ada"   }, "agentId": "..." }]
 *
 * Resolution for an inbound message (RUNTIME slice, not here): FIRST matching
 * rule wins, else `connection.agentId`. A "channel" rule matches the platform
 * channel / group / guild-channel id; a "prefix" rule matches when the message
 * text starts with "<value>:" or "@<value>" (case-insensitive — `value` is
 * stored lower-cased so the inbound comparison only has to lower-case the
 * incoming side).
 *
 * Every rule's `agentId` is validated IN-SCOPE at write time (the same forged-id
 * guard the default `agentId` gets), so a stored routing table can NEVER point
 * at an out-of-scope agent. `agentRouting` is NOT secret — it is returned
 * unredacted by the management surface.
 */

/** Hard cap on rules per connection (schema-agnostic; enforced at write time). */
export const MAX_AGENT_ROUTING_RULES = 32;

/** A single normalized match clause. */
export type ChannelRoutingMatch =
  | { type: "channel"; id: string }
  | { type: "prefix"; value: string };

/** A single normalized routing rule (as stored in `agentRouting`). */
export interface ChannelRoutingRule {
  match: ChannelRoutingMatch;
  agentId: string;
}

/**
 * Minimal scope shape the in-scope agent guard needs — the three scalar axes.
 * Accepts the full `RequestScope` (which is a superset) without importing it,
 * keeping this helper dependency-light for the tools + controller + runtime.
 */
export interface ChannelRoutingScope {
  organizationId: string;
  projectId: string;
  environmentId: string;
}

/** Discriminated result — callers map `ok:false` to their own error shape. */
export type AgentRoutingValidation =
  | { ok: true; rules: ChannelRoutingRule[] }
  | { ok: false; error: string; message: string };

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return !!v && typeof v === "object" && !Array.isArray(v);
}

function fail(message: string, error = "invalid_agent_routing"): AgentRoutingValidation {
  return { ok: false, error, message };
}

/**
 * Validate + normalize a raw `agentRouting` value into the stored rule shape.
 *
 * - Must be an array of at most {@link MAX_AGENT_ROUTING_RULES} rules.
 * - Each rule is `{ match: { type: "channel"|"prefix", ... }, agentId }`:
 *     • `channel` rules require a non-empty `match.id`;
 *     • `prefix`  rules require a non-empty `match.value` (stored lower-cased);
 *     • unknown match types are rejected.
 * - Every distinct `agentId` must belong to `scope` (one batched query, ≤32
 *   ids) — the same forged-id guard applied to the default `agentId`.
 *
 * Order is preserved (first-match-wins depends on it); duplicate rules are NOT
 * de-duplicated. Extra keys on rules / matches are dropped from the normalized
 * output. Callers should invoke this ONLY when they have a value to store —
 * clearing the column (explicit `null`) is handled by the caller, not here.
 */
export async function validateAgentRouting(
  prisma: any,
  scope: ChannelRoutingScope,
  raw: unknown,
): Promise<AgentRoutingValidation> {
  if (!Array.isArray(raw)) {
    return fail("agentRouting must be an array of rules");
  }
  if (raw.length > MAX_AGENT_ROUTING_RULES) {
    return fail(`agentRouting supports at most ${MAX_AGENT_ROUTING_RULES} rules`);
  }

  const normalized: ChannelRoutingRule[] = [];
  const agentIds = new Set<string>();

  for (let i = 0; i < raw.length; i++) {
    const rule = raw[i];
    if (!isPlainObject(rule)) return fail(`rule[${i}] must be an object`);

    const match = rule["match"];
    if (!isPlainObject(match)) return fail(`rule[${i}].match must be an object`);

    const agentIdRaw = rule["agentId"];
    const agentId = typeof agentIdRaw === "string" ? agentIdRaw.trim() : "";
    if (!agentId) return fail(`rule[${i}].agentId is required`);

    const type =
      typeof match["type"] === "string" ? (match["type"] as string).trim().toLowerCase() : "";

    let normMatch: ChannelRoutingMatch;
    if (type === "channel") {
      const idRaw = match["id"];
      const id = typeof idRaw === "string" ? idRaw.trim() : "";
      if (!id) return fail(`rule[${i}].match.id is required for a "channel" rule`);
      normMatch = { type: "channel", id };
    } else if (type === "prefix") {
      const valueRaw = match["value"];
      const value = typeof valueRaw === "string" ? valueRaw.trim() : "";
      if (!value) return fail(`rule[${i}].match.value is required for a "prefix" rule`);
      // Case-insensitive matching at runtime → canonicalize to lower-case so
      // the stored table and the inbound comparison always agree.
      normMatch = { type: "prefix", value: value.toLowerCase() };
    } else {
      return fail(`rule[${i}].match.type must be "channel" or "prefix"`);
    }

    normalized.push({ match: normMatch, agentId });
    agentIds.add(agentId);
  }

  // Forged-id guard — every referenced agent must belong to THIS scope. One
  // batched query covers all distinct ids (≤32), mirroring the default-agentId
  // check in channels.create / channels.update.
  if (agentIds.size > 0) {
    const found = await prisma.platosAgent.findMany({
      where: {
        id: { in: [...agentIds] },
        organizationId: scope.organizationId,
        projectId: scope.projectId,
        environmentId: scope.environmentId,
      },
      select: { id: true },
    });
    const foundSet = new Set((found as Array<{ id: string }>).map((a) => a.id));
    const missing = [...agentIds].filter((id) => !foundSet.has(id));
    if (missing.length > 0) {
      return {
        ok: false,
        error: "unknown_agent_id",
        message: `agentRouting references agent id(s) not in scope: ${missing.join(", ")}`,
      };
    }
  }

  return { ok: true, rules: normalized };
}
