/**
 * Tool exposure — how an agent's connected-entity tools reach the model.
 *
 * THE PROBLEM THIS EXISTS TO FIX
 *
 * Platos had three tool-related config fields and none of them answered the
 * only question that matters — *what can the model actually call?*
 *
 *   toolsBlockConfig.mode        who drives the calling (parent / sub-agent /
 *                                minimal). All three still route through
 *                                execute_tools.
 *   toolsBlockConfig.displayMode how much gets DESCRIBED in the system prompt
 *                                (full / summary / meta-tool / hybrid).
 *   metaTools.*                  which individual meta-tools are on.
 *
 * The answer was hardcoded: the model got meta-tools plus skill tools, and
 * connected-entity tools were never injected as callable schemas. They lived
 * exclusively behind `execute_tools`. The code says so in two places, and the
 * one that would have built it is marked "a Block 2 polish later".
 *
 * That produced DOUBLE META-TOOL INDIRECTION for any agent whose entity is
 * itself a gateway. Walle's MCP server already exposes a discover/execute pair
 * (`walle_search_tools` / `walle_execute_tool`); Platos wrapped a second,
 * near-identical pair around it. To send one Slack message the model had to
 * emit three nested levels:
 *
 *   execute_tools({ tool: "walle_execute_tool",
 *                   params: { tool_slug: "SLACK_SEND_MESSAGE", arguments: {…} } })
 *
 * Models collapse the middle level. Measured on the live deployment: 28 failed
 * calls across 13 slugs and FIVE different models from four providers — so it
 * is not a weak-model problem, it is the shape of the interface.
 *
 * THE FIX
 *
 * One control that answers the real question:
 *
 *   "meta"   — inject find_tools + execute_tools; entity tools stay behind
 *              them. Today's behaviour, and the default, so nothing changes
 *              for an agent that does not opt in.
 *   "direct" — inject every scoped entity tool as a real schema and drop
 *              find_tools/execute_tools. The model sees its tools and picks.
 *
 * CONTEXT TOOLS ARE NOT META-TOOLS. Memory, profile, artifacts, schedules and
 * approvals are directly-exposed capabilities in BOTH modes, governed by their
 * own `metaTools` ticks. Only find_tools/execute_tools are meta-tools. The old
 * naming lumped them together, which is why "execute-tool mode" once stripped
 * an agent's memory as a side effect.
 */

export type ToolExposure = "direct" | "meta";

/** The only two genuine meta-tools. Everything else is a context tool. */
export const META_TOOL_NAMES = ["find_tools", "execute_tools"] as const;

/**
 * Resolve the exposure mode from an agent's toolsBlockConfig.
 *
 * Defaults to "meta" — the pre-existing behaviour — so an agent that has never
 * been touched keeps working exactly as before. Direct exposure is opt-in.
 */
export function resolveToolExposure(toolsBlockConfig: unknown): ToolExposure {
  if (!toolsBlockConfig || typeof toolsBlockConfig !== "object") return "meta";
  const raw = (toolsBlockConfig as Record<string, unknown>).toolExposure;
  return raw === "direct" ? "direct" : "meta";
}

/** True when this tool name is one of the two meta-tools. */
export function isMetaTool(name: string): boolean {
  return (META_TOOL_NAMES as readonly string[]).includes(name);
}

export interface ExposableTool {
  toolName: string;
  description: string;
  paramSchema: Record<string, unknown>;
}

/**
 * Choose and order the entity tools to inject in direct mode.
 *
 * Sorted by name, always. These schemas land in the `tools` block, which sits
 * AHEAD of the system prompt in Anthropic's cache prefix — so a nondeterministic
 * order would invalidate the tool definitions, the system prompt, and every
 * cached message behind them, on every turn. The registry's own iteration order
 * is Postgres heap order perturbed by live registration, i.e. exactly the
 * nondeterminism that must not reach this list.
 *
 * De-duplicated by name: two entities can publish the same tool name, and
 * emitting a duplicate key would silently drop one while still costing tokens.
 */
export function selectDirectTools<T extends ExposableTool>(tools: readonly T[]): T[] {
  const byName = new Map<string, T>();
  for (const t of tools) {
    if (!t?.toolName) continue;
    if (!byName.has(t.toolName)) byName.set(t.toolName, t);
  }
  return Array.from(byName.values()).sort((a, b) => a.toolName.localeCompare(b.toolName));
}

/**
 * A JSON Schema safe to hand the AI SDK.
 *
 * Entity-published schemas are arbitrary JSON from an external service and are
 * regularly missing `type`/`properties`, or are a bare `{}`. The SDK requires an
 * object schema; anything else throws at tool-registration time and takes the
 * WHOLE TURN down — one malformed tool from one entity would break every agent
 * that can see it. Coerce instead, so a bad schema costs its own tool and
 * nothing else.
 */
export function normaliseParamSchema(schema: unknown): Record<string, unknown> {
  if (!schema || typeof schema !== "object" || Array.isArray(schema)) {
    return { type: "object", properties: {} };
  }
  const s = { ...(schema as Record<string, unknown>) };
  if (s.type !== "object") s.type = "object";
  if (!s.properties || typeof s.properties !== "object" || Array.isArray(s.properties)) {
    s.properties = {};
  }
  return s;
}

/**
 * Describe direct mode for the system prompt.
 *
 * Deliberately short and byte-stable — it lands in the cached prefix, so it must
 * not carry counts or names that move when the registry changes. (An earlier
 * block embedded live per-category tool counts and invalidated the prefix every
 * time an integration published a tool.)
 */
export function directModeSystemNote(): string {
  return [
    "## Tools",
    "",
    "Every tool you can use is listed in your tool definitions — call them directly by name.",
    "There is no discovery step and no execute wrapper: if a tool is not in your list, you do not have it.",
  ].join("\n");
}
