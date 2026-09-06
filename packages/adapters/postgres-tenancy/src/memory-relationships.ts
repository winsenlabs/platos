// `MemoryRelationship` — the edge half of `KnowledgeGraphRepository`.
//
// THE UNIQUE IS INSTALLATION-WIDE AND THE READ IS NOT. `@@unique([fromEntityId,
// toEntityId, relationshipType])` names no environment and no subject, which is
// safe only because both endpoints are themselves scoped rows — but a `findFirst`
// keyed on that triple alone would still be a statement whose `WHERE` a reader
// cannot check for a tenant leak. Every read below carries the subject as well,
// exactly as `governance-ratings.ts` carries `environmentId` beside its own
// installation-wide unique.
//
// THERE IS NO TRAVERSAL HERE, AND THE PORT SAYS WHY. `listIncidentRelationships`
// answers "which edges touch these nodes?" and `domain/traversal.ts` expands the
// frontier. One `OR` over the two endpoint columns is the whole primitive; the
// index that serves it is `MemoryRelationship_toEntityId_idx` on one side and
// the composite subject index on the other.
//
// AN EDGE HAS NO `updatedAt`, so `relationshipWriteData` stamps none and the
// aggregate carries only `createdAt`. `MemoryRelationship_owner_immutable`
// covers `environmentId`, `endUserId`, `agentId`, `clusterId`, `fromEntityId`
// and `toEntityId` — six of the eleven columns — so the update payload is
// exactly the four it leaves alone, and `relationshipType` is one of them. That
// last one is worth stating: retyping an edge onto a triple another edge already
// holds is a legal statement that the unique refuses, which is a different
// refusal from the trigger's and has its own named case.

import type {
  AgentId,
  MemoryEntityId,
  MemoryRelationship,
  MemorySubject,
  RelationshipIdentity,
  Result,
  TransactionScope,
} from "@platos/context-memory/application/ports/index.js";
import { ok } from "@platos/context-memory/application/ports/index.js";

import { requireStorableRelationship, requireUuidList } from "./memory-guards.js";
import { refuseMemory } from "./memory-refusal.js";
import {
  RELATIONSHIP_COLUMNS,
  relationshipWriteData,
  subjectWhere,
  toMemoryRelationship,
} from "./memory-rows.js";
import type { MemoryRelationshipRow } from "./memory-rows.js";
import type { TenancyTransactions } from "./transaction.js";

/** Creation order, made total on `id`. It is the order the double answers in. */
const EDGE_ORDER = [{ createdAt: "asc" }, { id: "asc" }] as const;

export interface MemoryRelationshipStore {
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
  listIncidentRelationships(
    subject: MemorySubject,
    agentIds: readonly AgentId[],
    entityIds: readonly MemoryEntityId[],
  ): Promise<Result<readonly MemoryRelationship[]>>;
}

export function createMemoryRelationshipStore(
  transactions: TenancyTransactions,
): MemoryRelationshipStore {
  return {
    async findRelationship(
      subject: MemorySubject,
      identity: RelationshipIdentity,
    ): Promise<Result<MemoryRelationship | null>> {
      return refuseMemory(async () => {
        const row = await transactions.reader().memoryRelationship.findFirst({
          where: {
            ...subjectWhere(subject),
            fromEntityId: identity.fromEntityId,
            toEntityId: identity.toEntityId,
            relationshipType: identity.relationshipType,
          },
          select: RELATIONSHIP_COLUMNS,
        });
        return ok(row === null ? null : toMemoryRelationship(subject, row as MemoryRelationshipRow));
      }, "graph findRelationship");
    },

    async insertRelationship(
      relationship: MemoryRelationship,
      transaction: TransactionScope,
    ): Promise<Result<MemoryRelationship>> {
      return refuseMemory(async () => {
        const writer = transactions.writer(transaction);
        requireStorableRelationship(relationship);
        const row = await writer.memoryRelationship.create({
          data: {
            id: relationship.relationshipId,
            environmentId: relationship.subject.environment.environmentId,
            endUserId: relationship.subject.endUserId,
            agentId: relationship.ownership.agentId,
            clusterId: relationship.ownership.clusterId,
            fromEntityId: relationship.fromEntityId,
            toEntityId: relationship.toEntityId,
            createdAt: relationship.createdAt,
            ...relationshipWriteData(relationship),
          },
          select: RELATIONSHIP_COLUMNS,
        });
        return ok(toMemoryRelationship(relationship.subject, row as MemoryRelationshipRow));
      }, "graph insertRelationship");
    },

    async updateRelationship(
      relationship: MemoryRelationship,
      transaction: TransactionScope,
    ): Promise<Result<MemoryRelationship>> {
      return refuseMemory(async () => {
        const writer = transactions.writer(transaction);
        requireStorableRelationship(relationship);
        const row = await writer.memoryRelationship.update({
          where: {
            id: relationship.relationshipId,
            environmentId: relationship.subject.environment.environmentId,
            endUserId: relationship.subject.endUserId,
          },
          data: relationshipWriteData(relationship),
          select: RELATIONSHIP_COLUMNS,
        });
        return ok(toMemoryRelationship(relationship.subject, row as MemoryRelationshipRow));
      }, "graph updateRelationship");
    },

    async listIncidentRelationships(
      subject: MemorySubject,
      agentIds: readonly AgentId[],
      entityIds: readonly MemoryEntityId[],
    ): Promise<Result<readonly MemoryRelationship[]>> {
      return refuseMemory(async () => {
        requireUuidList("agentIds", agentIds);
        requireUuidList("entityIds", entityIds);
        if (agentIds.length === 0 || entityIds.length === 0) return ok([]);
        const endpoints = [...entityIds];
        const rows = await transactions.reader().memoryRelationship.findMany({
          where: {
            ...subjectWhere(subject),
            agentId: { in: [...agentIds] },
            OR: [{ fromEntityId: { in: endpoints } }, { toEntityId: { in: endpoints } }],
          },
          select: RELATIONSHIP_COLUMNS,
          orderBy: [...EDGE_ORDER],
        });
        return ok(rows.map((row) => toMemoryRelationship(subject, row as MemoryRelationshipRow)));
      }, "graph listIncidentRelationships");
    },
  };
}
