/**
 * Theme CTX.6 — 4-tier tool-arg resolution.
 *
 * Replaces the raw JSON editor UX (CTX.1/2) with an operator-first auto-mapper:
 *
 *   1. Constant              — operator hardcoded `(toolName, argName) → value`
 *                              on the agent. Injected pre-dispatch, stripped
 *                              from the LLM schema.
 *   2. Session-context override — per-tool or `_global` entry in
 *                              `contextMapping.toolArgInjection` resolves to a
 *                              session key. Injected + stripped.
 *   3. Auto-match            — arg-name aliases match a declared session-context
 *                              key (`userId` ⇄ `user_id` ⇄ `user.id` ⇄ `uid`).
 *                              Runs only when the tool's per-tool block does
 *                              NOT opt out (`_auto: false`). Injected + stripped.
 *   4. LLM fills (default)   — leave the param in the schema. Description passed
 *                              through to `buildLlmHintBlock` for the system
 *                              prompt's "Tool argument expectations" section.
 *
 * Every helper is fail-open: a malformed input drops to {source: "llm"} so a
 * bad config can never break dispatch.
 */

import { resolvePath } from "./context-resolver";

/**
 * Extended shape of the agent's `contextMapping` JSONB column. Backwards-
 * compatible with CTX.1's simpler `{tool: {arg: ctxKey}}` layout — the resolver
 * reads both shapes via `normalizeMappingForTool`.
 */
export interface AgentContextMapping {
  promptVars?: string[];
  envelopeKeys?: string[];
  entityIdsKey?: string;
  /**
   * CTX.6 — which session-context keys the frontend is expected to send.
   * Drives the auto-match suggestion set. Empty / absent → no auto-match.
   */
  declaredKeys?: string[];
  /**
   * Per-tool + `_global` + wrapper layout:
   *   toolArgInjection = {
   *     _global?: { argName → ctxKey },
   *     [toolName]: {
   *       _auto?: boolean,                      // default true
   *       [argName]: string | "LLM" | "CONSTANT:<json>" | ctxKey,
   *     }
   *   }
   *
   * Legacy rows (no `_auto` / `_global` / no `CONSTANT:` prefix) are read as
   * plain `{argName → ctxKey}` mappings — everything just works.
   */
  toolArgInjection?: {
    _global?: Record<string, string>;
    [toolName: string]: Record<string, string | undefined | boolean> | Record<string, string> | undefined;
  };
  /**
   * CTX.6 — hardcoded fixed values. `constants[toolName][argName] = any JSON`.
   * Takes priority over every other source.
   */
  constants?: Record<string, Record<string, unknown>>;
}

export type ParamResolution =
  | { source: "constant"; value: unknown }
  | { source: "session"; key: string; reason: "override" | "global" | "auto" }
  | { source: "llm"; description?: string; required?: boolean };

export interface ResolvedToolParam {
  name: string;
  resolution: ParamResolution;
  required: boolean;
}

export interface ResolvedTool {
  toolName: string;
  params: ResolvedToolParam[];
  warnings: string[];
}

/**
 * Produce canonical aliases for an arg / key name. Every alias is lower-cased
 * and stripped of non-alphanumeric separators so `userId`, `user_id`, `user-id`,
 * `USER.ID`, `uid` all collide into the same bucket. Called on BOTH sides of
 * the auto-match (declared keys + param names).
 *
 * Returns the full alias set — callers intersect them to detect a match.
 */
