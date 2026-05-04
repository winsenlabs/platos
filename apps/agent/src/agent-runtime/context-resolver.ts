/**
 * Theme CTX.2 — session-context runtime auto-injection helpers.
 *
 * These utilities interpret the agent's `contextMapping` config against
 * the thread's `sessionContext` bag at turn time and apply four roles:
 *
 *   1. prompt substitution  → `{{user.name}}` style template vars.
 *   2. tool arg injection   → silently inject + strip args so the LLM
 *                             never sees them.
 *   3. tool-matrix routing  → filter the visible tool matrix by a
 *                             caller-declared `entity_ids` list.
 *   4. WS envelope          → attach a `_context` object on outgoing
 *                             tool-call frames.
 *
 * Every helper is fail-open: absent `sessionContext` OR absent
 * `contextMapping` → existing behavior, never throws.
 */

/**
 * Per-agent declaration of which keys in `PlatosAgentThread.sessionContext`
 * play which runtime role. Mirrors the JSONB shape in
 * `PlatosAgent.contextMapping` (CTX.1).
 */
export interface ContextMapping {
  /** Keys whose values get substituted into `{{...}}` prompt placeholders. */
  promptVars?: string[];
  /**
   * Per-tool arg-name → context-key mapping. At dispatch time, each declared
   * arg is resolved from sessionContext and injected into `params` before
   * the call reaches the entity backend; the same argName is stripped from
   * the JSON Schema the LLM sees so it never hallucinates the value.
   *
   * CTX.6 extends the shape: inner maps MAY contain a `_auto: boolean` flag
   * and the outer map MAY contain a `_global: Record<string, string>` bucket.
   * Values that aren't strings get filtered off here (they're parsed by the
   * CTX.6 context-automap resolver directly, which reads the same raw
   * `PlatosAgent.contextMapping` JSON). Backwards-compatible with CTX.2.
   */
  toolArgInjection?: Record<string, Record<string, string>>;
  /** Keys copied into the outgoing WS `_context` envelope. */
  envelopeKeys?: string[];
  /**
   * Name of the sessionContext key whose value (`string[]`) narrows the
   * tool matrix. Defaults to `"entity_ids"`.
   */
  entityIdsKey?: string;
  /**
   * CTX.6 — session-context keys the frontend is expected to send. Drives
   * the auto-match suggestion set in the resolver + "Tools" tab UI.
   */
  declaredKeys?: string[];
  /**
   * CTX.6 — hardcoded fixed values keyed by toolName → argName → JSON value.
   * Takes priority over session-context overrides + auto-match.
   */
  constants?: Record<string, Record<string, unknown>>;
}

/**
 * Dotted-key lookup on an arbitrary nested object — `resolvePath(ctx, "user.id")`
 * walks `ctx.user.id`, with bracket-less numeric segments treated as array
 * indices (`resolvePath(ctx, "roles.0")` → `ctx.roles[0]`).
 *
 * Fail-open on every miss: undefined intermediate, wrong type, missing key
 * all return `undefined`. Never throws.
 */
export function resolvePath(ctx: unknown, key: string): unknown {
  if (ctx == null || typeof key !== "string" || key.length === 0) return undefined;
  // Flat-key fallback first: if the context has a literal key "user.name" that
  // matches the full dotted template key, return it directly. This lets Postman
  // callers use either flat keys ("user.name": "Tejas") or nested objects
  // ({ user: { name: "Tejas" } }) interchangeably.
  if (typeof ctx === "object" && !Array.isArray(ctx)) {
    const flat = (ctx as Record<string, unknown>)[key];
    if (flat !== undefined) return flat;
  }
  const segments = key.split(".");
  return segments.reduce<unknown>((acc, segment) => {
    if (acc == null) return undefined;
    if (typeof acc !== "object") return undefined;
    // Arrays: numeric segment → index lookup.
    if (Array.isArray(acc)) {
      const idx = Number(segment);
      if (!Number.isInteger(idx) || idx < 0) return undefined;
      return (acc as unknown[])[idx];
    }
    return (acc as Record<string, unknown>)[segment];
  }, ctx);
}

