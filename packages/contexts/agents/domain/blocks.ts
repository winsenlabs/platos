// Prompt blocks, dynamic blocks, and the write-boundary coercion that keeps a
// `Json` column readable.
//
// THE COERCION IS A DATA-CORRUPTION FIX, NOT TIDINESS. `AgentVersion.promptBlocks`
// / `.dynamicBlocks` / `.modelRoutes` are declared "array of block objects", and
// Postgres `jsonb` also accepts a bare string scalar. A client that
// double-encodes — sends the serialized array instead of the array — lands a
// STRING in the column, and the column keeps it. Every downstream reader assumes
// an array: one of them maps over it and crashes the surface, the other guards
// with an array check and silently drops every dynamic block, so the agent
// answers without the grounding it was configured with. One bad write corrupts
// the row until someone saves over it.
//
// `coerceBlockList` is the fix, applied at the write boundary: parse if it is a
// string, require an array, otherwise drop to null. It is idempotent on an
// already-correct array, which is what lets it run on every read as well as
// every write and lets a legacy row self-heal on its next save.
//
// SERIALIZATION IS THE SOURCE'S, INCLUDING ITS TWO EXCLUSIONS. A block is
// rendered only when it is not explicitly disabled, has non-blank content, and
// is not of type `retrieval` — a retrieval block names material the runtime
// fetches, so rendering its body into the system prompt would inline the query
// instead of the answer. Order is the declared `order`, defaulting to 0, and an
// `identity` block (or an unnamed one) is rendered without a heading.

import type { JsonValue } from "@platos/kernel";

export interface PromptBlock {
  readonly id: string;
  readonly type: string;
  readonly name: string;
  readonly content: string;
  readonly enabled: boolean;
  readonly editable: boolean;
  readonly order: number;
}

export interface DynamicBlockTemplate {
  readonly key: string;
  readonly name: string;
  readonly defaultContent: string;
  readonly description?: string;
  readonly order?: number;
}

/**
 * Coerce a block-list column to an array, or to null.
 *
 * Returns a NEW array; the input is never mutated. `null` and `undefined` are
 * the same answer — an absent list and a cleared one are indistinguishable in
 * the column and must stay indistinguishable here.
 */
export function coerceBlockList(value: unknown): readonly JsonValue[] | null {
  if (value === undefined || value === null) return null;
  let candidate: unknown = value;
  if (typeof candidate === "string") {
    const trimmed = candidate.trim();
    if (trimmed === "") return null;
    try {
      candidate = JSON.parse(trimmed) as unknown;
    } catch {
      // A string that is not JSON is not a list. Dropping to null is what makes
      // the corruption recoverable: the next save writes a real array.
      return null;
    }
  }
  return Array.isArray(candidate) ? ([...candidate] as readonly JsonValue[]) : null;
}

/** Every element of a coerced list that is an object. Scalars are dropped. */
export function objectsIn(list: readonly JsonValue[] | null): readonly Record<string, JsonValue>[] {
  if (list === null) return [];
  return list.filter(
    (entry): entry is Record<string, JsonValue> =>
      typeof entry === "object" && entry !== null && !Array.isArray(entry),
  );
}

/** Read a block list out of a column, keeping only the entries that are blocks. */
export function readPromptBlocks(value: unknown): readonly PromptBlock[] | null {
  const list = coerceBlockList(value);
  if (list === null) return null;
  return objectsIn(list).map((entry) => ({
    id: stringOr(entry["id"], ""),
    type: stringOr(entry["type"], ""),
    name: stringOr(entry["name"], ""),
    content: stringOr(entry["content"], ""),
    // Absent means enabled: the source renders a block unless `enabled` is
    // explicitly false, so a block written before the flag existed still shows.
    enabled: entry["enabled"] !== false,
    editable: entry["editable"] !== false,
    order: typeof entry["order"] === "number" ? entry["order"] : 0,
  }));
}

function stringOr(value: JsonValue | undefined, fallback: string): string {
  return typeof value === "string" ? value : fallback;
}

/** The block type whose body is never rendered into a system prompt. */
export const UNRENDERED_BLOCK_TYPE = "retrieval";

/** The block type rendered without a heading. */
export const UNHEADED_BLOCK_TYPE = "identity";

/**
 * Render an ordered block list into one system prompt.
 *
 * `sort` runs on a copy, because the source slices before it sorts and a
 * renderer that reordered its caller's array would silently rewrite the stored
 * block order on the next save.
 */
export function serializePromptBlocks(blocks: readonly PromptBlock[] | null | undefined): string {
  if (!Array.isArray(blocks) || blocks.length === 0) return "";
  return [...blocks]
    .filter(
      (block) =>
        block.enabled !== false &&
        typeof block.content === "string" &&
        block.content.trim().length > 0 &&
        block.type !== UNRENDERED_BLOCK_TYPE,
    )
    .sort((left, right) => (left.order ?? 0) - (right.order ?? 0))
    .map((block) => {
      const content = block.content.trim();
      if (block.type === UNHEADED_BLOCK_TYPE || !block.name) return content;
      return `## ${block.name}\n\n${content}`;
    })
    .join("\n\n");
}

/**
 * Shallow-merge a partial JSON config patch over the stored object.
 *
 * A client that owns only some keys must not wipe the rest — the failure this
 * exists for was a Tools tab sending one field and resetting every other. An
 * explicit `null` clears the column; a non-object patch, or no prior value,
 * passes through unchanged.
 */
export function mergeJsonConfig(existing: unknown, patch: unknown): unknown {
  if (patch === null) return null;
  if (!patch || typeof patch !== "object" || Array.isArray(patch)) return patch;
  if (!existing || typeof existing !== "object" || Array.isArray(existing)) return patch;
  return { ...(existing as Record<string, unknown>), ...(patch as Record<string, unknown>) };
}
