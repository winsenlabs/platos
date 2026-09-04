// Making a tool's answer safe to put back in front of a model.
//
// THE DEFECT THIS EXISTS FOR, IN ONE SENTENCE: a tool that returns `undefined`
// on a field the message schema requires produces
// `AI_InvalidPromptError: The messages do not match the ModelMessage[] schema`
// on the NEXT round trip, and only on tool turns — a text turn carries no tool
// result parts and never hits it. The source's `tool-result-sanitizer.ts`
// records that at length and this is the same scrub, expressed as a `Result` so
// a refusal is a value.
//
// THE CYCLE SET IS PATH-BASED AND NOT IDENTITY-BASED, AND THAT IS DELIBERATE.
// An identity set marks a value as seen forever, so a diamond — the same object
// referenced from two siblings — would serialize once and become `"[Circular]"`
// the second time, which `JSON.stringify` does not do. A path set only ever
// holds the current ANCESTORS, so a genuine cycle is caught and a diamond is
// written twice. The source gets this right and the reason is easy to lose.
//
// WHAT EACH CONVERSION IS FOR:
//   bigint            -> decimal string. `JSON.stringify` throws on one.
//   function/symbol   -> dropped. Neither survives a wire format.
//   undefined         -> dropped from an object, `null` inside an array. That
//                        asymmetry IS what `JSON.stringify` does, and matching
//                        it is the point of the whole file.
//   Date              -> ISO string; an invalid Date becomes `null` rather than
//                        the string `"Invalid Date"`.
//   Map / Set         -> object / array. Both stringify to `{}` untouched, so a
//                        tool returning a Map silently answered nothing.
//   array holes       -> `null`, which is again what stringify does.
//
// A NULL OR UNDEFINED RESULT IS A REFUSAL, NOT AN EMPTY ANSWER, and it is
// checked twice — before the scrub and after it — because the scrub itself can
// reduce a value to nothing (an object of only functions). The source has both
// checks and neither is redundant.

const CIRCULAR = "[Circular]";

export interface SanitizedToolResult {
  readonly ok: boolean;
  readonly value: unknown;
  /** Set only when `ok` is false. Operator-facing, never a stack trace. */
  readonly error: string | null;
}

function scrub(value: unknown, ancestors: ReadonlySet<unknown>): unknown {
  if (typeof value === "bigint") return value.toString();
  if (typeof value === "function" || typeof value === "symbol") return undefined;
  if (value === null || typeof value !== "object") return value;

  if (value instanceof Date) return Number.isNaN(value.getTime()) ? null : value.toISOString();
  if (ancestors.has(value)) return CIRCULAR;

  const nested = new Set(ancestors);
  nested.add(value);

  if (value instanceof Map) {
    const mapped: Record<string, unknown> = {};
    for (const [key, entry] of value.entries()) {
      const scrubbed = scrub(entry, nested);
      if (scrubbed !== undefined) mapped[String(key)] = scrubbed;
    }
    return mapped;
  }
  if (value instanceof Set) {
    return [...value.values()].map((entry) => scrub(entry, nested) ?? null);
  }
  if (Array.isArray(value)) {
    return value.map((entry) => {
      const scrubbed = scrub(entry, nested);
      return scrubbed === undefined ? null : scrubbed;
    });
  }

  const plain: Record<string, unknown> = {};
  for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
    const scrubbed = scrub(entry, nested);
    if (scrubbed !== undefined) plain[key] = scrubbed;
  }
  return plain;
}

/**
 * Scrub one tool result into something a message array will accept.
 *
 * Answers `ok: false` rather than throwing, because a tool whose answer cannot
 * be represented is a RESULT the model has to be told about — `providers`'
 * `ToolResultPart` carries `failed: true` for exactly this — and not a defect
 * that should end the generation.
 */
export function sanitizeToolResult(value: unknown): SanitizedToolResult {
  if (value === undefined || value === null) {
    return Object.freeze({ ok: false, value: null, error: "the tool answered with nothing" });
  }
  const scrubbed = scrub(value, new Set());
  if (scrubbed === undefined || scrubbed === null) {
    return Object.freeze({ ok: false, value: null, error: "the tool result was not serializable" });
  }
  return Object.freeze({ ok: true, value: scrubbed, error: null });
}

/**
 * Whether a result is a stream rather than a value.
 *
 * A streaming result passes through UNSCRUBBED — walking it would consume it —
 * so this predicate is the guard that stops the scrub reaching one. The source
 * checks the same two protocol members.
 */
export function isStreamingResult(value: unknown): boolean {
  if (value === null || typeof value !== "object") return false;
  const candidate = value as { [Symbol.asyncIterator]?: unknown; getReader?: unknown };
  return typeof candidate[Symbol.asyncIterator] === "function" || typeof candidate.getReader === "function";
}
