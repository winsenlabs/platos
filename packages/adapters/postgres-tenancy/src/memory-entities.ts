// `MemoryEntity` — the node half of `KnowledgeGraphRepository`.
//
// TWO PARTIAL UNIQUE INDEXES, NOT ONE UNIQUE. The initial migration drops the
// four-column unique Prisma declares and installs two partial ones in its place:
//
//   MemoryEntity_standalone_agent_entityKey_key  (env, subject, agent,   key) WHERE clusterId IS NULL
//   MemoryEntity_shared_cluster_entityKey_key    (env, subject, cluster, key) WHERE clusterId IS NOT NULL
//
// Prisma cannot express either — the migration's own comment says so — so there
// is no `upsert` on this table anywhere in this package. `findEntityCandidates`
// is the probe both indexes are behind, and `planEntityUpsert` in the domain is
// what decides between them. The two indexes are also WHY the probe answers a
// PAIR: a subject can hold a cluster node and an agent node for one key at the
// same time, and that is the conflict the domain refuses rather than a length
// check on a list.
//
// A PROMOTION IS AN UPDATE THE DATABASE JUDGES, NOT ONE THIS STORE DECIDES.
// `enforce_memory_entity_owner_transition` replaces the generic owner-immutable
// rule on this table and permits exactly ONE ownership move: `clusterId` from
// NULL to a cluster the agent is ACTUALLY BOUND TO, and only while the node has
// no relationships. Everything else — re-parenting, demotion to standalone, a
// changed `agentId`, a changed `environmentId` — raises 23514. So `clusterId` is
// in the update payload (without it `promoteEntity` in the domain would be
// unreachable) and every one of those refusals is a named case rather than an
// assumption.
//
// *** `searchEntities` READS A COLUMN NO METHOD ON THIS PORT CAN WRITE. ***
// `MemoryEntity.embedding` is `vector(1536)` and `insertEntity(entity,
// transaction)` takes a `MemoryEntity`, which carries no vector, and there is no
// second parameter and no sibling method that does — unlike `MemoryWrite`, which
// pairs every `Memory` with an `EmbeddingDirective`. A node written through this
// port therefore has a NULL embedding forever, and the search below, which is
// the honest one against the column the schema defines, can never return it.
// `InMemoryKnowledgeGraphRepository` hides this by scoring `deterministicEmbedding(entity.label)`
// at query time — a vector it invents from the row it is scoring. This store
// does not invent one: the contract is reported as unhonourable and pinned by a
// named case.

import type {
  AgentId,
  EntityKey,
  EntityMatch,
  EntityPage,
  EntitySearchQuery,
  MemoryEntity,
  MemoryEntityId,
  MemoryOwnership,
  MemorySubject,
  Result,
  TransactionScope,
} from "@platos/context-memory/application/ports/index.js";
import { ok } from "@platos/context-memory/application/ports/index.js";

import {
  requireStorableEntity,
  requireUuid,
  requireUuidList,
  toVectorLiteral,
} from "./memory-guards.js";
import { refuseMemory } from "./memory-refusal.js";
import { ENTITY_COLUMNS, entityWriteData, subjectWhere, toMemoryEntity } from "./memory-rows.js";
import type { MemoryEntityRow } from "./memory-rows.js";
import { selectEntityCandidates } from "./memory-vectors.js";
import type { TenancyTransactions } from "./transaction.js";

/** Ascending by the SLUG, then by id, so a listing is totally ordered. */
const ENTITY_ORDER = [{ entityKey: "asc" }, { id: "asc" }] as const;

export interface MemoryEntityStore {
  findEntityCandidates(
    subject: MemorySubject,
    ownership: MemoryOwnership,
    entityKey: EntityKey,
  ): Promise<
    Result<{ readonly clustered: MemoryEntity | null; readonly standalone: MemoryEntity | null }>
  >;
  insertEntity(entity: MemoryEntity, transaction: TransactionScope): Promise<Result<MemoryEntity>>;
  updateEntity(entity: MemoryEntity, transaction: TransactionScope): Promise<Result<MemoryEntity>>;
  findEntity(
    subject: MemorySubject,
    agentIds: readonly AgentId[],
    entityId: MemoryEntityId,
  ): Promise<Result<MemoryEntity | null>>;
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
}

