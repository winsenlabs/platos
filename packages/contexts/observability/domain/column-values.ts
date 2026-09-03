// How a domain value becomes a column value.
//
// Every function here is pure, total, and NEVER THROWS. That is not a stylistic
// preference: the store's insert is all-or-nothing per batch, so one column that
// fails to parse discards every good row sent with it — and the batch is frozen
// in the queue and replayed, so the same bad row discards the same good rows on
// every retry, for ever. Clamping one absurd number is a visibly wrong cell;
// throwing on it is a permanently stuck queue.
//
// The rules are transcribed from the live projection and preserved exactly:
// `apps/agent/src/observability/observability-event.ts` is the oracle for the
// bounds, the fixed-point rendering and the nil-uuid substitution below.

/** Total digits 24, of which 12 are fractional — so 12 digits of integer room. */
const DECIMAL_BOUND = 1e12;

/**
 * The largest magnitude that still RENDERS inside those 12 integer digits.
 *
 * Clamping to `DECIMAL_BOUND` itself is an off-by-one that defeats the clamp:
 * `(1e12).toFixed(12)` is "1000000000000.000000000000" — thirteen integer
 * digits, which a `Decimal(24, 12)` column cannot parse. So the one absurd
 * number would still take the whole batch down, which is precisely the outcome
 * clamping exists to prevent. One double below the bound is the largest value
 * that renders with twelve.
 */
export const DECIMAL_MAX = DECIMAL_BOUND - 2 ** -13;

/**
 * Fixed-point text for a `Decimal(24, 12)` column.
 *
 * `toFixed` rather than `String(value)` because the hazard is NOTATION, not
 * precision: `String(0.0000001)` is `"1e-7"` and the parser rejects it. Twelve
 * fractional digits is the column's own scale and a double carries ~15-16
 * significant digits, so this rounds nothing the column could have stored.
 */
export function decimal12(value: number | null | undefined): string {
  if (value === null || value === undefined || !Number.isFinite(value)) return "0.000000000000";
  const clamped = Math.max(-DECIMAL_MAX, Math.min(DECIMAL_MAX, value));
  return clamped.toFixed(12);
}

/** Nullable money: absent stays absent rather than becoming a confident zero. */
export function nullableDecimal12(value: number | null | undefined): string | null {
  if (value === null || value === undefined || !Number.isFinite(value)) return null;
  return decimal12(value);
}

/** USD per million tokens, from a catalogue rate quoted in USD per token. */
export function usdPerMillion(usdPerToken: number | null | undefined): string {
  if (usdPerToken === null || usdPerToken === undefined || !Number.isFinite(usdPerToken)) {
    return decimal12(0);
  }
  return decimal12(usdPerToken * 1_000_000);
}

/** USD from the integer cents the canonical row stores. */
export function usdFromCents(cents: number | null | undefined): string {
  if (cents === null || cents === undefined || !Number.isFinite(cents)) return decimal12(0);
  return decimal12(cents / 100);
}

/**
 * Non-negative whole tokens.
 *
 * Providers do occasionally report a float or a null in a lane the column types
 * as `UInt64`, and a negative token count is not a quantity anything can mean.
 */
export function tokenCount(value: number | null | undefined): number {
  if (value === null || value === undefined || !Number.isFinite(value)) return 0;
  return Math.max(0, Math.floor(value));
}

/** A non-negative whole count for a `UInt*` column. */
export function wholeCount(value: number | null | undefined): number {
  if (value === null || value === undefined || !Number.isFinite(value)) return 0;
  return Math.max(0, Math.floor(value));
}

/**
 * `DateTime64(6, 'UTC')` text.
 *
 * Space-separated and without a zone suffix: the column is UTC-typed so this is
 * unambiguous, and it avoids depending on which ISO-8601 spellings a given
 * server version's parser accepts. An invalid or absent instant renders as the
 * epoch rather than throwing — see this file's header.
 */
export function columnDateTime(value: Date | null | undefined): string {
  const date = value instanceof Date && !Number.isNaN(value.getTime()) ? value : new Date(0);
  return date.toISOString().replace("T", " ").replace("Z", "").padEnd(26, "0").slice(0, 26);
}

/** Milliseconds between two instants, never negative. */
export function durationMs(startedAt: Date | null | undefined, completedAt: Date | null | undefined): number {
  if (!(startedAt instanceof Date) || !(completedAt instanceof Date)) return 0;
  const delta = completedAt.getTime() - startedAt.getTime();
  return Number.isFinite(delta) ? Math.max(0, Math.round(delta)) : 0;
}

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu;

/** The value a malformed id renders as. Visibly wrong, and parseable. */
export const NIL_UUID = "00000000-0000-0000-0000-000000000000";

/**
 * A value the store's UUID parser will accept.
 *
 * The id columns are populated from canonical uuids that are always well
 * formed, so reaching the nil uuid means a caller passed something else — and
 * one visibly wrong row beats a rejected batch that takes the Turn's real rows
 * with it.
 */
export function uuidOrNil(value: string | null | undefined): string {
  return typeof value === "string" && UUID_PATTERN.test(value) ? value : NIL_UUID;
}

/** Empty string, never null: these columns are `String DEFAULT ''`. */
export function text(value: string | null | undefined): string {
  return typeof value === "string" ? value : "";
}

/**
 * A plaintext identity value, or null.
 *
 * Blank collapses to null so the erasure residue check — which asks whether a
 * row STILL CARRIES identity via `coalesce(col, '') != ''` — is answering a
 * question about identity rather than about whitespace.
 */
export function identityText(value: string | null | undefined): string | null {
  const trimmed = typeof value === "string" ? value.trim() : "";
  return trimmed.length > 0 ? trimmed : null;
}

/** Longest diagnostic text any row may carry. */
export const REDACTED_TEXT_LIMIT = 500;

/**
 * Redacted diagnostic text: an error class or a short message, never a payload.
 *
 * Truncation is the only transformation. Nothing here inspects the string for
 * secrets, because a caller that could pass a secret here has already lost —
 * the defence is that no prompt, tool argument, tool result or message body is
 * a parameter of any function in this package.
 */
export function redacted(value: string | null | undefined, limit = REDACTED_TEXT_LIMIT): string {
  if (typeof value !== "string") return "";
  return value.slice(0, limit);
}
