// The `Memory` aggregate — one durable thing known about one subject.
//
// The row is dense (twenty-six columns) and the density is not accidental: it
// carries the fact, who formed it, what it was formed from, how much it is
// trusted, and three independent lifecycle instants. This module groups those
// into the four values they actually are — `provenance`, `confidence`,
// `lifecycle` and the content itself — so that a rule about one of them cannot
// reach the others by mistake.
//
// THE THREE LIFECYCLE INSTANTS ARE INDEPENDENT AND ALL THREE ARE NULLABLE.
//
//   archivedAt      an operator put it away. Reversible, and the default read
//                   excludes it.
//   quarantinedAt   negative feedback withdrew it from recall. NOT an operator
//                   decision — `domain/confidence.ts` sets and clears it from
//                   the current ratings, and it is the one state a caller cannot
//                   set by hand.
//   lastAccessedAt  recall touched it. Ordering only; never a filter.
//
// A single `status` enum would have been smaller and wrong: a memory can be
// archived AND quarantined, and collapsing them would make un-archiving silently
// restore something feedback had withdrawn.
//
// THE MERGE RULE IS THE `ON CONFLICT` CLAUSE, AS A FUNCTION. The source appends
// with `ON CONFLICT (environmentId, endUserId, sourceThreadId, contentHash) DO
// UPDATE`, unioning the source turns and taking the GREATER confidence. That is
// a domain decision about what re-extracting an unchanged transcript means, so
// it is `mergeRepeatedExtraction` below rather than a string inside an adapter.

import { err, ok, type Result } from "@platos/kernel";

import { boundedConfidence } from "./confidence.js";
import type { MemoryMetadata } from "./content.js";
import { provenanceIncomplete } from "./errors.js";
import type { ContentHash, MemoryId, ProfileKey, ThreadId, TurnId } from "./identifiers.js";
import type { MemoryOwnership, MemorySubject } from "./scope.js";
import { agentVisibleFor, type MemoryKind, type MemorySource, type MemoryVisibility } from "./taxonomy.js";

/**
 * Where a memory came from.
 *
 * `sourceTurnIds` without a `sourceThreadId` is refused (`admitProvenance`): the
 * turns would be unresolvable, since a turn is only addressable inside its
 * thread and this context may not import conversations to look one up.
 *
 * The three `original*` fields are INERT. The schema's own comment calls them
 * "inert provenance retained across import and legacy normalization; never
 * resolved as live FKs", and nothing in this context reads them for a decision —
 * they are carried so an imported memory does not lose where it was before.
 */
export interface MemoryProvenance {
  readonly sourceThreadId: ThreadId | null;
  readonly sourceTurnIds: readonly TurnId[];
  readonly extractorVersion: string | null;
  readonly originalSource: string | null;
  readonly originalSourceThreadId: string | null;
  readonly originalSourceTurnIds: readonly string[];
}

export const NO_PROVENANCE: MemoryProvenance = Object.freeze({
  sourceThreadId: null,
  sourceTurnIds: Object.freeze([]),
  extractorVersion: null,
  originalSource: null,
  originalSourceThreadId: null,
  originalSourceTurnIds: Object.freeze([]),
});

/** The two confidence columns. The baseline is what feedback adjusts FROM. */
export interface MemoryConfidence {
  readonly confidence: number | null;
  readonly feedbackBaselineConfidence: number | null;
}

export const NO_CONFIDENCE: MemoryConfidence = Object.freeze({
  confidence: null,
  feedbackBaselineConfidence: null,
});

export interface MemoryLifecycle {
  readonly lastAccessedAt: Date | null;
  readonly quarantinedAt: Date | null;
  readonly archivedAt: Date | null;
  readonly createdAt: Date;
  readonly updatedAt: Date;
}

export interface Memory {
  readonly memoryId: MemoryId;
  readonly subject: MemorySubject;
  readonly ownership: MemoryOwnership;
  readonly kind: MemoryKind;
  readonly profileKey: ProfileKey | null;
  readonly content: string;
  readonly metadata: MemoryMetadata;
  readonly visibility: MemoryVisibility;
  readonly source: MemorySource;
  readonly contentHash: ContentHash | null;
  readonly provenance: MemoryProvenance;
  readonly confidence: MemoryConfidence;
  readonly lifecycle: MemoryLifecycle;
}

/** The derived boolean column. Never stored apart from `visibility`. */
export function isAgentVisible(memory: Memory): boolean {
  return agentVisibleFor(memory.visibility);
}

export function isArchived(memory: Memory): boolean {
  return memory.lifecycle.archivedAt !== null;
}

export function isQuarantined(memory: Memory): boolean {
  return memory.lifecycle.quarantinedAt !== null;
}

/**
 * Eligible for a turn's recall.
 *
 * Three conditions, and all three are separately reachable: an archived row was
 * put away, a quarantined row was withdrawn by feedback, and a non-agent-visible
 * row was never for the agent. A surface that showed one flag could not tell an
 * operator which of the three to undo.
 */
export function isRecallable(memory: Memory): boolean {
  return !isArchived(memory) && !isQuarantined(memory) && isAgentVisible(memory);
}

/** Does a row belong to the requested side of `archivedAt IS NULL`? */
export function matchesArchiveState(memory: Memory, state: "active" | "archived" | "all"): boolean {
  if (state === "all") return true;
  return state === "archived" ? isArchived(memory) : !isArchived(memory);
}

