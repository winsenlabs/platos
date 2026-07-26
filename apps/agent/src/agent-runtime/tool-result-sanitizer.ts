import type { Tool } from "ai";

/**
 * Tool-result serialization boundary.
 *
 * WHY THIS EXISTS
 * ---------------
 * The AI SDK's multi-step tool loop (`streamText`/`generateText` with a
 * `stopWhen` step predicate) embeds each tool `execute()` return value as a
 * `tool-result` part inside the `ModelMessage[]` it re-sends to the provider on
 * the *next* step. If a tool hands back a value the SDK cannot embed cleanly,
 * the whole turn dies:
 *
 *   - `undefined`                → the SDK coerces top-level undefined to
 *                                  `null`, but a null/undefined tool output is
 *                                  never a meaningful result for the model, and
 *                                  an `undefined` sitting on a *required* field
 *                                  of the returned object is exactly the shape
 *                                  that surfaces as
 *                                  `AI_InvalidPromptError: The messages do not
 *                                  match the ModelMessage[] schema`
 *                                  ("expected string/boolean, received
 *                                  undefined") on tool turns.
 *   - `bigint` / `Map` / `Set`   → not JSON values; the provider's
 *     / circular refs / `Date`      `JSON.stringify` of the tool-result part
 *     / functions / symbols         throws (or emits a shape the schema
 *                                  rejects).
 *
 * Text turns never hit this because they carry no tool-result parts — only
 * tool turns do, which is exactly the observed failure signature.
 *
 * WHAT THIS GUARANTEES
 * --------------------
 * `sanitizeToolResult` returns a value that always embeds as a valid,
 * JSON-round-trippable tool-result part:
 *
 *   - top-level `undefined` / `null`  → `{ ok: false }` (never undefined)
 *   - every nested value is deep-scrubbed:
 *       bigint  → decimal string
 *       Date    → ISO string
 *       Map     → plain object
 *       Set     → array
 *       function / symbol           → dropped
 *       circular reference          → "[Circular]"
 *       object field === undefined  → dropped (mirrors JSON.stringify)
 *       array hole  === undefined   → null (mirrors JSON.stringify)
 *
 * Valid non-null primitives and arrays at the top level are preserved (they are
 * legitimate tool outputs the SDK embeds fine) — only *scrubbed* for
 * serializability. We deliberately do NOT wrap a bare string/array into an
 * object, which would change what the model sees for tools whose contract is to
 * return one.
 */
export function sanitizeToolResult(value: unknown): unknown {
  if (value === undefined || value === null) return { ok: false };

  // Diamond-safe cycle detection: an object is only "circular" if it appears
  // on the current ancestor path, so shared (sibling) references still
  // serialize twice — matching JSON.stringify, which only throws on true
  // back-references.
  const path = new Set<object>();

  const scrub = (v: unknown): unknown => {
    if (v === null) return null;
    const t = typeof v;
    if (t === "bigint") return (v as bigint).toString();
    if (t === "function" || t === "symbol" || t === "undefined") return undefined;
    if (t !== "object") return v; // string | number | boolean

    const obj = v as object;
    if (obj instanceof Date) {
      const iso = obj.getTime();
      return Number.isNaN(iso) ? null : (obj as Date).toISOString();
    }
    if (path.has(obj)) return "[Circular]";
    path.add(obj);
    try {
      if (obj instanceof Map) {
        const o: Record<string, unknown> = {};
        for (const [k, val] of (obj as Map<unknown, unknown>).entries()) {
          const s = scrub(val);
          if (s !== undefined) o[String(k)] = s;
        }
        return o;
      }
      if (obj instanceof Set) {
        const arr: unknown[] = [];
        for (const el of obj as Set<unknown>) {
          const s = scrub(el);
          arr.push(s === undefined ? null : s);
        }
        return arr;
      }
      if (Array.isArray(obj)) {
        return obj.map((el) => {
          const s = scrub(el);
          return s === undefined ? null : s;
        });
      }
      // Plain object (and class instances — own enumerable props only).
      const o: Record<string, unknown> = {};
      for (const [k, val] of Object.entries(obj as Record<string, unknown>)) {
        const s = scrub(val);
        if (s !== undefined) o[k] = s;
      }
      return o;
    } finally {
      path.delete(obj);
    }
  };

  try {
    const scrubbed = scrub(value);
    if (scrubbed === undefined || scrubbed === null) return { ok: false };
    return scrubbed;
  } catch {
    // Belt-and-suspenders: anything the scrubber somehow could not tame still
    // yields a valid, informative part instead of killing the turn.
    return { ok: false, error: "tool result was not serializable" };
  }
}

/**
 * Hidden marker property set on a tool once its `execute` has been wrapped, so
 * {@link hardenToolResults} is idempotent across the multiple call sites that
 * pass the same tool map (buildMetaTools → ACL filter → skill registration →
 * AI-SDK call).
 */
const HARDENED_MARKER = "__platosResultHardened";

type MutableTool = Record<string, unknown> & {
  execute?: (...args: unknown[]) => unknown;
};

/**
 * Wrap every tool's `execute` in the map so its return passes through
 * {@link sanitizeToolResult} before the AI SDK embeds it as a tool-result
 * part. Mutates and returns the same map.
 *
 * Idempotent: a tool already wrapped (by an earlier call on the same object) is
 * skipped. Tools without a function `execute` (client-side / provider-executed)
 * are left untouched. All call arguments are forwarded verbatim, so the SDK's
 * `(input, { toolCallId, messages, abortSignal })` calling convention is
 * preserved. Streaming tool results (async-iterable / ReadableStream) are
 * passed through un-scrubbed — they are a valid v7 result shape and are not
 * JSON-embedded the same way.
 */
export function hardenToolResults(
  tools: Record<string, Tool>,
): Record<string, Tool> {
  for (const tool of Object.values(tools)) {
    const t = tool as unknown as MutableTool;
    if (typeof t.execute !== "function" || t[HARDENED_MARKER]) continue;
    const original = t.execute as (...args: unknown[]) => unknown;
    t.execute = async (...args: unknown[]) => {
      const raw = await original(...args);
      if (raw != null && isStreamingResult(raw)) {
        // Streaming tool result — leave the stream intact.
        return raw;
      }
      return sanitizeToolResult(raw);
    };
    t[HARDENED_MARKER] = true;
  }
  return tools;
}

/** True for a v7 streaming tool result (async-iterable or ReadableStream). */
function isStreamingResult(raw: unknown): boolean {
  const candidate = raw as {
    [Symbol.asyncIterator]?: unknown;
    getReader?: unknown;
  };
  return (
    typeof candidate[Symbol.asyncIterator] === "function" ||
    typeof candidate.getReader === "function"
  );
}