/**
 * Role 3 — tool-matrix routing.
 *
 * If `entityIds` is a non-empty array, return the subset of tools whose
 * `sourceEntityId` is in that list (union semantics across multiple ids).
 * Empty array / missing / non-array → pass through untouched.
 */
export function filterByEntityIds<T extends { sourceEntityId: string }>(
  tools: T[],
  entityIds: unknown,
): T[] {
  if (!Array.isArray(entityIds) || entityIds.length === 0) return tools;
  const allow = new Set<string>();
  for (const e of entityIds) {
    if (typeof e === "string" && e.length > 0) allow.add(e);
  }
  if (allow.size === 0) return tools;
  return tools.filter((t) => allow.has(t.sourceEntityId));
}

/**
 * Role 2a — strip injected args from a JSON Schema (or Zod-like schema
 * object serialised to JSON Schema) so the LLM never sees them.
 *
 * Works on the shape produced by `zod-to-json-schema` / raw JSON Schema:
 *   { type: "object", properties: {...}, required: [...] }
 *
 * Fail-open: schema lacking `.properties` is returned unchanged.
 */
export function stripInjectedArgs(
  schema: unknown,
  mapping: Record<string, string> | undefined,
): unknown {
  if (!mapping || Object.keys(mapping).length === 0) return schema;
  if (!schema || typeof schema !== "object") return schema;
  const s = schema as {
    properties?: Record<string, unknown>;
    required?: unknown;
    [k: string]: unknown;
  };
  if (!s.properties || typeof s.properties !== "object") return schema;

  const injectedArgs = new Set(Object.keys(mapping));
  const nextProperties: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(s.properties)) {
    if (!injectedArgs.has(k)) nextProperties[k] = v;
  }
  const nextRequired = Array.isArray(s.required)
    ? (s.required as unknown[]).filter(
        (r) => typeof r !== "string" || !injectedArgs.has(r),
      )
    : s.required;

  return { ...s, properties: nextProperties, required: nextRequired };
}

/**
 * Role 2b — inject resolved context values into a tool-call params object
 * before dispatch. Missing keys are silent no-ops (fail-open).
 *
 * Caller-supplied params WIN over injected ones — the LLM is allowed to
 * override if it somehow surfaces the arg name (e.g. a schema-stripping
 * edge case on a non-JSON-Schema tool definition).
 */
export function injectArgs(
  params: Record<string, unknown> | undefined,
  mapping: Record<string, string> | undefined,
  ctx: unknown,
): Record<string, unknown> {
  const base: Record<string, unknown> = { ...(params ?? {}) };
  if (!mapping || Object.keys(mapping).length === 0) return base;
  if (ctx == null) return base;
  for (const [argName, ctxKey] of Object.entries(mapping)) {
    if (argName in base) continue; // caller already provided — don't clobber
    const value = resolvePath(ctx, ctxKey);
    if (value === undefined) continue; // fail-open on miss
    base[argName] = value;
  }
  return base;
}

/**
 * Role 4 — build the outgoing WS `_context` envelope from a whitelist
 * of sessionContext keys. Keys are stored verbatim in the envelope (the
 * entity backend reads them via `_context["user.id"]` style access) so
 * downstream integrators get the same shape the mapping declared.
 *
 * Returns `undefined` when there is nothing to send — callers can
 * conditionally spread the result and avoid emitting an empty object.
 */
export function buildEnvelope(
  ctx: unknown,
  keys: string[] | undefined,
): Record<string, unknown> | undefined {
  if (!Array.isArray(keys) || keys.length === 0) return undefined;
  if (ctx == null) return undefined;
  const out: Record<string, unknown> = {};
  for (const key of keys) {
    if (typeof key !== "string" || key.length === 0) continue;
    const value = resolvePath(ctx, key);
    if (value === undefined) continue;
    out[key] = value;
  }
  return Object.keys(out).length > 0 ? out : undefined;
}