export function nameAliases(name: string): string[] {
  if (typeof name !== "string" || name.length === 0) return [];
  const out = new Set<string>();
  const lower = name.toLowerCase();
  out.add(lower);

  // Strip common separators → "userid"
  const stripped = lower.replace(/[._\-\s]+/g, "");
  if (stripped) out.add(stripped);

  // snake_case ⇄ kebab-case ⇄ dotted
  out.add(lower.replace(/[._-]/g, "_"));
  out.add(lower.replace(/[._-]/g, "-"));
  out.add(lower.replace(/[._-]/g, "."));

  // camelCase → snake_case: "userId" → "user_id"
  const camelToSnake = name
    .replace(/([a-z0-9])([A-Z])/g, "$1_$2")
    .toLowerCase();
  out.add(camelToSnake);
  out.add(camelToSnake.replace(/_/g, ""));
  out.add(camelToSnake.replace(/_/g, "."));

  // Well-known short forms
  const shortForms: Record<string, string[]> = {
    userid: ["uid", "user"],
    tenantid: ["tid", "tenant"],
    organizationid: ["orgid", "org"],
    accountid: ["aid", "account"],
  };
  const shortKey = stripped;
  if (shortKey && shortForms[shortKey]) {
    for (const s of shortForms[shortKey]) out.add(s);
  }
  // Reverse mapping — e.g. "uid" → "userid"
  for (const [canonical, shorts] of Object.entries(shortForms)) {
    if (shorts.includes(stripped)) out.add(canonical);
  }

  return Array.from(out);
}

/**
 * True when two names share ANY alias. Case-insensitive + separator-insensitive.
 */
function aliasMatch(a: string, b: string): boolean {
  const aSet = new Set(nameAliases(a));
  for (const bAlias of nameAliases(b)) {
    if (aSet.has(bAlias)) return true;
  }
  return false;
}

/**
 * Read per-tool config tolerating both the CTX.6 wrapper shape and the
 * CTX.1 flat shape. Returns `{auto, overrides}` where `overrides` is a flat
 * `{argName: string}` map (minus control keys like `_auto`).
 */
function normalizeMappingForTool(
  toolArgInjection: AgentContextMapping["toolArgInjection"] | undefined,
  toolName: string,
): { auto: boolean; overrides: Record<string, string> } {
  const out: { auto: boolean; overrides: Record<string, string> } = {
    auto: true,
    overrides: {},
  };
  if (!toolArgInjection || typeof toolArgInjection !== "object") return out;
  const raw = (toolArgInjection as Record<string, unknown>)[toolName];
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return out;
  for (const [k, v] of Object.entries(raw as Record<string, unknown>)) {
    if (k === "_auto") {
      if (typeof v === "boolean") out.auto = v;
      continue;
    }
    if (typeof v === "string") out.overrides[k] = v;
  }
  return out;
}

function readGlobal(
  toolArgInjection: AgentContextMapping["toolArgInjection"] | undefined,
): Record<string, string> {
  if (!toolArgInjection || typeof toolArgInjection !== "object") return {};
  const g = (toolArgInjection as Record<string, unknown>)._global;
  if (!g || typeof g !== "object" || Array.isArray(g)) return {};
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(g as Record<string, unknown>)) {
    if (typeof v === "string") out[k] = v;
  }
  return out;
}

/**
 * Parse a `CONSTANT:<encoded>` override. Accepts either raw JSON
 * (`CONSTANT:{"x":1}`) or a bare string (`CONSTANT:hello` → `"hello"`). Returns
 * `undefined` if the marker isn't present.
 */
function parseConstantOverride(raw: string): { hit: boolean; value?: unknown } {
  if (!raw.startsWith("CONSTANT:")) return { hit: false };
  const rest = raw.slice("CONSTANT:".length);
  try {
    return { hit: true, value: JSON.parse(rest) };
  } catch {
    return { hit: true, value: rest };
  }
}

interface JsonSchemaLike {
  type?: string;
  properties?: Record<string, unknown>;
  required?: unknown;
  [k: string]: unknown;
}

interface ParamDescriptor {
  name: string;
  description?: string;
  required: boolean;
  isScalar: boolean;
}

/**
 * Pull top-level scalar params off a JSON Schema. Nested objects / oneOf /
 * anyOf currently drop to LLM fill (see scope note in the PRD) — we tag them
 * as non-scalar so the auto-match loop skips them. TODO(CTX.6.1).
 */
