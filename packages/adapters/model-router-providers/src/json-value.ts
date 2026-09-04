// Making a tool's answer something the framework can embed.
//
// WHY. The multi-step tool loop puts each tool's return value into the message
// array it re-sends on the NEXT step. A value the framework cannot embed does
// not fail the tool — it fails the whole turn, at the provider, after the
// tokens have been paid for. The shapes that do it are ordinary JavaScript:
//
//   * `undefined` on a required field of a returned object, which surfaces as
//     "the messages do not match the schema — expected string, received
//     undefined" on tool turns and never on text turns;
//   * `bigint`, `Map`, `Set`, `Date`, a function, a symbol, or a circular
//     reference, none of which are JSON values.
//
// WHAT IS GUARANTEED. Every value this returns is JSON round-trippable. It
// deliberately does NOT wrap a bare string or array into an object: a tool whose
// contract is to return one would otherwise have its answer changed underneath
// the model.
//
// WHY IT IS IN THE ADAPTER AND NOT THE DOMAIN. Unlike the cache placement and
// the correction caps, this is not a rule about what a turn costs or means. It
// is a fact about what one serialiser accepts, which is precisely the class of
// knowledge ADR M0.3 puts behind the SDK boundary.

/** A value that survives `JSON.stringify` and `JSON.parse` unchanged. */
export type JsonValue =
  | string
  | number
  | boolean
  | null
  | JsonValue[]
  | { [key: string]: JsonValue };

/** What a tool that returned nothing usable becomes. Never `undefined`. */
export const EMPTY_TOOL_RESULT: JsonValue = { ok: false };

/** What a value that defeated the scrubber becomes. */
export const UNSERIALISABLE_TOOL_RESULT: JsonValue = {
  ok: false,
  error: "tool result was not serialisable",
};

/** The marker a cycle is replaced with, so the rest of the value survives. */
export const CIRCULAR_MARKER = "[Circular]";

/**
 * Scrub one value.
 *
 * `undefined` is the "drop me" signal inside the walk: an object field holding
 * it is dropped, exactly as `JSON.stringify` drops it, and an array hole becomes
 * `null`, exactly as `JSON.stringify` does. Matching the serialiser rather than
 * inventing a third behaviour is what keeps the model's view of a tool result
 * the same as a log's.
 *
 * CYCLE DETECTION IS PATH-BASED, NOT VISIT-BASED. A value is circular only if it
 * is on the current ancestor path, so two siblings referencing one object still
 * serialise twice — which is what `JSON.stringify` does. A visited-set would have
 * replaced the second sibling with the marker and silently lost real data.
 */
function scrub(value: unknown, path: Set<object>): JsonValue | undefined {
  if (value === null) return null;
  const kind = typeof value;
  if (kind === "bigint") return (value as bigint).toString();
  if (kind === "function" || kind === "symbol" || kind === "undefined") return undefined;
  if (kind === "string" || kind === "boolean") return value as JsonValue;
  if (kind === "number") return Number.isFinite(value as number) ? (value as number) : null;
  if (kind !== "object") return undefined;

  const object = value as object;
  if (object instanceof Date) {
    const at = object.getTime();
    return Number.isNaN(at) ? null : object.toISOString();
  }
  if (path.has(object)) return CIRCULAR_MARKER;
  path.add(object);
  try {
    if (object instanceof Map) {
      const out: Record<string, JsonValue> = {};
      for (const [key, entry] of object.entries()) {
        const scrubbed = scrub(entry, path);
        if (scrubbed !== undefined) out[String(key)] = scrubbed;
      }
      return out;
    }
    if (object instanceof Set) {
      return [...object].map((entry) => scrub(entry, path) ?? null);
    }
    if (Array.isArray(object)) {
      return object.map((entry) => scrub(entry, path) ?? null);
    }
    const out: Record<string, JsonValue> = {};
    for (const [key, entry] of Object.entries(object as Record<string, unknown>)) {
      const scrubbed = scrub(entry, path);
      if (scrubbed !== undefined) out[key] = scrubbed;
    }
    return out;
  } finally {
    path.delete(object);
  }
}

/**
 * A tool's answer, made embeddable.
 *
 * A top-level `undefined` or `null` becomes `{ ok: false }` rather than being
 * passed through: a null tool output is never a meaningful answer to a model,
 * and it is the exact shape that fails the turn.
 */
export function embeddableToolResult(value: unknown): JsonValue {
  if (value === undefined || value === null) return EMPTY_TOOL_RESULT;
  try {
    const scrubbed = scrub(value, new Set<object>());
    if (scrubbed === undefined || scrubbed === null) return EMPTY_TOOL_RESULT;
    return scrubbed;
  } catch {
    // A getter that throws, a proxy that refuses enumeration: the turn still
    // gets a valid, informative part instead of dying at the provider.
    return UNSERIALISABLE_TOOL_RESULT;
  }
}