export function createMemoryEntityStore(transactions: TenancyTransactions): MemoryEntityStore {
  return {
    /**
     * The two rows an upsert must consider, in ONE statement.
     *
     * An `OR` over the two ownership shapes rather than two round trips, and the
     * clustered branch is omitted entirely when the caller is unclustered — a
     * `clusterId: null` branch there would duplicate the standalone one and make
     * the same row answer both slots.
     */
    async findEntityCandidates(
      subject: MemorySubject,
      ownership: MemoryOwnership,
      entityKey: EntityKey,
    ): Promise<
      Result<{ readonly clustered: MemoryEntity | null; readonly standalone: MemoryEntity | null }>
    > {
      return refuseMemory(async () => {
        requireUuid("agentId", ownership.agentId);
        const standaloneWhere = { clusterId: null, agentId: ownership.agentId };
        const branches =
          ownership.clusterId === null
            ? [standaloneWhere]
            : [{ clusterId: ownership.clusterId }, standaloneWhere];
        const rows = await transactions.reader().memoryEntity.findMany({
          where: { ...subjectWhere(subject), entityKey, OR: branches },
          select: ENTITY_COLUMNS,
          orderBy: [...ENTITY_ORDER],
        });
        const entities = rows.map((row) => toMemoryEntity(subject, row as MemoryEntityRow));
        return ok({
          clustered:
            ownership.clusterId === null
              ? null
              : (entities.find((entity) => entity.ownership.clusterId === ownership.clusterId) ?? null),
          standalone:
            entities.find(
              (entity) =>
                entity.ownership.clusterId === null &&
                entity.ownership.agentId === ownership.agentId,
            ) ?? null,
        });
      }, "graph findEntityCandidates");
    },

    async insertEntity(
      entity: MemoryEntity,
      transaction: TransactionScope,
    ): Promise<Result<MemoryEntity>> {
      return refuseMemory(async () => {
        const writer = transactions.writer(transaction);
        requireStorableEntity(entity);
        const row = await writer.memoryEntity.create({
          data: {
            id: entity.entityId,
            environmentId: entity.subject.environment.environmentId,
            endUserId: entity.subject.endUserId,
            agentId: entity.ownership.agentId,
            clusterId: entity.ownership.clusterId,
            entityKey: entity.entityKey,
            createdAt: entity.createdAt,
            ...entityWriteData(entity),
          },
          select: ENTITY_COLUMNS,
        });
        return ok(toMemoryEntity(entity.subject, row as MemoryEntityRow));
      }, "graph insertEntity");
    },

    /**
     * Rewrite a node.
     *
     * `entityKey` is NOT in the payload: the two partial unique indexes are over
     * it, no database rule guards it, and `applyEntityDraft` in the domain never moves
     * it — so offering a rename here would be offering a way to move a node onto
     * another node's identity. `clusterId` IS in the payload, because the one
     * legal ownership move on this table goes through it, and the database is
     * what decides whether this particular move is that one.
     */
    async updateEntity(
      entity: MemoryEntity,
      transaction: TransactionScope,
    ): Promise<Result<MemoryEntity>> {
      return refuseMemory(async () => {
        const writer = transactions.writer(transaction);
        requireStorableEntity(entity);
        const row = await writer.memoryEntity.update({
          where: {
            id: entity.entityId,
            environmentId: entity.subject.environment.environmentId,
            endUserId: entity.subject.endUserId,
          },
          data: { clusterId: entity.ownership.clusterId, ...entityWriteData(entity) },
          select: ENTITY_COLUMNS,
        });
        return ok(toMemoryEntity(entity.subject, row as MemoryEntityRow));
      }, "graph updateEntity");
    },

    async findEntity(
      subject: MemorySubject,
      agentIds: readonly AgentId[],
      entityId: MemoryEntityId,
    ): Promise<Result<MemoryEntity | null>> {
      return refuseMemory(async () => {
        requireUuid("entityId", entityId);
        requireUuidList("agentIds", agentIds);
        const row = await transactions.reader().memoryEntity.findFirst({
          where: { id: entityId, ...subjectWhere(subject), agentId: { in: [...agentIds] } },
          select: ENTITY_COLUMNS,
        });
        return ok(row === null ? null : toMemoryEntity(subject, row as MemoryEntityRow));
      }, "graph findEntity");
    },

    /**
     * Resolve several ids inside one scope, ONE statement, in the CALLER's order.
     *
     * The re-ordering is not cosmetic. `domain/traversal.ts` expands a frontier
     * by handing this method the ids it just collected and walking the answer;
     * a store that returned them in index order would make the walk's shape
     * depend on the physical order of the table. `InMemoryKnowledgeGraphRepository`
     * loops over the requested ids, so this is also the order the shared
     * conformance scenario compares against.
     */
    async listEntitiesByIds(
      subject: MemorySubject,
      agentIds: readonly AgentId[],
      entityIds: readonly MemoryEntityId[],
    ): Promise<Result<readonly MemoryEntity[]>> {
      return refuseMemory(async () => {
        requireUuidList("agentIds", agentIds);
        requireUuidList("entityIds", entityIds);
        if (entityIds.length === 0) return ok([]);
        const rows = await transactions.reader().memoryEntity.findMany({
          where: {
            id: { in: [...entityIds] },
            ...subjectWhere(subject),
            agentId: { in: [...agentIds] },
          },
          select: ENTITY_COLUMNS,
        });
        const byId = new Map(
          rows.map((row) => [row.id, toMemoryEntity(subject, row as MemoryEntityRow)] as const),
        );
        const ordered: MemoryEntity[] = [];
        for (const entityId of entityIds) {
          const entity = byId.get(entityId);
          if (entity !== undefined) ordered.push(entity);
        }
        return ok(ordered);
      }, "graph listEntitiesByIds");
    },

    async listEntities(
      subject: MemorySubject,
      agentIds: readonly AgentId[],
      limit: number,
      offset: number,
    ): Promise<Result<EntityPage>> {
      return refuseMemory(async () => {
        requireUuidList("agentIds", agentIds);
        if (agentIds.length === 0) return ok({ items: [], total: 0 });
        const where = { ...subjectWhere(subject), agentId: { in: [...agentIds] } };
        const reader = transactions.reader();
        const rows = await reader.memoryEntity.findMany({
          where,
          select: ENTITY_COLUMNS,
          orderBy: [...ENTITY_ORDER],
          skip: offset,
          take: limit,
        });
        const total = await reader.memoryEntity.count({ where });
        return ok({
          items: rows.map((row) => toMemoryEntity(subject, row as MemoryEntityRow)),
          total,
        });
      }, "graph listEntities");
    },

    async searchEntities(query: EntitySearchQuery): Promise<Result<readonly EntityMatch[]>> {
      return refuseMemory(async () => {
        requireUuidList("agentIds", query.agentIds);
        requireUuid("environmentId", query.subject.environment.environmentId);
        requireUuid("endUserId", query.subject.endUserId);
        if (query.agentIds.length === 0) return ok([]);
        const rows = await selectEntityCandidates(transactions.reader(), {
          environmentId: query.subject.environment.environmentId,
          endUserId: query.subject.endUserId,
          agentCsv: query.agentIds.join(","),
          vector: toVectorLiteral("EntitySearchQuery.embedding", query.embedding),
          limit: query.limit,
        });
        return ok(
          rows.map((row) => ({
            entity: toMemoryEntity(query.subject, row),
            score: row.score,
          })),
        );
      }, "graph searchEntities");
    },

    /**
     * Remove a node, and with it every edge that touched it.
     *
     * The cascade is the SCHEMA's — `MemoryRelationship` holds `onDelete:
     * Cascade` to both endpoints — so nothing here deletes edges, and the
     * boolean says whether the NODE went. `deleteRelationshipsForSubject` in
     * `memory-erasure.ts` is the opposite case and says why: a receipt that has
     * to report how many edges were destroyed cannot let the cascade do it.
     */
    async deleteEntity(
      subject: MemorySubject,
      agentIds: readonly AgentId[],
      entityId: MemoryEntityId,
      transaction: TransactionScope,
    ): Promise<Result<boolean>> {
      return refuseMemory(async () => {
        const writer = transactions.writer(transaction);
        requireUuid("entityId", entityId);
        requireUuidList("agentIds", agentIds);
        const removed = await writer.memoryEntity.deleteMany({
          where: { id: entityId, ...subjectWhere(subject), agentId: { in: [...agentIds] } },
        });
        return ok(removed.count > 0);
      }, "graph deleteEntity");
    },
  };
}