function enumerateParams(schema: unknown): ParamDescriptor[] {
  if (!schema || typeof schema !== "object") return [];
  const s = schema as JsonSchemaLike;
  if (!s.properties || typeof s.properties !== "object") return [];
  const requiredSet = new Set<string>(
    Array.isArray(s.required)
      ? (s.required as unknown[]).filter((x): x is string => typeof x === "string")
      : [],
  );
  const out: ParamDescriptor[] = [];
  for (const [name, rawSchema] of Object.entries(s.properties)) {
    const propSchema = (rawSchema ?? {}) as Record<string, unknown>;
    const description =
      typeof propSchema.description === "string" ? propSchema.description : undefined;
    // Scalar detection: explicit scalar types OR "enum" (always scalar) OR
    // `oneOf/anyOf` of scalars. We play it safe: auto-match ONLY if the top
    // level is string/number/boolean/integer. Objects/arrays drop to LLM
    // fill regardless of mapping intent.
    const t = propSchema.type;
    const isScalar =
      t === "string" || t === "number" || t === "integer" || t === "boolean" ||
      (Array.isArray(t) && t.every((x) => x === "string" || x === "number" || x === "integer" || x === "boolean" || x === "null")) ||
      Array.isArray(propSchema.enum);
    out.push({
      name,
      description,
      required: requiredSet.has(name),
      isScalar,
    });
  }
  return out;
}

/**
 * Main resolver — returns per-param resolution for one tool.
 *
 * Signature deliberately takes raw `{name, inputSchema}` so callers can
 * resolve against either the registry's `paramSchema` (JSON Schema) or a
 * Zod-derived schema that's been serialized. Both live in the codebase.
 */
export function resolveToolMappings(
  tool: { name: string; inputSchema: unknown },
  agentConfig: { contextMapping?: AgentContextMapping | null | undefined },
  sessionContext: Record<string, unknown> | null | undefined,
): ResolvedTool {
  const warnings: string[] = [];
  const paramList = enumerateParams(tool.inputSchema);
  const mapping = agentConfig.contextMapping ?? undefined;
  const constants = mapping?.constants?.[tool.name];
  const { auto: autoEnabled, overrides: perTool } = normalizeMappingForTool(
    mapping?.toolArgInjection,
    tool.name,
  );
  const globalOverrides = readGlobal(mapping?.toolArgInjection);
  const declaredKeys = Array.isArray(mapping?.declaredKeys)
    ? mapping!.declaredKeys!.filter((k): k is string => typeof k === "string")
    : [];

  const params: ResolvedToolParam[] = paramList.map((p) => {
    // 1. CONSTANT — direct entry wins outright.
    if (constants && p.name in constants) {
      return {
        name: p.name,
        required: p.required,
        resolution: { source: "constant", value: constants[p.name] },
      };
    }
    // 2a. Per-tool override. `"LLM"` marker = explicit opt-out of auto-match.
    //     `"CONSTANT:<json>"` → inline constant (alternative to the `constants` block).
    if (p.name in perTool) {
      const raw = perTool[p.name];
      if (raw === "LLM") {
        return {
          name: p.name,
          required: p.required,
          resolution: { source: "llm", description: p.description, required: p.required },
        };
      }
      const konst = parseConstantOverride(raw);
      if (konst.hit) {
        return {
          name: p.name,
          required: p.required,
          resolution: { source: "constant", value: konst.value },
        };
      }
      return {
        name: p.name,
        required: p.required,
        resolution: { source: "session", key: raw, reason: "override" },
      };
    }
    // 2b. `_global` override.
    if (p.name in globalOverrides) {
      return {
        name: p.name,
        required: p.required,
        resolution: {
          source: "session",
          key: globalOverrides[p.name],
          reason: "global",
        },
      };
    }
    // 3. Auto-match — alias walk over declaredKeys. Scalar top-level only.
    if (autoEnabled && p.isScalar && declaredKeys.length > 0) {
      for (const declared of declaredKeys) {
        // Compare the declared key's LEAF token (`user.id` → `id`) plus the
        // full dotted form so `{userId}` matches `user.id`.
        const leaf = declared.split(".").pop() || declared;
        if (
          aliasMatch(p.name, declared) ||
          aliasMatch(p.name, leaf) ||
          aliasMatch(p.name, declared.replace(/\./g, "_"))
        ) {
          // Only count as a match if the key ALSO exists in sessionContext —
          // otherwise the runtime would strip the arg and leave the backend
          // with nothing. declared-but-missing is a no-op (LLM fills).
          if (sessionContext && resolvePath(sessionContext, declared) !== undefined) {
            return {
              name: p.name,
              required: p.required,
              resolution: {
                source: "session",
                key: declared,
                reason: "auto",
              },
            };
          }
        }
      }
    }
    // 4. Default → LLM fills. Warn when a required arg has no description.
    if (p.required && (!p.description || p.description.trim().length === 0)) {
      warnings.push(
        `required arg \`${p.name}\` is LLM-fill but has no description in schema`,
      );
    }
    return {
      name: p.name,
      required: p.required,
      resolution: { source: "llm", description: p.description, required: p.required },
    };
  });

  return { toolName: tool.name, params, warnings };
}