/**
 * Admit a provenance draft.
 *
 * Turn ids are de-duplicated — the source does the same, and a repeated turn id
 * would double-count in feedback reconciliation, where the ratings of every
 * source turn are aggregated.
 */
export function admitProvenance(draft: {
  readonly sourceThreadId: ThreadId | null;
  readonly sourceTurnIds: readonly TurnId[];
  readonly extractorVersion: string | null;
}): Result<MemoryProvenance> {
  const turnIds = [...new Set(draft.sourceTurnIds)];
  if (turnIds.length > 0 && draft.sourceThreadId === null) {
    return err(
      provenanceIncomplete("memory source turns require a source thread", {
        sourceTurnCount: String(turnIds.length),
      }),
    );
  }
  return ok({
    ...NO_PROVENANCE,
    sourceThreadId: draft.sourceThreadId,
    sourceTurnIds: Object.freeze(turnIds),
    extractorVersion: draft.extractorVersion,
  });
}

export function archive(memory: Memory, now: Date): Result<Memory> {
  if (isArchived(memory)) return ok(memory);
  return ok(withLifecycle(memory, { archivedAt: now, updatedAt: now }));
}

export function restore(memory: Memory, now: Date): Result<Memory> {
  if (!isArchived(memory)) return ok(memory);
  return ok(withLifecycle(memory, { archivedAt: null, updatedAt: now }));
}

/**
 * Stamp a recall.
 *
 * `updatedAt` is deliberately NOT advanced: reading a memory is not a revision
 * of it, and letting recall touch `updatedAt` would make every listing reorder
 * itself under load.
 */
export function touchAccess(memory: Memory, now: Date): Memory {
  return withLifecycle(memory, { lastAccessedAt: now });
}

/**
 * What re-extracting an unchanged transcript does to the row already there.
 *
 * This is the source's `ON CONFLICT ... DO UPDATE` clause, and each of its four
 * assignments encodes a decision:
 *
 *   sourceTurnIds     UNIONED, not replaced. A later sweep over a longer window
 *                     saw the same fact in more turns; both are true, and
 *                     feedback aggregates over all of them.
 *   confidence        the GREATER of the two, with a missing value counting as
 *                     zero. A second sighting cannot lower confidence in a fact.
 *   extractorVersion  the newer one, so a row records which extractor last
 *                     confirmed it.
 *   lastAccessedAt    advanced, because the fact was just re-observed.
 *
 * Content, metadata, visibility and ownership are UNTOUCHED. The rows collided
 * on a content hash, so the content is already equal, and an operator's later
 * edit to visibility must not be undone by a background sweep.
 */
export function mergeRepeatedExtraction(existing: Memory, incoming: Memory, now: Date): Memory {
  const turnIds = [...new Set([...existing.provenance.sourceTurnIds, ...incoming.provenance.sourceTurnIds])];
  const confidence = Math.max(existing.confidence.confidence ?? 0, incoming.confidence.confidence ?? 0);
  return {
    ...existing,
    provenance: {
      ...existing.provenance,
      sourceTurnIds: Object.freeze(turnIds),
      extractorVersion: incoming.provenance.extractorVersion ?? existing.provenance.extractorVersion,
    },
    confidence: { ...existing.confidence, confidence: boundedConfidence(confidence) },
    lifecycle: { ...existing.lifecycle, lastAccessedAt: now, updatedAt: now },
  };
}

/**
 * What writing a profile key that already exists does.
 *
 * The other kinds append; `profile` upserts, because a profile row is one
 * structured fact per key and a second row for `role` would make "what is their
 * role?" ambiguous. Unlike the extraction merge, this DOES replace the content
 * and the metadata — that is the whole point of a profile write — and it clears
 * `archivedAt`, so writing a key an operator had archived brings it back rather
 * than silently updating something invisible.
 */
export function replaceProfileRevision(existing: Memory, incoming: Memory, now: Date): Memory {
  return {
    ...incoming,
    memoryId: existing.memoryId,
    lifecycle: {
      ...existing.lifecycle,
      archivedAt: null,
      updatedAt: now,
    },
  };
}

/** Do two rows collide on the dedupe identity the store's unique index expresses? */
export function collidesOnContent(left: Memory, right: Memory): boolean {
  if (left.contentHash === null || right.contentHash === null) return false;
  return (
    left.subject.environment.environmentId === right.subject.environment.environmentId &&
    left.subject.endUserId === right.subject.endUserId &&
    left.provenance.sourceThreadId === right.provenance.sourceThreadId &&
    left.contentHash === right.contentHash
  );
}

/** Do two rows collide on the profile identity — (subject, ownership, key)? */
export function collidesOnProfileKey(left: Memory, right: Memory): boolean {
  if (left.profileKey === null || left.profileKey !== right.profileKey) return false;
  if (left.subject.endUserId !== right.subject.endUserId) return false;
  if (left.subject.environment.environmentId !== right.subject.environment.environmentId) return false;
  return left.ownership.clusterId === null
    ? right.ownership.clusterId === null && left.ownership.agentId === right.ownership.agentId
    : left.ownership.clusterId === right.ownership.clusterId;
}

function withLifecycle(memory: Memory, patch: Partial<MemoryLifecycle>): Memory {
  return { ...memory, lifecycle: { ...memory.lifecycle, ...patch } };
}
