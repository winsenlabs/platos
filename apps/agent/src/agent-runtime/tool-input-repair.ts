/**
 * WORKSTREAM C — tolerant parsing of stringified tool-call params.
 *
 * WHY (real production evidence, same trace as the caching work)
 * -------------------------------------------------------------
 * Trace `0adb2b4070f540634d5f610f3f1bbca0`: three CONSECUTIVE tool calls failed
 * with `AI_InvalidToolInputError` / `AI_JSONParseError` because the model
 * emitted `execute_tools`'s `calls` parameter as a JSON-encoded STRING instead
 * of an array:
 *
 *     { "calls": "[{\"tool\": \"GMAIL_SEND_EMAIL\", \"params\": {\"body\": \"a\\nb\"}}]" }
 *
 * The trigger is doubly-nested JSON containing multi-line string content (email
 * bodies with \n): the model escapes its way into emitting the inner array as a
 * string. Each rejection cost a FULL-PRICE 100k+ token LLM step before the
 * model happened to recover, so a formatting slip was billing like real work.
 *
 * This repairs the call in-place at the SDK's `repairToolCall` hook, which means
 * ZERO extra LLM round-trips (the alternative — asking the model to try again —
 * is exactly the expensive behaviour we are removing).
 *
 * SAFETY: repair is SCHEMA-DRIVEN. A string value is only unwrapped when the
 * tool's own JSON Schema says that property should be an object or an array.
 * That matters because a legitimate string parameter can easily begin with `{`
 * or `[` (an email body, a code snippet, a JSON example the user pasted), and
 * blindly parsing those would silently corrupt real arguments. Without a usable
 * schema we do nothing rather than guess.
 *
 * Pure + dependency-free so it unit tests without the SDK.
 */

/** Minimal JSON Schema shape we care about (avoids a json-schema dep). */
export interface RepairSchema {
  type?: string | string[];
  properties?: Record<string, RepairSchema | undefined>;
  items?: RepairSchema;
  [k: string]: unknown;
}

function schemaAllows(schema: RepairSchema | undefined, kind: "object" | "array"): boolean {
  if (!schema) return false;
  const t = schema.type;
  if (typeof t === "string") return t === kind;
  if (Array.isArray(t)) return t.includes(kind);
  // A schema with `properties` is object-shaped; with `items` it is array-shaped,
  // even when `type` was omitted (common in generated schemas).
  if (kind === "object" && schema.properties) return true;
  if (kind === "array" && schema.items) return true;
  return false;
}

/**
 * Parse a string that is supposed to hold an object/array. Returns the parsed
 * value only when it is actually of the expected shape, else undefined — so a
 * property whose string happens to parse to a number or bool is left alone.
 */
function parseAs(
  raw: string,
  wantObject: boolean,
  wantArray: boolean,
): unknown | undefined {
  const trimmed = raw.trim();
  if (trimmed.length === 0) return undefined;
  const looksArray = trimmed.startsWith("[");
  const looksObject = trimmed.startsWith("{");
  if (!looksArray && !looksObject) return undefined;
  if (looksArray && !wantArray) return undefined;
  if (looksObject && !wantObject) return undefined;
  try {
    const parsed = JSON.parse(trimmed);
    if (Array.isArray(parsed)) return wantArray ? parsed : undefined;
    if (parsed && typeof parsed === "object") return wantObject ? parsed : undefined;
    return undefined; // scalar — not what the schema asked for
  } catch {
    return undefined; // genuinely malformed: let the SDK's error stand
  }
}

/**
 * Walk an input object against its schema, unwrapping string-encoded
 * object/array properties. Recurses into nested objects and array items so a
 * doubly-nested payload (`calls[].params`) is repaired too. Returns whether
 * anything changed.
 */
function repairValue(
  value: unknown,
  schema: RepairSchema | undefined,
  depth: number,
): { value: unknown; changed: boolean } {
  if (depth > 6 || value === null || value === undefined) return { value, changed: false };

  // A string where the schema wants a container: the case we are here for.
  if (typeof value === "string") {
    const parsed = parseAs(
      value,
      schemaAllows(schema, "object"),
      schemaAllows(schema, "array"),
    );
    if (parsed === undefined) return { value, changed: false };
    // Recurse into the freshly-unwrapped value: the inner payload can itself
    // contain further stringified containers.
    const inner = repairValue(parsed, schema, depth + 1);
    return { value: inner.value, changed: true };
  }

  if (Array.isArray(value)) {
    let changed = false;
    const out = value.map((item) => {
      const r = repairValue(item, schema?.items, depth + 1);
      if (r.changed) changed = true;
      return r.value;
    });
    return { value: changed ? out : value, changed };
  }

  if (typeof value === "object") {
    const props = schema?.properties;
    if (!props) return { value, changed: false };
    let changed = false;
    const out: Record<string, unknown> = { ...(value as Record<string, unknown>) };
    for (const [key, child] of Object.entries(out)) {
      const r = repairValue(child, props[key], depth + 1);
      if (r.changed) {
        out[key] = r.value;
        changed = true;
      }
    }
    return { value: changed ? out : value, changed };
  }

  return { value, changed: false };
}

/**
 * Attempt to repair a tool call's input.
 *
 * @param rawInput the model's input, as the JSON string the SDK carries (an
 *                 already-parsed object is accepted too)
 * @param schema   the tool's JSON Schema; required for any repair to happen
 * @returns the repaired input as a JSON STRING, or null when nothing was
 *          repaired (caller should let the original error stand)
 */
export function repairStringifiedToolInput(
  rawInput: unknown,
  schema: RepairSchema | undefined,
): string | null {
  if (!schema) return null;

  let parsed: unknown;
  if (typeof rawInput === "string") {
    try {
      parsed = JSON.parse(rawInput);
    } catch {
      return null; // the outer envelope itself is broken — not our case
    }
  } else if (rawInput && typeof rawInput === "object") {
    parsed = rawInput;
  } else {
    return null;
  }

  const { value, changed } = repairValue(parsed, schema, 0);
  if (!changed) return null;
  try {
    return JSON.stringify(value);
  } catch {
    return null;
  }
}
