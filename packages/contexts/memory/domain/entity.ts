// The `MemoryEntity` aggregate — a node in the subject's knowledge graph.
//
// An entity is a stable handle for a person, organisation, project or place that
// keeps recurring in a subject's conversations. Its identity is the SLUG, not the
// row id: the same person must resolve to the same node in a session six weeks
// later, and an extractor that has never seen the row has only the name to go on.
//
// UPSERT IS THE ONLY WRITE, AND ITS OWNERSHIP RULE IS THE SUBTLE PART. A node is
// owned either by ONE AGENT or by A WHOLE CLUSTER, and which it is follows the
// writing agent's binding rather than anything the caller states. Three cases,
// and the third is the one that carries a real decision:
//
//   unclustered agent  one node per (subject, agent, key).
//   clustered agent    one node per (subject, cluster, key) — shared.
//   BOTH ALREADY EXIST an agent-owned node and a cluster-owned node for the same
//                      key. REFUSED. Merging them would publish one agent's
//                      private node to every member of its cluster, and there is
//                      no reading of the caller's request that asks for that.
//
// A standalone node whose agent has SINCE JOINED a cluster is PROMOTED into it
// rather than duplicated. That is the source's behaviour and it is the right one:
// the alternative leaves the subject with two nodes for one person, one of which
// nobody can reach.

import { err, ok, type Result } from "@platos/kernel";

import type { MemoryMetadata } from "./content.js";
import { entityKeyInvalid, entityOwnershipConflict } from "./errors.js";
import type { EntityKey, MemoryEntityId } from "./identifiers.js";
import type { MemoryOwnership, MemorySubject } from "./scope.js";

/** The open `entityType` vocabulary the extractor produces. Not a closed set. */
export const ENTITY_TYPE_PERSON = "person";
export const ENTITY_TYPE_ORGANIZATION = "org";
export const ENTITY_TYPE_PROJECT = "project";
export const ENTITY_TYPE_CONCEPT = "concept";
export const ENTITY_TYPE_LOCATION = "location";
export const ENTITY_TYPE_OTHER = "other";

/** The fallback the source applies when an extractor supplies no type. */
export const DEFAULT_ENTITY_TYPE = ENTITY_TYPE_OTHER;

/** The slug cap. Long enough for a full company name, short enough to index. */
export const MAX_ENTITY_KEY_LENGTH = 60;

export interface MemoryEntity {
  readonly entityId: MemoryEntityId;
  readonly subject: MemorySubject;
  readonly ownership: MemoryOwnership;
  readonly entityKey: EntityKey;
  readonly entityType: string;
  readonly label: string;
  readonly aliases: readonly string[];
  readonly metadata: MemoryMetadata;
  readonly createdAt: Date;
  readonly updatedAt: Date;
}

/**
 * The deterministic slug an entity key is derived from.
 *
 * Lower-case, NFKD-normalised, every run of non-alphanumerics collapsed to a
 * single dash, dashes trimmed from both ends, capped. The NFKD step is what
 * makes `José` and `Jose` one key rather than two, which is the difference
 * between a graph that accumulates a person and one that accumulates spellings
 * of them.
 *
 * Note it is NOT reversible and is not meant to be — `label` carries the
 * display form, and the slug exists only so two mentions collide.
 */
export function stableSlug(raw: string): string {
  return raw
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[^a-z0-9]+/gu, "-")
    .replace(/^-+|-+$/gu, "")
    .slice(0, MAX_ENTITY_KEY_LENGTH);
}

export function admitEntityKey(raw: string): Result<EntityKey> {
  const slug = stableSlug(raw);
  if (slug.length === 0) return err(entityKeyInvalid(raw));
  return ok(slug as EntityKey);
}

/** What an upsert states. Absent fields leave the stored value alone. */
export interface EntityDraft {
  readonly entityKey: EntityKey;
  readonly entityType?: string;
  readonly label?: string;
  readonly aliases?: readonly string[];
  readonly metadata?: MemoryMetadata;
}

