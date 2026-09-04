// What a memory may say, and what its metadata must carry for each kind.
//
// The source holds this as five Zod schemas in `memory-kind.validator.ts`, which
// the REST controller and the `remember` meta-tool both pipe through before
// anything touches the embedding model or the store. The rules are transcribed
// exactly; the library is not, because a schema library is a runtime dependency
// and `domain/` has none (ADR M0.3 §2, §4).
//
// THE RULES ARE DELIBERATELY PERMISSIVE ABOUT PROSE AND STRICT ABOUT STRUCTURE.
// The source says so in as many words — "we don't want to reject a perfectly
// reasonable fact because the extractor happened to write two sentences" — so
// content is checked for emptiness and a length cap and nothing else, while
// metadata is checked for the keys a kind cannot function without:
//
//   relationship  REQUIRES { from, to, type }. A relationship memory must stay
//                 walkable back to an addressable pair even when the graph
//                 tables were not updated, which is the invariant the source
//                 records against this rule.
//   profile       REQUIRES { profileKey }, and normalises it. The key is what
//                 the row is upserted on, so a missing one would append a second
//                 profile row instead of replacing the first.
//   event         `at`, when present, must be a real ISO instant. A malformed
//                 one would sort into the wrong place forever.
//   fact          `subject` and `topic` are optional and typed when present.
//   preference    `over` is a list of strings when present.
//
// EVERY KIND CARRIES THROUGH UNKNOWN KEYS. Each of the source's schemas is a
// `catchall`, so an extractor may stamp its own attributes — the entity slugs
// extraction records under `entities` are exactly that — and this preserves it.
// Rejecting unknown keys would make every extractor upgrade a breaking change.

import { err, ok, type JsonValue, type Result } from "@platos/kernel";

import { invalidContent, invalidMetadata } from "./errors.js";
import type { ContentHash, ProfileKey } from "./identifiers.js";
import { normalizeProfileKey, type MemoryKind } from "./taxonomy.js";

/** The `metadata Json?` column, as a value rather than as `unknown`. */
export type MemoryMetadata = { readonly [key: string]: JsonValue } | null;

/** The cap the source applies to `content`, in code units, before trimming. */
export const MAX_CONTENT_LENGTH = 4000;

/**
 * The instants the source accepts for `event.at`.
 *
 * BOTH HALVES ARE REQUIRED AND NEITHER IS REDUNDANT.
 *
 *   The pattern rejects `2026-09-03`, which is a date and not an instant.
 *   `Date.parse` accepts it, and a stored value with no time-of-day would sort
 *   against real instants as if it happened at midnight UTC.
 *
 *   `Date.parse` rejects `2026-13-01T00:00:00Z`, which the pattern matches:
 *   two digits is two digits, and month thirteen is not a month.
 *
 * WHAT NEITHER CATCHES, stated so nobody assumes otherwise: `2026-02-30`
 * ROLLS OVER to 2 March rather than failing, in every conforming engine. An
 * `at` of the thirtieth of February is therefore stored as the second of March.
 * Rejecting it would need a calendar, and a calendar in a domain module is a
 * dependency this layer does not have.
 */
const ISO_INSTANT = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?(?:Z|[+-]\d{2}:\d{2})$/u;

export function isIsoInstant(value: string): boolean {
  return ISO_INSTANT.test(value) && !Number.isNaN(Date.parse(value));
}

/** A memory's payload after admission: canonical kind, trimmed content, metadata. */
export interface AdmittedContent {
  readonly kind: MemoryKind;
  readonly content: string;
  readonly metadata: MemoryMetadata;
  /** Non-null exactly for `kind = "profile"`. */
  readonly profileKey: ProfileKey | null;
}

export interface ContentDraft {
  readonly kind: MemoryKind;
  readonly content: string;
  readonly metadata: unknown;
}

/**
 * Admit one memory payload.
 *
 * Content first, then the kind's metadata rule. Order matters for the error a
 * caller sees: a blank body with malformed metadata is reported as a blank body,
 * which is the fault they have to fix first.
 */
export function admitContent(draft: ContentDraft): Result<AdmittedContent> {
  const content = admitContentText(draft.content);
  if (!content.ok) return err(content.error);
  const metadata = admitMetadata(draft.kind, draft.metadata);
  if (!metadata.ok) return err(metadata.error);
  return ok({
    kind: draft.kind,
    content: content.value,
    metadata: metadata.value,
    profileKey: draft.kind === "profile" ? readProfileKey(metadata.value) : null,
  });
}

/** Trim, then require non-empty and within the cap. */
export function admitContentText(value: string): Result<string> {
  const trimmed = value.trim();
  if (trimmed.length === 0) {
    return err(invalidContent("content must be non-empty", [
      { field: "content", code: "empty", message: "content must be non-empty" },
    ]));
  }
  if (trimmed.length > MAX_CONTENT_LENGTH) {
    return err(invalidContent(`content exceeds ${MAX_CONTENT_LENGTH} character cap`, [
      { field: "content", code: "too_long", message: `content exceeds ${MAX_CONTENT_LENGTH} character cap` },
    ]));
  }
  return ok(trimmed);
}

