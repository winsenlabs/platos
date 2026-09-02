// An in-memory `KnowledgeGraphRepository`.
//
// Like its sibling, it enforces what the store enforces rather than saying yes:
//
//   THE EDGE UNIQUE IS REAL. A second edge on `(from, to, type)` is REFUSED, so
//   a use case that forgot to probe before inserting fails here. That is the
//   whole reason `relateEntities` is idempotent, and an assertion that it is
//   would be vacuous against a double that permitted duplicates.
//
//   THE ENTITY OWNERSHIP SPLIT IS REAL. `findEntityCandidates` returns the
//   cluster-owned node and the agent-owned node SEPARATELY, and both can be
//   present — which is the conflict `planEntityUpsert` refuses and which a
//   single-row lookup could never reproduce.
//
//   EVERY READ IS FILTERED BY SUBJECT AND BY AGENT, including the edge read
//   traversal expands with. A traversal that walked out of its agent scope is a
//   test failure here.

import { err, ok, type Result, type TransactionScope } from "@platos/kernel";

import {
  repositoryUnavailable,
  sameRelationship,
  type AgentId,
  type EntityKey,
  type MemoryEntity,
  type MemoryEntityId,
  type MemoryOwnership,
  type MemoryRelationship,
  type MemoryRelationshipId,
  type MemorySubject,
  type RelationshipIdentity,
} from "../../domain/index.js";
import type {
  EntityMatch,
  EntityPage,
  EntitySearchQuery,
  KnowledgeGraphRepository,
  MemoryErasureSelector,
} from "../ports/index.js";
import { cosineSimilarity, deterministicEmbedding } from "./in-memory-embedding-model.js";

export class InMemoryKnowledgeGraphRepository implements KnowledgeGraphRepository {
  private readonly entities = new Map<MemoryEntityId, MemoryEntity>();
  private readonly edges = new Map<MemoryRelationshipId, MemoryRelationship>();
  private failure: string | null = null;

  readonly writes: string[] = [];

  failWith(reason: string | null): void {
    this.failure = reason;
  }

  seedEntity(entity: MemoryEntity): MemoryEntity {
    this.entities.set(entity.entityId, entity);
    return entity;
  }

  seedRelationship(relationship: MemoryRelationship): MemoryRelationship {
    this.edges.set(relationship.relationshipId, relationship);
    return relationship;
  }

  allEntities(): readonly MemoryEntity[] {
    return [...this.entities.values()];
  }

  allRelationships(): readonly MemoryRelationship[] {
    return [...this.edges.values()];
  }

  // --- MemoryEntity ---------------------------------------------------------

  async findEntityCandidates(
    subject: MemorySubject,
    ownership: MemoryOwnership,
    entityKey: EntityKey,
  ): Promise<
    Result<{ readonly clustered: MemoryEntity | null; readonly standalone: MemoryEntity | null }>
  > {
    if (this.failure !== null) return err(repositoryUnavailable(this.failure));
    const withKey = this.allEntities().filter(
      (entity) => inSubject(entity.subject, subject) && entity.entityKey === entityKey,
    );
    return ok({
      clustered:
        ownership.clusterId === null
          ? null
          : (withKey.find((entity) => entity.ownership.clusterId === ownership.clusterId) ?? null),
      standalone:
        withKey.find(
          (entity) =>
            entity.ownership.clusterId === null && entity.ownership.agentId === ownership.agentId,
        ) ?? null,
    });
  }

  async insertEntity(entity: MemoryEntity, transaction: TransactionScope): Promise<Result<MemoryEntity>> {
    if (this.failure !== null) return err(repositoryUnavailable(this.failure));
    this.writes.push(transaction.transactionId);
    this.entities.set(entity.entityId, entity);
    return ok(entity);
  }

