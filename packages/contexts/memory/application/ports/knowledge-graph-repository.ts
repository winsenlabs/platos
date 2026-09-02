// The `KnowledgeGraphRepository` port — `MemoryEntity` and `MemoryRelationship`.
//
// A second port rather than more methods on `MemoryRepository`, because the two
// stores answer different questions and are reached on different paths: one is
// on the write path of every remembered fact, the other is on the write path of
// extraction and on the read path of fused retrieval. Splitting them keeps each
// interface readable and lets an installation stand one of them up against a
// different technology without the other's methods coming along.
//
// ADR M0.3 §1 row 8 makes this context the SOLE WRITER of both tables, and the
// same three rules as its sibling apply: no generic `save`/`query`, every read
// scoped by subject AND by the resolved agent ids, every mutation carrying an
// opaque `TransactionScope`.
//
// TRAVERSAL IS NOT A STORE OPERATION. There is no `shortestPath` below. The
// store answers "which edges touch these nodes?" and `domain/traversal.ts`
// expands the frontier, which is what makes the search exercisable in memory and
// what stops a path from being a query plan nobody can read. The cost is one
// round trip per hop, bounded at six by the domain's hard ceiling.
//
// SEARCH TAKES AN EMBEDDING, LIKE ITS SIBLING. Entities carry a `vector(1536)`
// too; the vector never appears on a `MemoryEntity` for the same reason it never
// appears on a `Memory`.

import type { Result, TransactionScope } from "@platos/kernel";

import type {
  AgentId,
  EntityKey,
  MemoryEntity,
  MemoryEntityId,
  MemoryOwnership,
  MemoryRelationship,
  MemorySubject,
  RelationshipIdentity,
} from "../../domain/index.js";
import type { MemoryErasureSelector } from "./memory-repository.js";

/** One entity-search candidate: the node, and how close it was. */
export interface EntityMatch {
  readonly entity: MemoryEntity;
  readonly score: number;
}

export interface EntitySearchQuery {
  readonly subject: MemorySubject;
  readonly agentIds: readonly AgentId[];
  readonly embedding: readonly number[];
  readonly limit: number;
}

export interface EntityPage {
  readonly items: readonly MemoryEntity[];
  readonly total: number;
}

export interface KnowledgeGraphRepository {
  // --- MemoryEntity ---------------------------------------------------------

  /**
   * The two rows an upsert must consider: the cluster-owned node and the
   * agent-owned one. Both may exist, which is the conflict `planEntityUpsert`
   * refuses; returning them as a pair rather than a list is what makes that a
   * branch and not a length check.
   */
  findEntityCandidates(
    subject: MemorySubject,
    ownership: MemoryOwnership,
    entityKey: EntityKey,
  ): Promise<Result<{ readonly clustered: MemoryEntity | null; readonly standalone: MemoryEntity | null }>>;

  insertEntity(entity: MemoryEntity, transaction: TransactionScope): Promise<Result<MemoryEntity>>;

  updateEntity(entity: MemoryEntity, transaction: TransactionScope): Promise<Result<MemoryEntity>>;

  findEntity(
    subject: MemorySubject,
    agentIds: readonly AgentId[],
    entityId: MemoryEntityId,
  ): Promise<Result<MemoryEntity | null>>;

  /** Resolve several ids inside one scope. Absent ids are simply absent. */
  listEntitiesByIds(
    subject: MemorySubject,
    agentIds: readonly AgentId[],
    entityIds: readonly MemoryEntityId[],
  ): Promise<Result<readonly MemoryEntity[]>>;

  listEntities(
    subject: MemorySubject,
    agentIds: readonly AgentId[],
    limit: number,
    offset: number,
  ): Promise<Result<EntityPage>>;

  searchEntities(query: EntitySearchQuery): Promise<Result<readonly EntityMatch[]>>;

  deleteEntity(
    subject: MemorySubject,
    agentIds: readonly AgentId[],
    entityId: MemoryEntityId,
    transaction: TransactionScope,
  ): Promise<Result<boolean>>;

  // --- MemoryRelationship ---------------------------------------------------

  /** The edge holding `(from, to, type)`, or null. The unique, as a lookup. */
  findRelationship(
    subject: MemorySubject,
    identity: RelationshipIdentity,
  ): Promise<Result<MemoryRelationship | null>>;

  insertRelationship(
    relationship: MemoryRelationship,
    transaction: TransactionScope,
  ): Promise<Result<MemoryRelationship>>;

  updateRelationship(
    relationship: MemoryRelationship,
    transaction: TransactionScope,
  ): Promise<Result<MemoryRelationship>>;

  /**
   * Every edge with an endpoint in `entityIds`, in EITHER direction.
   *
   * This is the one primitive traversal needs: one call expands one frontier,
   * and the domain decides what to do with the result.
   */
  listIncidentRelationships(
    subject: MemorySubject,
    agentIds: readonly AgentId[],
    entityIds: readonly MemoryEntityId[],
  ): Promise<Result<readonly MemoryRelationship[]>>;

  // --- erasure --------------------------------------------------------------

  countEntitiesForSubject(selector: MemoryErasureSelector): Promise<Result<number>>;

  countRelationshipsForSubject(selector: MemoryErasureSelector): Promise<Result<number>>;

  /**
   * Edges first, then nodes.
   *
   * `MemoryRelationship` holds a cascading foreign key to both endpoints, so a
   * store would remove them anyway — but the count a receipt reports must be the
   * number of edges actually destroyed, and a cascade reports nothing. Deleting
   * them explicitly is what makes the receipt truthful.
   */
  deleteRelationshipsForSubject(
    selector: MemoryErasureSelector,
    transaction: TransactionScope,
  ): Promise<Result<number>>;

  deleteEntitiesForSubject(
    selector: MemoryErasureSelector,
    transaction: TransactionScope,
  ): Promise<Result<number>>;
}
