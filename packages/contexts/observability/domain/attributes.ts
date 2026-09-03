// `attributes_json` — an ALLOW-LIST, never a caller's bag.
//
// This is the only free-form column in the projection, which makes it the only
// place an unreviewed payload could reach an analytical store. So it is built
// from a fixed list of scalar keys and nothing else. Adding a key is a
// deliberate act; adding one that can carry identity means adding it to the
// subject-erasure plan in the same change, because a column erasure cannot
// address is a column erasure does not clean.
//
// Prompts, tool arguments, tool results, message bodies and credentials have no
// path into this file: they are not parameters of any function in it, and the
// serializer below cannot be handed one, because a nested value is DROPPED
// rather than stringified.

/**
 * Keys permitted in `attributes_json`.
 *
 * An allow-list for the reason the erasure plan enumerates its tables rather
 * than discovering them: a list is auditable, and "copy whatever the caller
 * sent" is how a prompt ends up in a store nobody thought held prompts.
 */
export const ATTRIBUTE_ALLOW_LIST = [
  "finish_reason",
  "retry_count",
  "stop_reason",
  "temperature",
  "tool_choice",
  "truncated",
  "version_bucket",
] as const;

export type AttributeKey = (typeof ATTRIBUTE_ALLOW_LIST)[number];

export type ObservedAttributes = Partial<Record<AttributeKey, string | number | boolean>>;

/** Longest string any single attribute may carry. */
export const ATTRIBUTE_TEXT_LIMIT = 200;

/** The value the column carries when nothing survived the allow-list. */
export const EMPTY_ATTRIBUTES_JSON = "{}";

export function isAttributeKey(value: string): value is AttributeKey {
  return (ATTRIBUTE_ALLOW_LIST as readonly string[]).includes(value);
}

/**
 * Serialize allow-listed scalars.
 *
 * Iteration is over the ALLOW-LIST, not over the input, which is what makes an
 * unknown key structurally unable to appear however it is spelled. Objects and
 * arrays are dropped rather than stringified: a nested value is where an
 * unreviewed payload hides, and no allow-listed key has one. A non-finite
 * number is dropped too — `NaN` serializes as `null` and would read as a
 * measurement that was taken and came back empty.
 *
 * Key order is the allow-list's order, so two runs of the same input produce
 * byte-identical text and a stored payload can be compared rather than parsed.
 */
export function attributesJson(attributes: ObservedAttributes | undefined | null): string {
  if (!attributes) return EMPTY_ATTRIBUTES_JSON;
  const out: Record<string, string | number | boolean> = {};
  for (const key of ATTRIBUTE_ALLOW_LIST) {
    const value = attributes[key];
    if (typeof value === "string") out[key] = value.slice(0, ATTRIBUTE_TEXT_LIMIT);
    else if (typeof value === "number" && Number.isFinite(value)) out[key] = value;
    else if (typeof value === "boolean") out[key] = value;
  }
  return JSON.stringify(out);
}
