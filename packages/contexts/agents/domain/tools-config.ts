// `AgentVersion.toolsBlockConfig` — the tool layer, and the coercion that keeps
// a picked value from being silently ignored.
//
// THREE INDEPENDENT AXES LIVE IN THIS ONE OBJECT AND THEY ARE NOT SUBSTITUTES.
//
//   `mode`        WHO drives the calling — the parent model directly, a
//                 sub-agent, or an explicit execute step.
//   `toolExposure` WHAT the model may call — every scoped tool as a real schema
//                 (`direct`), or the discovery pair with the tools behind them
//                 (`meta`).
//   `displayMode` HOW MUCH is described in the prompt — full schemas, a
//                 category summary, discovery only, or a pinned hybrid.
//
// Collapsing any two of them would be a behaviour change, so all three are
// modelled and none is derived from another.
//
// THE COERCION IS THE "I PICKED A MODE AND IT WASN'T RESPECTED" BUG. A create
// wizard used to submit `tool-wrapper`, which is not a legal mode: nothing
// validated it, so it was stored raw, ignored at runtime (the only runtime
// branch tests for `sub-agent`), and rendered BLANK in the editor — which made
// re-saving skip the field and the bad value permanent. `normalizeToolCallMode`
// maps it to the mode it plainly meant and any other unknown value to `direct`.
//
// AND THE COERCION ONLY TOUCHES A PATCH THAT CARRIES A MODE. This is the half
// that is easy to get wrong and expensive to get wrong. A partial patch with no
// `mode` key — the Tools tab sending only a display mode — must pass through
// untouched: injecting a default here would, after the shallow merge the update
// path performs, overwrite a stored `sub-agent` with `direct` on every partial
// save. That is the very bug this function exists to fix, re-introduced one
// layer down.

/** The only legal tool-call methods. */
export const TOOL_CALL_MODES = ["direct", "sub-agent", "execute-tool"] as const;
export type ToolCallMode = (typeof TOOL_CALL_MODES)[number];

/** The legacy value the create wizard sent, and what it plainly meant. */
export const LEGACY_TOOL_CALL_MODE = "tool-wrapper";

/** Where an unknown mode lands. */
export const FALLBACK_TOOL_CALL_MODE: ToolCallMode = "direct";

/** How much of the tool layer is described in the prompt each turn. */
export const TOOL_DISPLAY_MODES = ["full", "summary", "meta-tool", "hybrid"] as const;
export type ToolDisplayMode = (typeof TOOL_DISPLAY_MODES)[number];

/** The fallback for an unknown or missing display mode: legacy rows keep theirs. */
export const FALLBACK_DISPLAY_MODE: ToolDisplayMode = "full";

export const TOOL_EXPOSURES = ["direct", "meta"] as const;
export type ToolExposure = (typeof TOOL_EXPOSURES)[number];

export interface ToolPermission {
  readonly requiresApproval?: boolean;
  readonly destructive?: boolean;
}

export interface ToolsBlockConfig {
  readonly mode?: ToolCallMode;
  readonly enabledTools?: readonly string[];
  readonly toolExposure?: ToolExposure;
  readonly perToolPerms?: Readonly<Record<string, ToolPermission>>;
  readonly displayMode?: ToolDisplayMode;
  /** Names pinned in full-schema form when `displayMode` is `hybrid`. */
  readonly pinnedTools?: readonly string[];
  /**
   * The category filter applied BEFORE display-mode routing. Three states, all
   * different: absent means every category, `[]` means none, and a list narrows.
   */
  readonly enabledCategories?: readonly string[] | null;
  readonly categoryDescriptions?: Readonly<Record<string, { readonly description?: string }>>;
  /**
   * Whether every turn must carry an entity list. Absent is not `false`: it is
   * the auto-derive default, under which the runtime mandates the list only when
   * the agent can see more than one entity. Explicit `true`/`false` overrides.
   */
  readonly entityIdsRequired?: boolean;
}

export function isToolCallMode(value: unknown): value is ToolCallMode {
  return typeof value === "string" && (TOOL_CALL_MODES as readonly string[]).includes(value);
}

export function isToolDisplayMode(value: unknown): value is ToolDisplayMode {
  return typeof value === "string" && (TOOL_DISPLAY_MODES as readonly string[]).includes(value);
}

/** A legal mode, or what an illegal one means. Never throws; never widens. */
export function normalizeToolCallMode(value: unknown): ToolCallMode {
  if (isToolCallMode(value)) return value;
  return value === LEGACY_TOOL_CALL_MODE ? "execute-tool" : FALLBACK_TOOL_CALL_MODE;
}

/** The display mode in force, with the source's fallback for anything unknown. */
export function resolveDisplayMode(config: ToolsBlockConfig | null): ToolDisplayMode {
  return isToolDisplayMode(config?.displayMode) ? config.displayMode : FALLBACK_DISPLAY_MODE;
}

/**
 * Normalise a tools-config patch.
 *
 * Returns the input unchanged when it is not an object, or when it carries no
 * `mode` key. See the note at the top: that second condition is a control, not
 * an optimisation.
 */
export function normalizeToolsBlockConfig(config: unknown): unknown {
  if (!config || typeof config !== "object" || Array.isArray(config)) return config;
  const record = config as Record<string, unknown>;
  if (!("mode" in record)) return config;
  if (isToolCallMode(record["mode"])) return config;
  return { ...record, mode: normalizeToolCallMode(record["mode"]) };
}

/**
 * Read a stored column into the typed shape, dropping what cannot be read.
 *
 * A column that is not an object reads as null, which is what the source's
 * "does it have any keys" check amounts to and what lets an agent saved before
 * the tool layer existed still project.
 */
export function readToolsBlockConfig(value: unknown): ToolsBlockConfig | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  const config: Record<string, unknown> = { ...record };
  if ("mode" in record) config["mode"] = normalizeToolCallMode(record["mode"]);
  return Object.keys(config).length === 0 ? null : (config as ToolsBlockConfig);
}
