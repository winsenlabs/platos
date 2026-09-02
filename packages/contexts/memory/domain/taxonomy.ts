// The four closed vocabularies a `Memory` row carries, and the one rule that
// relates two of them.
//
// The baseline schema declares `kind`, `visibility` and `source` as plain
// `String` columns, so every one of these sets is a DOMAIN invariant rather than
// a database constraint. The extraction source keeps them in
// `@platos/tenancy-database/memory-contract`, which is a package this context
// may not import (ADR M0.3 §2 bans a generated Prisma client from `domain/`, and
// that module is published from one). The values are transcribed here unchanged
// — they are the vocabulary already in the store and already on the wire — and
// a contract test in the adopting adapter is what will keep the two spellings
// equal at the seam.
//
// `agentVisible` AND `visibility` ARE ONE FACT STORED TWICE. The schema carries
// both: a `Boolean` that predates the vocabulary and the three-valued column
// that replaced it. `normalizeVisibility` below is the single derivation the
// source performs in four places, and `agentVisibleFor` is the projection back.
// Keeping the boolean derived rather than settable is what stops a row from
// existing that is `hidden` and `agentVisible = true` at the same time.

import { err, ok, type Result } from "@platos/kernel";

import { invalidKind, invalidSource, invalidVisibility } from "./errors.js";
import type { ProfileKey } from "./identifiers.js";

/** What a memory IS. `profile` is upserted per key; the other four append. */
export const MEMORY_KINDS = ["fact", "preference", "event", "relationship", "profile"] as const;
export type MemoryKind = (typeof MEMORY_KINDS)[number];

/**
 * Who may recall it.
 *
 *   agent_visible  eligible for agent recall inside the owner scope.
 *   hidden         operator-visible persistence, excluded from agent recall.
 *   private        explicitly private persistence, excluded from agent recall.
 *
 * `hidden` and `private` are both invisible to an agent and are still two
 * values: one is an operator's decision about a row, the other is the subject's.
 * A surface offering "unhide" must not offer it for the second.
 */
export const MEMORY_VISIBILITIES = ["agent_visible", "hidden", "private"] as const;
export type MemoryVisibility = (typeof MEMORY_VISIBILITIES)[number];

/** Where it came from. Only `manual` may be claimed by an untrusted caller. */
export const MEMORY_SOURCES = ["manual", "extracted", "imported", "rag"] as const;
export type MemorySource = (typeof MEMORY_SOURCES)[number];

/** Which side of `archivedAt IS NULL` a query wants. */
export const MEMORY_ARCHIVE_STATES = ["active", "archived", "all"] as const;
export type MemoryArchiveState = (typeof MEMORY_ARCHIVE_STATES)[number];

/**
 * Retrieval-augmented rows share the table and are NOT durable memory.
 *
 * They are ingested documents, not things the subject said about themselves, so
 * every recall path that feeds a turn excludes them and every profile synthesis
 * drops them. Naming the constant once is what keeps that exclusion from being
 * a string literal repeated at five call sites, which is how the source held it.
 */
export const RAG_SOURCE: MemorySource = "rag";

/** The four kinds profile synthesis rolls up. `profile` is its OUTPUT. */
export const ATOM_KINDS: readonly MemoryKind[] = Object.freeze([
  "fact",
  "preference",
  "event",
  "relationship",
]);

export function isMemoryKind(value: unknown): value is MemoryKind {
  return typeof value === "string" && (MEMORY_KINDS as readonly string[]).includes(value);
}

export function isMemoryVisibility(value: unknown): value is MemoryVisibility {
  return typeof value === "string" && (MEMORY_VISIBILITIES as readonly string[]).includes(value);
}

export function isMemorySource(value: unknown): value is MemorySource {
  return typeof value === "string" && (MEMORY_SOURCES as readonly string[]).includes(value);
}

export function isMemoryArchiveState(value: unknown): value is MemoryArchiveState {
  return typeof value === "string" && (MEMORY_ARCHIVE_STATES as readonly string[]).includes(value);
}

export function isAtomKind(kind: MemoryKind): boolean {
  return ATOM_KINDS.includes(kind);
}

