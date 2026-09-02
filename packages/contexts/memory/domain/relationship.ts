// The `MemoryRelationship` aggregate — a typed, directed edge between two nodes.
//
// The edge's identity is `(fromEntityId, toEntityId, relationshipType)`, which
// the baseline schema carries as a unique constraint. That shape says three
// things worth reading off it:
//
//   DIRECTION IS PART OF THE IDENTITY. `a works_at b` and `b works_at a` are two
//   different edges, and one of them is usually false. Traversal reads edges in
//   both directions (`domain/traversal.ts`) without conflating them.
//
//   THE TYPE IS PART OF THE IDENTITY. The same pair may be joined by several
//   typed edges — `works_at` and `founded` — and each is its own fact.
//
//   THERE IS NO SECOND EDGE OF ONE TYPE BETWEEN ONE PAIR. Re-asserting an edge
//   updates the weight rather than accumulating duplicates, so a subject who
//   mentions the same relationship in forty sessions has one edge, not forty.
//
// AN EDGE CANNOT CROSS AN OWNERSHIP BOUNDARY. Both endpoints must be readable
// from one agent scope (`canShareAgentScope`). Without that check, an agent
// could join its own private node to a peer's and read the peer's node back out
// through the traversal — which is the cross-agent leak the whole ownership
// model exists to prevent.

import { err, ok, type Result } from "@platos/kernel";

import type { MemoryMetadata } from "./content.js";
import { relationshipEndpointsSplit, relationshipInvalid } from "./errors.js";
import type { MemoryEntityId, MemoryId, MemoryRelationshipId } from "./identifiers.js";
import { canShareAgentScope, type MemoryOwnership, type MemorySubject } from "./scope.js";

/** The open `relationshipType` vocabulary. Like `entityType`, not a closed set. */
export const RELATIONSHIP_TYPE_WORKS_AT = "works_at";
export const RELATIONSHIP_TYPE_OWNS = "owns";
export const RELATIONSHIP_TYPE_PREFERS = "prefers";
export const RELATIONSHIP_TYPE_MENTIONS = "mentions";

export interface MemoryRelationship {
  readonly relationshipId: MemoryRelationshipId;
  readonly subject: MemorySubject;
  readonly ownership: MemoryOwnership;
  readonly fromEntityId: MemoryEntityId;
  readonly toEntityId: MemoryEntityId;
  readonly relationshipType: string;
  /** Optional strength in [0, 1]. Null means "asserted, unweighted". */
  readonly weight: number | null;
  readonly metadata: MemoryMetadata;
  /**
   * The memory that produced the edge, when one did. `onDelete: SetNull` in the
   * schema: deleting the memory leaves the edge standing but unattributed, which
   * is deliberate — the relationship was still observed.
   */
  readonly sourceMemoryId: MemoryId | null;
  readonly createdAt: Date;
}

/** The unique constraint, as a value a test and a store can both compare. */
export interface RelationshipIdentity {
  readonly fromEntityId: MemoryEntityId;
  readonly toEntityId: MemoryEntityId;
  readonly relationshipType: string;
}

export function relationshipIdentity(relationship: RelationshipIdentity): RelationshipIdentity {
  return {
    fromEntityId: relationship.fromEntityId,
    toEntityId: relationship.toEntityId,
    relationshipType: relationship.relationshipType,
  };
}

export function sameRelationship(left: RelationshipIdentity, right: RelationshipIdentity): boolean {
  return (
    left.fromEntityId === right.fromEntityId &&
    left.toEntityId === right.toEntityId &&
    left.relationshipType === right.relationshipType
  );
}

export interface RelationshipDraft {
  readonly fromEntityId: MemoryEntityId;
  readonly toEntityId: MemoryEntityId;
  readonly relationshipType: string;
  readonly weight?: number | null;
  readonly metadata?: MemoryMetadata;
  readonly sourceMemoryId?: MemoryId | null;
}

/**
 * Admit an edge, given both endpoints' ownership as the store resolved it.
 *
 * The type is trimmed and required. The weight, when present, must be a finite
 * number in [0, 1]: an unbounded weight would order a neighbourhood arbitrarily
 * against the bounded ones beside it.
 */
export function admitRelationship(
  draft: RelationshipDraft,
  from: MemoryOwnership,
  to: MemoryOwnership,
): Result<RelationshipDraft> {
  const relationshipType = draft.relationshipType.trim();
  if (relationshipType.length === 0) {
    return err(relationshipInvalid("a relationship type is required"));
  }
  if (draft.weight !== undefined && draft.weight !== null) {
    if (!Number.isFinite(draft.weight) || draft.weight < 0 || draft.weight > 1) {
      return err(relationshipInvalid("relationship weight must be between 0 and 1"));
    }
  }
  if (!canShareAgentScope(from, to)) {
    return err(relationshipEndpointsSplit(draft.fromEntityId, draft.toEntityId));
  }
  return ok({ ...draft, relationshipType });
}

/**
 * Re-asserting an existing edge.
 *
 * The weight is replaced when the new assertion carries one and is left alone
 * when it does not, so an extractor that stated no weight does not erase one an
 * earlier, better-informed pass recorded. `createdAt` never moves: the edge was
 * first observed when it was first observed.
 */
export function reassertRelationship(
  existing: MemoryRelationship,
  draft: RelationshipDraft,
): MemoryRelationship {
  return {
    ...existing,
    weight: draft.weight === undefined ? existing.weight : draft.weight,
    metadata: draft.metadata === undefined ? existing.metadata : draft.metadata,
    sourceMemoryId: draft.sourceMemoryId === undefined ? existing.sourceMemoryId : draft.sourceMemoryId,
  };
}

/** Which way an edge was walked. Traversal reports it; storage does not hold it. */
export type EdgeDirection = "out" | "in";

/** One edge as seen from a node, with the direction it was reached by. */
export interface IncidentEdge {
  readonly relationship: MemoryRelationship;
  readonly direction: EdgeDirection;
  /** The node at the other end. */
  readonly neighbourId: MemoryEntityId;
}

/** Split a node's incident edges into the two directions, preserving order. */
export function incidentEdges(
  entityId: MemoryEntityId,
  edges: readonly MemoryRelationship[],
): readonly IncidentEdge[] {
  const incident: IncidentEdge[] = [];
  for (const relationship of edges) {
    if (relationship.fromEntityId === entityId) {
      incident.push({ relationship, direction: "out", neighbourId: relationship.toEntityId });
    } else if (relationship.toEntityId === entityId) {
      incident.push({ relationship, direction: "in", neighbourId: relationship.fromEntityId });
    }
  }
  return Object.freeze(incident);
}
