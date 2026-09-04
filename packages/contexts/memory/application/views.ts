// Projections from domain values onto the published contract shapes.
//
// Kept apart from the use cases so a change to the wire shape cannot quietly
// change a rule, and so the mapping is one small readable table rather than an
// object literal buried in a control-flow branch.
//
// THREE THINGS THE VIEWS DELIBERATELY WITHHOLD, and the reason for each:
//
//   NO EMBEDDING. It never reaches a `Memory` in the first place, so there is
//   nothing to strip — but the omission is worth stating, because a view is
//   where a 1536-float column would eventually be added "for debugging".
//
//   NO INTERNAL END-USER ID. A view names the subject by the id the CALLER used,
//   which the transport resolved through identity-access. Handing out the row's
//   own `endUserId` would leak a handle into another context's store.
//
//   NO `contentHash`. It is a dedupe key, and publishing it would let a caller
//   probe for the existence of a memory it cannot read by writing the same
//   sentence and watching for a collision.

import type {
  EntityView,
  MemoryView,
  PathHopView,
  RecalledMemoryView,
  RelationshipView,
} from "../contracts/index.js";
import {
  isAgentVisible,
  type Memory,
  type MemoryEntity,
  type MemoryRelationship,
  type PathHop,
} from "../domain/index.js";
import type { RecalledMemory } from "./recall.js";

export function toMemoryView(memory: Memory): MemoryView {
  return {
    memoryId: memory.memoryId,
    environmentId: memory.subject.environment.environmentId,
    agentId: memory.ownership.agentId,
    clusterId: memory.ownership.clusterId,
    kind: memory.kind,
    profileKey: memory.profileKey,
    content: memory.content,
    metadata: memory.metadata,
    visibility: memory.visibility,
    // Derived, never stored apart. A view that carried a stored boolean could
    // disagree with the column that decides recall.
    agentVisible: isAgentVisible(memory),
    source: memory.source,
    sourceThreadId: memory.provenance.sourceThreadId,
    sourceTurnIds: memory.provenance.sourceTurnIds,
    extractorVersion: memory.provenance.extractorVersion,
    confidence: memory.confidence.confidence,
    lastAccessedAt: memory.lifecycle.lastAccessedAt,
    quarantinedAt: memory.lifecycle.quarantinedAt,
    archivedAt: memory.lifecycle.archivedAt,
    createdAt: memory.lifecycle.createdAt,
    updatedAt: memory.lifecycle.updatedAt,
  };
}

export function toRecalledMemoryView(recalled: RecalledMemory): RecalledMemoryView {
  return {
    memory: toMemoryView(recalled.memory),
    score: recalled.score,
    rankingScore: recalled.rankingScore,
    signals: [],
  };
}

/** The fused view carries which signals surfaced the memory; recall's does not. */
export function toFusedMemoryView(
  fused: RecalledMemory & { readonly signals: readonly string[] },
): RecalledMemoryView {
  return { ...toRecalledMemoryView(fused), signals: fused.signals };
}

export function toEntityView(entity: MemoryEntity): EntityView {
  return {
    entityId: entity.entityId,
    entityKey: entity.entityKey,
    entityType: entity.entityType,
    label: entity.label,
    aliases: entity.aliases,
    metadata: entity.metadata,
    agentId: entity.ownership.agentId,
    clusterId: entity.ownership.clusterId,
    createdAt: entity.createdAt,
    updatedAt: entity.updatedAt,
  };
}

export function toRelationshipView(relationship: MemoryRelationship): RelationshipView {
  return {
    relationshipId: relationship.relationshipId,
    fromEntityId: relationship.fromEntityId,
    toEntityId: relationship.toEntityId,
    relationshipType: relationship.relationshipType,
    weight: relationship.weight,
    metadata: relationship.metadata,
    sourceMemoryId: relationship.sourceMemoryId,
    createdAt: relationship.createdAt,
  };
}

export function toPathHopView(hop: PathHop): PathHopView {
  return {
    entityId: hop.entityId,
    relationship: hop.relationship === null ? null : toRelationshipView(hop.relationship),
    direction: hop.direction,
  };
}