/**
 * Read a caller-supplied kind, defaulting to `fact`.
 *
 * The source lower-cases before matching and this keeps that: `Fact` and `fact`
 * are one kind, and the stored value is always the canonical spelling.
 */
export function requireMemoryKind(value: string | null | undefined): Result<MemoryKind> {
  const candidate = (value ?? "fact").toLowerCase();
  if (!isMemoryKind(candidate)) return err(invalidKind(String(value), MEMORY_KINDS));
  return ok(candidate);
}

export function requireMemorySource(value: unknown): Result<MemorySource> {
  if (!isMemorySource(value)) return err(invalidSource(MEMORY_SOURCES));
  return ok(value);
}

/**
 * The one derivation between the legacy boolean and the three-valued column.
 *
 * An explicit `visibility` always wins and is validated. Only when none is given
 * does the boolean speak, and it speaks in exactly one direction: `false` means
 * `hidden`, and everything else — `true`, `undefined`, absent — means
 * `agent_visible`. That asymmetry is the source's, and it matters: a caller who
 * never heard of the column must not be able to produce a `private` row by
 * accident.
 */
export function normalizeVisibility(
  explicit: unknown,
  legacyAgentVisible: boolean | undefined,
): Result<MemoryVisibility> {
  if (explicit !== undefined && explicit !== null) {
    if (!isMemoryVisibility(explicit)) return err(invalidVisibility(MEMORY_VISIBILITIES));
    return ok(explicit);
  }
  return ok(legacyAgentVisible === false ? "hidden" : "agent_visible");
}

/** The boolean column, derived. Never read from a caller, never stored apart. */
export function agentVisibleFor(visibility: MemoryVisibility): boolean {
  return visibility === "agent_visible";
}

/**
 * A visibility filter for a read.
 *
 * `undefined` is not the empty filter: the source treats "the caller named no
 * visibilities" as RUNTIME RECALL, which is agent-visible only, and treats an
 * explicit list as an operator query that may reach hidden rows. Returning a
 * distinguishable union rather than a possibly-empty array is what keeps a
 * transport that forgot to pass the field from widening recall.
 */
export type VisibilityFilter =
  | { readonly kind: "runtime-recall"; readonly visibilities: readonly MemoryVisibility[] }
  | { readonly kind: "explicit"; readonly visibilities: readonly MemoryVisibility[] };

export const RUNTIME_RECALL_FILTER: VisibilityFilter = Object.freeze({
  kind: "runtime-recall",
  visibilities: Object.freeze(["agent_visible" as MemoryVisibility]),
});

/**
 * Read an operator-supplied visibility list.
 *
 * An empty array is REFUSED rather than treated as "no filter". The source
 * rejects it too, and the reason is worth stating: `visibilityIn: []` most often
 * arrives from a surface that filtered its own list down to nothing, and
 * answering it with every row is the widest possible misreading of the request.
 */
export function requireVisibilityFilter(
  values: readonly MemoryVisibility[] | undefined,
): Result<VisibilityFilter> {
  if (values === undefined) return ok(RUNTIME_RECALL_FILTER);
  if (values.length === 0 || !values.every(isMemoryVisibility)) {
    return err(invalidVisibility(MEMORY_VISIBILITIES));
  }
  return ok({ kind: "explicit", visibilities: Object.freeze([...new Set(values)]) });
}

/**
 * `Memory.profileKey`, normalised.
 *
 * Trim and lower-case in an EXPLICIT locale. `toLowerCase()` with no argument
 * follows the host's locale, and in a Turkish one a dotted capital I lower-cases
 * to a dotless i — which would give a profile key that no longer collides with
 * the row it is meant to upsert. The source pins `en-US` for exactly that
 * reason and this preserves it.
 */
export function normalizeProfileKey(value: string): ProfileKey {
  return value.trim().toLocaleLowerCase("en-US") as ProfileKey;
}

/**
 * The reserved profile key the synthesized narrative occupies.
 *
 * A leading underscore is not a naming style here; it is what keeps the
 * maintained narrative out of the namespace an operator writes structured
 * profile facts into.
 */
export const SYNTHESIZED_PROFILE_KEY: ProfileKey = normalizeProfileKey("_synthesized");
