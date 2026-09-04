// Repairing a tool call the model got the SHAPE of wrong, without paying for
// another step.
//
// THE PRODUCTION EVIDENCE. One trace in the extraction source made three
// CONSECUTIVE tool calls that the provider rejected, because the model emitted
// an array-typed parameter as a JSON-encoded STRING:
//
//     { "calls": "[{\"tool\": \"SEND\", \"params\": {\"body\": \"a\\nb\"}}]" }
//
// The failure mode is doubly-nested JSON around multi-line string content: the
// model escapes its way into emitting the inner array as a string. Each
// rejection cost a full-price 100k-token step before the model happened to
// recover, so a formatting slip billed like real work. Repairing the call
// in place costs zero extra model calls.
//
// WHY THIS IS IN THE DOMAIN AND NOT IN THE ADAPTER. It is a total function over
// two values this context already owns — a `ToolDefinition`'s
// `JsonSchemaDocument` and a `ToolCallPart`'s input — and it is worth real
// money, which is the same pair of properties that puts `prompt-cache.ts` here.
// The extraction source says so itself: its header reads "Pure + dependency-free
// so it unit tests without the SDK". What stays in the adapter is the half that
// is genuinely the framework's: WHICH of its error classes is repairable at all.
//
// REPAIR IS SCHEMA-DRIVEN, AND THAT IS THE SAFETY PROPERTY. A string is only
// unwrapped when the tool's own schema says that property should be an object or
// an array. A legitimate string parameter can easily begin with `{` or `[` — an
// email body, a code snippet, a JSON example a user pasted — and parsing those
// would silently corrupt real arguments. With no usable schema this does
// nothing rather than guess.

import type { JsonSchemaDocument } from "./generation.js";

/**
 * How deep the walk goes before it stops.
 *
 * A bound and not a formality: a schema may be self-referential through `$ref`,
 * and a repair that recursed on one would not return. Six is the extraction
 * source's number and it covers the observed shape — an array of objects each
 * carrying a nested params object — with room to spare.
 */
export const MAX_REPAIR_DEPTH = 6;

/** The slice of JSON Schema this walk reads. Everything else is ignored. */
export interface RepairSchema {
  readonly type?: string | readonly string[];
  readonly properties?: Readonly<Record<string, RepairSchema | undefined>>;
  readonly items?: RepairSchema;
}

function asRepairSchema(document: JsonSchemaDocument | undefined): RepairSchema | undefined {
  return document as RepairSchema | undefined;
}

/**
 * Does the schema say this position holds a container of that kind?
 *
 * A schema carrying `properties` is object-shaped and one carrying `items` is
 * array-shaped even when `type` was omitted, which is common in generated
 * schemas. Reading only `type` would have left those tools unrepairable.
 */
function schemaAllows(schema: RepairSchema | undefined, kind: "object" | "array"): boolean {
  if (schema === undefined) return false;
  const declared = schema.type;
  if (typeof declared === "string") return declared === kind;
  if (Array.isArray(declared)) return declared.includes(kind);
  if (kind === "object" && schema.properties !== undefined) return true;
  if (kind === "array" && schema.items !== undefined) return true;
  return false;
}

/**
 * Parse a string that is supposed to hold a container, returning it only when it
 * really is one of the expected kind.
 *
 * A property whose string happens to parse to a number or a boolean is left
 * alone: the schema asked for a container and a scalar is not one, so unwrapping
 * would replace a plausible value with a differently wrong one.
 */
function parseContainer(raw: string, wantObject: boolean, wantArray: boolean): unknown | undefined {
  const trimmed = raw.trim();
  if (trimmed.length === 0) return undefined;
  const looksArray = trimmed.startsWith("[");
  const looksObject = trimmed.startsWith("{");
  if (!looksArray && !looksObject) return undefined;
  if (looksArray && !wantArray) return undefined;
  if (looksObject && !wantObject) return undefined;
  try {
    const parsed: unknown = JSON.parse(trimmed);
    if (Array.isArray(parsed)) return wantArray ? parsed : undefined;
    if (parsed !== null && typeof parsed === "object") return wantObject ? parsed : undefined;
    return undefined;
  } catch {
    // Genuinely malformed. The provider's own error is the honest answer.
    return undefined;
  }
}

interface Repaired {
  readonly value: unknown;
  readonly changed: boolean;
}

/**
 * Walk a value against its schema, unwrapping string-encoded containers.
 *
 * Recurses into objects and array items, so a doubly-nested payload is repaired
 * too, and recurses into a freshly unwrapped value because the inner payload can
 * itself carry further stringified containers.
 */
function repairValue(value: unknown, schema: RepairSchema | undefined, depth: number): Repaired {
  if (depth > MAX_REPAIR_DEPTH || value === null || value === undefined) {
    return { value, changed: false };
  }

  if (typeof value === "string") {
    const parsed = parseContainer(value, schemaAllows(schema, "object"), schemaAllows(schema, "array"));
    if (parsed === undefined) return { value, changed: false };
    const inner = repairValue(parsed, schema, depth + 1);
    return { value: inner.value, changed: true };
  }

  if (Array.isArray(value)) {
    let changed = false;
    const out = value.map((item) => {
      const repaired = repairValue(item, schema?.items, depth + 1);
      if (repaired.changed) changed = true;
      return repaired.value;
    });
    return { value: changed ? out : value, changed };
  }

  if (typeof value === "object") {
    const properties = schema?.properties;
    if (properties === undefined) return { value, changed: false };
    let changed = false;
    const out: Record<string, unknown> = { ...(value as Record<string, unknown>) };
    for (const [key, child] of Object.entries(out)) {
      const repaired = repairValue(child, properties[key], depth + 1);
      if (repaired.changed) {
        out[key] = repaired.value;
        changed = true;
      }
    }
    return { value: changed ? out : value, changed };
  }

  return { value, changed: false };
}

/**
 * Repair a tool call's input, or say plainly that nothing was repaired.
 *
 * `rawInput` is what the wire carries — a JSON string — and an already-parsed
 * object is accepted too. The answer comes back as a JSON STRING because that is
 * the shape a tool call's input travels in, and `null` means the caller should
 * let the original failure stand rather than send an unchanged call again.
 *
 * NULL IS RETURNED FOR "NOTHING CHANGED", never for "changed to nothing". A
 * repair that produced an identical value is not a repair, and reporting one
 * would let a caller loop.
 */
export function repairToolCallInput(
  rawInput: unknown,
  schema: JsonSchemaDocument | undefined,
): string | null {
  const repairSchema = asRepairSchema(schema);
  if (repairSchema === undefined) return null;

  let parsed: unknown;
  if (typeof rawInput === "string") {
    try {
      parsed = JSON.parse(rawInput);
    } catch {
      // The outer envelope itself is broken, which is a different failure and
      // not one a schema-driven unwrap can fix.
      return null;
    }
  } else if (rawInput !== null && typeof rawInput === "object") {
    parsed = rawInput;
  } else {
    return null;
  }

  const repaired = repairValue(parsed, repairSchema, 0);
  if (!repaired.changed) return null;
  try {
    return JSON.stringify(repaired.value);
  } catch {
    return null;
  }
}