/**
 * Produce the schema the LLM should see — strip every param resolved to
 * constant/session. Returns the input schema unchanged when nothing strips
 * (the vast majority case for a freshly-installed agent).
 */
export function stripResolvedArgs(
  schema: unknown,
  resolved: ResolvedTool,
): unknown {
  if (!schema || typeof schema !== "object") return schema;
  const toStrip = new Set(
    resolved.params
      .filter((p) => p.resolution.source === "constant" || p.resolution.source === "session")
      .map((p) => p.name),
  );
  if (toStrip.size === 0) return schema;
  const s = schema as JsonSchemaLike;
  if (!s.properties || typeof s.properties !== "object") return schema;
  const nextProps: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(s.properties)) {
    if (!toStrip.has(k)) nextProps[k] = v;
  }
  const nextRequired = Array.isArray(s.required)
    ? (s.required as unknown[]).filter(
        (r) => typeof r !== "string" || !toStrip.has(r),
      )
    : s.required;
  return { ...s, properties: nextProps, required: nextRequired };
}

/**
 * Apply resolutions to an actual tool-call args object before dispatch.
 * - `constant` → injected directly.
 * - `session`  → resolved from sessionContext; undefined result fails open
 *                (skip — the entity will see a missing arg).
 * - `llm`      → left in place (or absent if the LLM didn't provide it).
 *
 * Caller args WIN over resolutions for LLM-fill params (trivially — we don't
 * override) but LOSE to `constant`/`session`: the agent owner's explicit
 * binding is authoritative.
 */
export function applyResolutions(
  resolved: ResolvedTool,
  toolCallArgs: Record<string, unknown> | undefined,
  sessionContext: Record<string, unknown> | null | undefined,
): Record<string, unknown> {
  const out: Record<string, unknown> = { ...(toolCallArgs ?? {}) };
  for (const p of resolved.params) {
    const r = p.resolution;
    if (r.source === "constant") {
      out[p.name] = r.value;
      continue;
    }
    if (r.source === "session") {
      if (sessionContext == null) continue; // fail-open
      const v = resolvePath(sessionContext, r.key);
      if (v === undefined) continue;
      out[p.name] = v;
      continue;
    }
    // LLM fills — leave whatever the caller put there.
  }
  return out;
}

/**
 * Build the "Tool argument expectations" system-prompt block. Cache-friendly:
 * append-only, same for every turn sharing the same agent config + tool set
 * + sessionContext key-set (value changes don't shift the block).
 *
 * Only surfaces args in bucket #4 (LLM fills) — nothing useful to say about
 * args the runtime is injecting.
 */
export function buildLlmHintBlock(resolvedTools: ResolvedTool[]): string {
  const lines: string[] = [];
  for (const rt of resolvedTools) {
    const llmParams = rt.params.filter((p) => p.resolution.source === "llm");
    if (llmParams.length === 0) continue;
    lines.push(`### ${rt.toolName}`);
    for (const p of llmParams) {
      const r = p.resolution as { source: "llm"; description?: string };
      const reqTag = p.required ? " (required)" : "";
      const desc = r.description?.trim();
      lines.push(
        desc ? `- \`${p.name}\`${reqTag}: ${desc}` : `- \`${p.name}\`${reqTag}: (no description)`,
      );
    }
    lines.push("");
  }
  if (lines.length === 0) return "";
  return [
    "## Tool argument expectations",
    "",
    "When you call a tool, you are responsible for providing these arguments. Other arguments are injected automatically and must NOT appear in your tool-call params.",
    "",
    ...lines,
  ]
    .join("\n")
    .trimEnd();
}