  async updateEntity(entity: MemoryEntity, transaction: TransactionScope): Promise<Result<MemoryEntity>> {
    if (this.failure !== null) return err(repositoryUnavailable(this.failure));
    this.writes.push(transaction.transactionId);
    if (!this.entities.has(entity.entityId)) return err(repositoryUnavailable("no such entity to update"));
    this.entities.set(entity.entityId, entity);
    return ok(entity);
  }

  async findEntity(
    subject: MemorySubject,
    agentIds: readonly AgentId[],
    entityId: MemoryEntityId,
  ): Promise<Result<MemoryEntity | null>> {
    if (this.failure !== null) return err(repositoryUnavailable(this.failure));
    const entity = this.entities.get(entityId);
    if (entity === undefined) return ok(null);
    return ok(readable(entity, subject, agentIds) ? entity : null);
  }

  async listEntitiesByIds(
    subject: MemorySubject,
    agentIds: readonly AgentId[],
    entityIds: readonly MemoryEntityId[],
  ): Promise<Result<readonly MemoryEntity[]>> {
    if (this.failure !== null) return err(repositoryUnavailable(this.failure));
    const found: MemoryEntity[] = [];
    for (const entityId of entityIds) {
      const entity = this.entities.get(entityId);
      if (entity !== undefined && readable(entity, subject, agentIds)) found.push(entity);
    }
    return ok(found);
  }

  async listEntities(
    subject: MemorySubject,
    agentIds: readonly AgentId[],
    limit: number,
    offset: number,
  ): Promise<Result<EntityPage>> {
    if (this.failure !== null) return err(repositoryUnavailable(this.failure));
    const matching = this.allEntities()
      .filter((entity) => readable(entity, subject, agentIds))
      .sort((left, right) => (left.entityKey < right.entityKey ? -1 : 1));
    return ok({ items: matching.slice(offset, offset + limit), total: matching.length });
  }

  async searchEntities(query: EntitySearchQuery): Promise<Result<readonly EntityMatch[]>> {
    if (this.failure !== null) return err(repositoryUnavailable(this.failure));
    return ok(
      this.allEntities()
        .filter((entity) => readable(entity, query.subject, query.agentIds))
        .map((entity) => ({
          entity,
          // Entities are embedded from their LABEL, which is what the write path
          // does, so a search test can predict the score exactly.
          score: cosineSimilarity(query.embedding, deterministicEmbedding(entity.label)),
        }))
        .sort((left, right) =>
          right.score !== left.score
            ? right.score - left.score
            : left.entity.entityId < right.entity.entityId
              ? -1
              : 1,
        )
        .slice(0, query.limit),
    );
  }

  async deleteEntity(
    subject: MemorySubject,
    agentIds: readonly AgentId[],
    entityId: MemoryEntityId,
    transaction: TransactionScope,
  ): Promise<Result<boolean>> {
    if (this.failure !== null) return err(repositoryUnavailable(this.failure));
    this.writes.push(transaction.transactionId);
    const entity = this.entities.get(entityId);
    if (entity === undefined || !readable(entity, subject, agentIds)) return ok(false);
    this.entities.delete(entityId);
    // The schema cascades from both endpoints; the double does the same, so a
    // traversal after a delete cannot walk an edge to a node that is gone.
    for (const [id, edge] of [...this.edges.entries()]) {
      if (edge.fromEntityId === entityId || edge.toEntityId === entityId) this.edges.delete(id);
    }
    return ok(true);
  }

  // --- MemoryRelationship ---------------------------------------------------

  async findRelationship(
    subject: MemorySubject,
    identity: RelationshipIdentity,
  ): Promise<Result<MemoryRelationship | null>> {
    if (this.failure !== null) return err(repositoryUnavailable(this.failure));
    const found = this.allRelationships().find(
      (edge) => inSubject(edge.subject, subject) && sameRelationship(edge, identity),
    );
    return ok(found ?? null);
  }