/**
 * The candidates an upsert must consider, as the store found them.
 *
 * Both are nullable and both may be present at once, which is the conflict case.
 * Passing them as a pair rather than as a list is what makes that case a
 * compile-time-visible branch rather than a length check.
 */
export interface EntityCandidates {
  /** A node owned by the writing agent's cluster, if it has one. */
  readonly clustered: MemoryEntity | null;
  /** A node owned by the writing agent alone. */
  readonly standalone: MemoryEntity | null;
}

export type EntityUpsertPlan =
  | { readonly action: "create"; readonly draft: EntityDraft }
  | { readonly action: "update"; readonly entity: MemoryEntity }
  | { readonly action: "promote"; readonly entity: MemoryEntity };

/**
 * Decide what an upsert does, given what already exists.
 *
 * `promote` is distinct from `update` because it changes OWNERSHIP as well as
 * content — the node moves from one agent to the whole cluster — and a caller
 * (or an audit trail) that could not tell the two apart would not be able to see
 * that a private node had become a shared one.
 */
export function planEntityUpsert(
  ownership: MemoryOwnership,
  candidates: EntityCandidates,
  draft: EntityDraft,
): Result<EntityUpsertPlan> {
  if (ownership.clusterId === null) {
    return ok(
      candidates.standalone === null
        ? { action: "create", draft }
        : { action: "update", entity: candidates.standalone },
    );
  }
  if (candidates.clustered !== null && candidates.standalone !== null) {
    return err(entityOwnershipConflict(draft.entityKey));
  }
  if (candidates.standalone !== null) return ok({ action: "promote", entity: candidates.standalone });
  if (candidates.clustered !== null) return ok({ action: "update", entity: candidates.clustered });
  return ok({ action: "create", draft });
}

/**
 * Fold a draft onto a stored node.
 *
 * An ABSENT field leaves the stored value; a field that is present replaces it.
 * That distinction is why `EntityDraft`'s fields are optional rather than
 * nullable: an extractor that saw a mention without a type must not blank the
 * type an earlier, better-informed sighting recorded.
 */
export function applyEntityDraft(entity: MemoryEntity, draft: EntityDraft, now: Date): MemoryEntity {
  return {
    ...entity,
    entityType: draft.entityType ?? entity.entityType,
    label: draft.label ?? entity.label,
    aliases: draft.aliases === undefined ? entity.aliases : mergeAliases(entity.aliases, draft.aliases),
    metadata: draft.metadata === undefined ? entity.metadata : draft.metadata,
    updatedAt: now,
  };
}

/** Promotion is an ownership change plus the ordinary fold. */
export function promoteEntity(
  entity: MemoryEntity,
  ownership: MemoryOwnership,
  draft: EntityDraft,
  now: Date,
): MemoryEntity {
  return { ...applyEntityDraft(entity, draft, now), ownership };
}

/**
 * Union the alias lists, preserving first-seen order and dropping blanks.
 *
 * Union rather than replace: aliases accumulate as a subject refers to the same
 * entity by more names, and each one is a way a future mention might arrive.
 * Order is preserved so the list stays stable between writes, which keeps a
 * stored row from changing every time an upsert repeats.
 */
export function mergeAliases(
  existing: readonly string[],
  incoming: readonly string[],
): readonly string[] {
  const merged: string[] = [];
  const seen = new Set<string>();
  for (const alias of [...existing, ...incoming]) {
    const trimmed = alias.trim();
    if (trimmed.length === 0 || seen.has(trimmed)) continue;
    seen.add(trimmed);
    merged.push(trimmed);
  }
  return Object.freeze(merged);
}

/**
 * The entity slugs a memory was tagged with by extraction.
 *
 * Extraction stamps `metadata.entities` so the trace from a memory back to the
 * graph is a lookup and not a search. Anything that is not a list of strings
 * yields nothing — a memory written by hand has no such key, and that is not an
 * error.
 */
export function taggedEntityKeys(metadata: MemoryMetadata): readonly string[] {
  const tagged = metadata?.["entities"];
  if (!Array.isArray(tagged)) return [];
  return tagged.filter((value): value is string => typeof value === "string");
}
