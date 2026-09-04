// Reading a stored payload back without trusting it.
//
// Everything the drain receives came out of a JSON column, so its declared type
// is a promise nobody kept: the column has repeatedly been found holding a
// string scalar where an object was declared, and a drain that trusts the
// declaration crashes the whole pass on one bad row. Every reader here takes
// `unknown` deliberately — the moment a payload is typed, the checks below stop
// being checks and become casts.
//
// They return `undefined` for anything that is not what was asked for, so a
// caller must branch rather than coerce. They are total, pure, and they never
// throw. That is the property that lets a caller turn a bad payload into a
// PARKED envelope with a reason, instead of an exception that takes the
// well-formed envelopes behind it down too.

export type JsonObject = { readonly [key: string]: unknown };

export function asObject(value: unknown): JsonObject | undefined {
  if (value === null || value === undefined) return undefined;
  if (typeof value !== "object" || Array.isArray(value)) return undefined;
  return value as JsonObject;
}

export function asArray(value: unknown): readonly unknown[] | undefined {
  return Array.isArray(value) ? value : undefined;
}

/** A non-blank string, or undefined. Blank is absence wearing a value's clothes. */
export function asText(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

export function asFiniteNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

/**
 * An instant, from either spelling a JSON column can hold.
 *
 * A number is epoch milliseconds; a string is anything `Date` parses. An
 * unparseable value is `undefined` rather than an invalid `Date`, because an
 * invalid `Date` still satisfies every downstream `instanceof` check and would
 * reach a column as the epoch with nothing having said so.
 */
export function asInstant(value: unknown): Date | undefined {
  if (typeof value === "number" && Number.isFinite(value)) return new Date(value);
  if (typeof value !== "string" || value.length === 0) return undefined;
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? undefined : parsed;
}

/** One of a closed set of strings, or undefined. */
export function asMember<Value extends string>(
  value: unknown,
  members: readonly Value[],
): Value | undefined {
  return typeof value === "string" && (members as readonly string[]).includes(value)
    ? (value as Value)
    : undefined;
}

/**
 * A cell a projection row may carry: string, finite number, or null.
 *
 * Nothing else, and deliberately so. A nested object or array in a cell is
 * either silently stringified by a client or refused by the store, and both
 * outcomes are worse than refusing the envelope here with the column named.
 */
export function asCell(value: unknown): string | number | null | undefined {
  if (value === null) return null;
  if (typeof value === "string") return value;
  if (typeof value === "number" && Number.isFinite(value)) return value;
  return undefined;
}