/** The per-kind metadata rule. Unknown keys always survive. */
export function admitMetadata(kind: MemoryKind, value: unknown): Result<MemoryMetadata> {
  const object = asJsonObject(value);
  if (object === undefined) {
    return err(invalidMetadata("metadata must be a JSON object or absent", [
      { field: "metadata", code: "not_an_object", message: "metadata must be a JSON object or absent" },
    ]));
  }
  switch (kind) {
    case "fact":
      return checkOptionalStrings(object, ["subject", "topic"]);
    case "preference":
      return checkPreference(object);
    case "event":
      return checkEvent(object);
    case "relationship":
      return checkRelationship(object);
    case "profile":
      return checkProfile(object);
  }
}

/**
 * The `contentHash` an append deduplicates on.
 *
 * Deliberately NOT computed here. The digest is `sha256` in the source, which is
 * a host capability and not a pure value operation, so the algorithm is named by
 * a port (`application/ports/content-digest.ts`) and this module holds only the
 * rule about WHEN a row has one: a memory extracted from a thread carries a hash
 * so re-running the extractor over an unchanged transcript collides with the
 * existing row, and one written by hand does not, because two operators writing
 * the same sentence about a subject are two facts.
 */
export function requiresContentHash(sourceThreadPresent: boolean): boolean {
  return sourceThreadPresent;
}

/** The dedupe identity a store's unique index expresses, as a value. */
export interface ContentIdentity {
  readonly sourceThreadPresent: boolean;
  readonly contentHash: ContentHash | null;
}

export function contentIdentity(
  sourceThreadPresent: boolean,
  contentHash: ContentHash | null,
): ContentIdentity {
  return { sourceThreadPresent, contentHash: sourceThreadPresent ? contentHash : null };
}

function readProfileKey(metadata: MemoryMetadata): ProfileKey | null {
  const raw = metadata?.["profileKey"];
  return typeof raw === "string" ? normalizeProfileKey(raw) : null;
}

/** `undefined` means "not an object"; `null` means "absent", which is legal. */
function asJsonObject(value: unknown): MemoryMetadata | undefined {
  if (value === undefined || value === null) return null;
  if (typeof value !== "object" || Array.isArray(value)) return undefined;
  return value as { readonly [key: string]: JsonValue };
}

function violation(field: string, code: string, message: string): Result<MemoryMetadata> {
  return err(invalidMetadata(message, [{ field: `metadata.${field}`, code, message }]));
}

function checkOptionalStrings(
  metadata: MemoryMetadata,
  keys: readonly string[],
): Result<MemoryMetadata> {
  for (const key of keys) {
    const value = metadata?.[key];
    if (value !== undefined && typeof value !== "string") {
      return violation(key, "not_a_string", `metadata.${key} must be a string when present`);
    }
  }
  return ok(metadata);
}

function checkStringArray(
  metadata: MemoryMetadata,
  key: string,
): Result<MemoryMetadata> {
  const value = metadata?.[key];
  if (value === undefined) return ok(metadata);
  if (!Array.isArray(value) || value.some((element) => typeof element !== "string")) {
    return violation(key, "not_a_string_array", `metadata.${key} must be an array of strings when present`);
  }
  return ok(metadata);
}

function checkPreference(metadata: MemoryMetadata): Result<MemoryMetadata> {
  const withOver = checkStringArray(metadata, "over");
  if (!withOver.ok) return withOver;
  return checkOptionalStrings(metadata, ["ordering"]);
}

function checkEvent(metadata: MemoryMetadata): Result<MemoryMetadata> {
  const at = metadata?.["at"];
  if (at !== undefined) {
    if (typeof at !== "string" || !isIsoInstant(at)) {
      return violation("at", "not_an_instant", "metadata.at must be a valid ISO datetime");
    }
  }
  const withLocation = checkOptionalStrings(metadata, ["location"]);
  if (!withLocation.ok) return withLocation;
  return checkStringArray(metadata, "participants");
}

function checkRelationship(metadata: MemoryMetadata): Result<MemoryMetadata> {
  for (const key of ["from", "to", "type"]) {
    const value = metadata?.[key];
    if (typeof value !== "string" || value.length === 0) {
      return violation(key, "required", `metadata.${key} is required for relationship memories`);
    }
  }
  return ok(metadata);
}

function checkProfile(metadata: MemoryMetadata): Result<MemoryMetadata> {
  const raw = metadata?.["profileKey"];
  if (typeof raw !== "string" || raw.trim().length === 0) {
    return violation("profileKey", "required", "metadata.profileKey is required for profile memories");
  }
  return ok({ ...metadata, profileKey: normalizeProfileKey(raw) });
}
