/**
 * Dynamic-executor detection for gateway entities.
 *
 * THE PROBLEM
 *
 * A gateway entity (Walle/Composio, and anything shaped like it) exposes two
 * tools: a SEARCH tool that surfaces thousands of downstream action slugs
 * (`GMAIL_FETCH_EMAILS`, `SLACK_SEND_MESSAGE`, …), and an EXECUTE tool that runs
 * one by slug. Registering each downstream slug as a Platos tool would be
 * absurd, so only the two gateway tools are registered.
 *
 * An LLM that has just been handed a list of slugs will, sooner or later, call
 * one directly instead of wrapping it in the execute tool. `tool-executor` has
 * always had a fallback for this — re-route the unregistered slug through the
 * gateway's execute tool — gated on the entity marking that tool with
 * `"x-dynamic-executor": true` in its registered param schema.
 *
 * WHY IT NEVER FIRED
 *
 * Nothing sets that marker. It appears nowhere but the code that reads it: no
 * docs, no validation, no warning when a gateway-shaped tool lacks it. Walle's
 * `walle_execute_tool` registers with `tool_slug`, `slug`, `arguments`, `args`
 * and `toolkit` — and no marker. So the fallback was dead code and every direct
 * slug call failed with "not found or not enabled for scope".
 *
 * Measured on the live deployment: 13 distinct slugs, 28 failed calls across
 * Slack, Gmail, Google Calendar, Notion and Tavily, over at least three days.
 * Worse than the failures themselves, the error text reads as a permissions
 * problem, so the agent told the operator its Slack connection was broken and
 * sent them off to re-authenticate something that was working fine.
 *
 * THE FIX
 *
 * Keep honouring the explicit marker, but also INFER the executor from its
 * shape. A tool taking a slug parameter plus an arguments object is
 * unmistakably a gateway executor; there is no other reason for that signature.
 * Inference means a correctly-shaped gateway works on registration, with no
 * undocumented opt-in to discover.
 *
 * Pure and dependency-free so the detection rules are unit-testable.
 */

export interface ScopedToolLike {
  toolName: string;
  paramSchema?: unknown;
}

/** Param names a gateway uses for "which downstream tool". */
const SLUG_KEYS = ["tool_slug", "slug", "tool_name", "toolName"];
/** Param names a gateway uses for "the downstream tool's arguments". */
const ARG_KEYS = ["arguments", "args", "params", "parameters"];

function properties(schema: unknown): Record<string, unknown> | null {
  if (!schema || typeof schema !== "object") return null;
  const props = (schema as Record<string, unknown>).properties;
  if (!props || typeof props !== "object" || Array.isArray(props)) return null;
  return props as Record<string, unknown>;
}

/** Explicit opt-in: the documented contract, still authoritative when present. */
export function isExplicitDynamicExecutor(tool: ScopedToolLike): boolean {
  const schema = tool.paramSchema;
  if (!schema || typeof schema !== "object") return false;
  return (schema as Record<string, unknown>)["x-dynamic-executor"] === true;
}

/**
 * Shape inference: a slug parameter AND an arguments object.
 *
 * Both are required. A tool with only a slug-ish string param could be a
 * lookup, a formatter, anything — routing arbitrary calls into it would be
 * worse than the failure it replaces. Demanding the pair keeps this to
 * signatures that can only mean "execute a tool I name at runtime".
 */
export function looksLikeDynamicExecutor(tool: ScopedToolLike): boolean {
  const props = properties(tool.paramSchema);
  if (!props) return false;
  const hasSlug = SLUG_KEYS.some((k) => {
    const p = props[k] as Record<string, unknown> | undefined;
    return !!p && (p.type === undefined || p.type === "string");
  });
  const hasArgs = ARG_KEYS.some((k) => {
    const p = props[k] as Record<string, unknown> | undefined;
    return !!p && (p.type === undefined || p.type === "object");
  });
  return hasSlug && hasArgs;
}

/** The parameter names to use when re-routing through a given executor. */
export function executorParamNames(tool: ScopedToolLike): { slugKey: string; argsKey: string } {
  const props = properties(tool.paramSchema) ?? {};
  return {
    slugKey: SLUG_KEYS.find((k) => k in props) ?? "tool_slug",
    argsKey: ARG_KEYS.find((k) => k in props) ?? "arguments",
  };
}

/**
 * Pick the executor to re-route an unregistered `callTool` through.
 *
 * Explicit markers win over inferred ones. Ties break on tool name so two
 * replicas with the same tool set always choose the same executor — the tool
 * set feeds the cached system prompt, and a nondeterministic pick there would
 * reintroduce the prefix churn the caching work removed.
 */
export function findDynamicExecutor(
  scopedTools: readonly ScopedToolLike[],
  callTool: string,
): ScopedToolLike | null {
  const candidates = scopedTools.filter((t) => t.toolName !== callTool);
  const explicit = candidates
    .filter(isExplicitDynamicExecutor)
    .sort((a, b) => a.toolName.localeCompare(b.toolName));
  if (explicit.length > 0) return explicit[0];
  const inferred = candidates
    .filter(looksLikeDynamicExecutor)
    .sort((a, b) => a.toolName.localeCompare(b.toolName));
  return inferred[0] ?? null;
}

/**
 * A slug the model plausibly took from a gateway search result. Used only to
 * make the error message specific — routing never depends on it.
 */
export function looksLikeGatewaySlug(name: string): boolean {
  return /^[A-Z][A-Z0-9]*(_[A-Z0-9]+)+$/.test(name);
}

/**
 * Error text for a tool that resolved to nothing.
 *
 * The old message — "not found or not enabled for scope org=… project=… env=…" —
 * described a permissions failure, so agents relayed it to users as "your
 * integration is disconnected". For a SCREAMING_SNAKE slug the real cause is
 * almost always that no gateway executor is reachable, which is a different
 * problem with a different fix. Say which one it is.
 */
export function toolNotFoundMessage(
  callTool: string,
  scope: { organizationId: string; projectId: string; environmentId: string },
  hasGateway: boolean,
): string {
  const where = `org=${scope.organizationId} project=${scope.projectId} env=${scope.environmentId}`;
  if (looksLikeGatewaySlug(callTool)) {
    return hasGateway
      ? `"${callTool}" is not a Platos tool — it looks like a gateway tool slug. Call the gateway's execute tool with the slug as a parameter instead of calling "${callTool}" directly.`
      : `"${callTool}" looks like a gateway tool slug, but no gateway execute tool is available in this scope (${where}). This is NOT a broken integration — do not tell the user to reconnect. Either the gateway entity is not linked to this agent, or its tools are disabled.`;
  }
  return `Tool "${callTool}" not found or not enabled for scope ${where}`;
}