  async insertRelationship(
    relationship: MemoryRelationship,
    transaction: TransactionScope,
  ): Promise<Result<MemoryRelationship>> {
    if (this.failure !== null) return err(repositoryUnavailable(this.failure));
    this.writes.push(transaction.transactionId);
    const clash = this.allRelationships().find((edge) => sameRelationship(edge, relationship));
    if (clash !== undefined) {
      return err(
        repositoryUnavailable(
          `unique (fromEntityId, toEntityId, relationshipType) already holds ${clash.relationshipId}`,
        ),
      );
    }
    this.edges.set(relationship.relationshipId, relationship);
    return ok(relationship);
  }

  async updateRelationship(
    relationship: MemoryRelationship,
    transaction: TransactionScope,
  ): Promise<Result<MemoryRelationship>> {
    if (this.failure !== null) return err(repositoryUnavailable(this.failure));
    this.writes.push(transaction.transactionId);
    if (!this.edges.has(relationship.relationshipId)) {
      return err(repositoryUnavailable("no such relationship to update"));
    }
    this.edges.set(relationship.relationshipId, relationship);
    return ok(relationship);
  }

  async listIncidentRelationships(
    subject: MemorySubject,
    agentIds: readonly AgentId[],
    entityIds: readonly MemoryEntityId[],
  ): Promise<Result<readonly MemoryRelationship[]>> {
    if (this.failure !== null) return err(repositoryUnavailable(this.failure));
    const wanted = new Set(entityIds);
    return ok(
      this.allRelationships().filter(
        (edge) =>
          inSubject(edge.subject, subject) &&
          agentIds.includes(edge.ownership.agentId) &&
          (wanted.has(edge.fromEntityId) || wanted.has(edge.toEntityId)),
      ),
    );
  }

  // --- erasure --------------------------------------------------------------

  async countEntitiesForSubject(selector: MemoryErasureSelector): Promise<Result<number>> {
    if (this.failure !== null) return err(repositoryUnavailable(this.failure));
    return ok(this.entitiesForSubject(selector).length);
  }

  async countRelationshipsForSubject(selector: MemoryErasureSelector): Promise<Result<number>> {
    if (this.failure !== null) return err(repositoryUnavailable(this.failure));
    return ok(this.relationshipsForSubject(selector).length);
  }

  async deleteRelationshipsForSubject(
    selector: MemoryErasureSelector,
    transaction: TransactionScope,
  ): Promise<Result<number>> {
    if (this.failure !== null) return err(repositoryUnavailable(this.failure));
    this.writes.push(transaction.transactionId);
    const doomed = this.relationshipsForSubject(selector);
    for (const edge of doomed) this.edges.delete(edge.relationshipId);
    return ok(doomed.length);
  }

  async deleteEntitiesForSubject(
    selector: MemoryErasureSelector,
    transaction: TransactionScope,
  ): Promise<Result<number>> {
    if (this.failure !== null) return err(repositoryUnavailable(this.failure));
    this.writes.push(transaction.transactionId);
    const doomed = this.entitiesForSubject(selector);
    for (const entity of doomed) this.entities.delete(entity.entityId);
    return ok(doomed.length);
  }

  private entitiesForSubject(selector: MemoryErasureSelector): readonly MemoryEntity[] {
    return this.allEntities().filter((entity) => matchesSelector(entity.subject, selector));
  }

  private relationshipsForSubject(selector: MemoryErasureSelector): readonly MemoryRelationship[] {
    return this.allRelationships().filter((edge) => matchesSelector(edge.subject, selector));
  }
}

function inSubject(left: MemorySubject, right: MemorySubject): boolean {
  return (
    left.environment.environmentId === right.environment.environmentId &&
    left.endUserId === right.endUserId
  );
}

function readable(
  entity: MemoryEntity,
  subject: MemorySubject,
  agentIds: readonly AgentId[],
): boolean {
  return inSubject(entity.subject, subject) && agentIds.includes(entity.ownership.agentId);
}

function matchesSelector(subject: MemorySubject, selector: MemoryErasureSelector): boolean {
  return (
    subject.environment.environmentId === selector.environment.environmentId &&
    subject.endUserId === selector.endUserId
  );
}