/**
 * Role 1 — prompt substitution. Supports:
 *   {{user.name}}          → dotted-key lookup on sessionContext
 *   {{custom.greeting}}    → same
 *
 * Unresolved placeholders are left as-is (matches existing
 * PromptBuilderService.renderTemplate behavior). Fail-open.
 */
export function substitutePromptVars(
  text: string,
  ctx: unknown,
  promptVars: string[] | undefined,
): string {
  if (typeof text !== "string" || text.length === 0) return text;
  if (!ctx || typeof ctx !== "object") return text;
  // promptVars declares which keys are ALLOWED to substitute. When omitted,
  // every dotted key from sessionContext is eligible (matches the Theme CTX
  // brief's "free-form" framing) — keeps behavior intuitive without forcing
  // every agent config to enumerate allowed keys.
  const allow =
    Array.isArray(promptVars) && promptVars.length > 0
      ? new Set(promptVars)
      : null;
  return text.replace(
    /\{\{\s*([a-zA-Z_][a-zA-Z0-9_.]*)\s*\}\}/g,
    (match, key: string) => {
      if (allow && !allow.has(key)) return match;
      const value = resolvePath(ctx, key);
      if (value === undefined) return match;
      return typeof value === "string" ? value : String(value);
    },
  );
}

/**
 * Narrow an unknown JSON value into a ContextMapping. Accepts a loose shape
 * + strips fields of the wrong type so malformed rows never crash the
 * runtime. Returns `null` if the input isn't an object at all.
 */
export function normalizeContextMapping(raw: unknown): ContextMapping | null {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const r = raw as Record<string, unknown>;
  const out: ContextMapping = {};
  if (Array.isArray(r.promptVars)) {
    out.promptVars = r.promptVars.filter((v): v is string => typeof v === "string");
  }
  if (
    r.toolArgInjection &&
    typeof r.toolArgInjection === "object" &&
    !Array.isArray(r.toolArgInjection)
  ) {
    const tai: Record<string, Record<string, string>> = {};
    for (const [toolName, argMap] of Object.entries(
      r.toolArgInjection as Record<string, unknown>,
    )) {
      if (!argMap || typeof argMap !== "object" || Array.isArray(argMap)) continue;
      const inner: Record<string, string> = {};
      for (const [argName, ctxKey] of Object.entries(
        argMap as Record<string, unknown>,
      )) {
        // CTX.6 — skip control keys (`_auto` booleans). CTX.6 resolver reads
        // them directly off the raw column; the CTX.2 flat shape used by
        // downstream helpers only wants {argName: string}.
        if (argName === "_auto") continue;
        if (typeof ctxKey === "string") inner[argName] = ctxKey;
      }
      if (Object.keys(inner).length > 0) tai[toolName] = inner;
    }
    if (Object.keys(tai).length > 0) out.toolArgInjection = tai;
  }
  if (Array.isArray(r.envelopeKeys)) {
    out.envelopeKeys = r.envelopeKeys.filter(
      (v): v is string => typeof v === "string",
    );
  }
  if (typeof r.entityIdsKey === "string" && r.entityIdsKey.length > 0) {
    out.entityIdsKey = r.entityIdsKey;
  }
  // CTX.6 — pass through declaredKeys + constants after light validation.
  if (Array.isArray(r.declaredKeys)) {
    out.declaredKeys = r.declaredKeys.filter((v): v is string => typeof v === "string");
  }
  if (
    r.constants &&
    typeof r.constants === "object" &&
    !Array.isArray(r.constants)
  ) {
    const constants: Record<string, Record<string, unknown>> = {};
    for (const [toolName, argMap] of Object.entries(
      r.constants as Record<string, unknown>,
    )) {
      if (!argMap || typeof argMap !== "object" || Array.isArray(argMap)) continue;
      constants[toolName] = argMap as Record<string, unknown>;
    }
    if (Object.keys(constants).length > 0) out.constants = constants;
  }
  return out;
}
