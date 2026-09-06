// This context's half of the kernel `ErasureTarget` — the six methods that
// count and destroy one subject's rows across all three tables.
//
// THEY ARE ONE MODULE BECAUSE THEY ARE ONE OPERATION, SPLIT ACROSS TWO PORTS.
// `memory-erasure-target.ts` in the context counts memories, entities and
// relationships to make a PLAN, and then destroys them to make a RECEIPT — and
// the plan and the receipt have to agree. Three of the six are declared on
// `MemoryRepository` and three on `KnowledgeGraphRepository`, but a reader
// looking for "what does erasing this person do" should find all six in one
// place, and a change to the selector should be impossible to make in one of
// them and forget in the others.
//
// THE ORDER OF DESTRUCTION IS EDGES, THEN NODES, THEN MEMORIES, AND THE PORT
// SAYS WHY FOR THE FIRST PAIR. `MemoryRelationship` cascades from BOTH
// endpoints, so deleting the nodes would take the edges with them — and a
// cascade REPORTS NOTHING, so a receipt built that way would claim a number it
// never measured. Deleting the edges explicitly is what makes the count
// truthful. The caller's ordering is what actually sequences them; this module
// simply never relies on a cascade for a number it reports.
//
// THE SELECTOR IS TWO COLUMNS AND BOTH ARE REQUIRED. `MemoryErasureSelector`
// carries an environment and a NULLABLE `endUserId` ("null when the subject is
// not an end user"). A null subject here would make the `WHERE` an environment
// alone — every memory of every person in that environment — so a null selector
// answers zero and destroys nothing rather than matching broadly. That is the
// fail-CLOSED direction, and it is a named case in both directions: a
// subject-less selector counts zero, and a real one counts exactly its own.

import type {
  MemoryErasureSelector,
  Result,
  TransactionScope,
} from "@platos/context-memory/application/ports/index.js";
import { ok } from "@platos/context-memory/application/ports/index.js";

import { requireUuid } from "./memory-guards.js";
import { refuseMemory } from "./memory-refusal.js";
import type { TenancyTransactions } from "./transaction.js";

/**
 * The two-column `WHERE` every one of the six statements is narrowed by, or
 * `null` when the selector names no subject.
 */
function erasureWhere(
  selector: MemoryErasureSelector,
): { readonly environmentId: string; readonly endUserId: string } | null {
  if (selector.endUserId === null) return null;
  requireUuid("environmentId", selector.environment.environmentId);
  requireUuid("endUserId", selector.endUserId);
  return {
    environmentId: selector.environment.environmentId,
    endUserId: selector.endUserId,
  };
}

export interface MemoryErasureStore {
  countMemoriesForSubject(selector: MemoryErasureSelector): Promise<Result<number>>;
  deleteMemoriesForSubject(
    selector: MemoryErasureSelector,
    transaction: TransactionScope,
  ): Promise<Result<number>>;
  countEntitiesForSubject(selector: MemoryErasureSelector): Promise<Result<number>>;
  countRelationshipsForSubject(selector: MemoryErasureSelector): Promise<Result<number>>;
  deleteRelationshipsForSubject(
    selector: MemoryErasureSelector,
    transaction: TransactionScope,
  ): Promise<Result<number>>;
  deleteEntitiesForSubject(
    selector: MemoryErasureSelector,
    transaction: TransactionScope,
  ): Promise<Result<number>>;
}

export function createMemoryErasureStore(transactions: TenancyTransactions): MemoryErasureStore {
  return {
    async countMemoriesForSubject(selector: MemoryErasureSelector): Promise<Result<number>> {
      return refuseMemory(async () => {
        const where = erasureWhere(selector);
        if (where === null) return ok(0);
        return ok(await transactions.reader().memory.count({ where }));
      }, "memory countMemoriesForSubject");
    },

    async deleteMemoriesForSubject(
      selector: MemoryErasureSelector,
      transaction: TransactionScope,
    ): Promise<Result<number>> {
      return refuseMemory(async () => {
        const writer = transactions.writer(transaction);
        const where = erasureWhere(selector);
        if (where === null) return ok(0);
        const removed = await writer.memory.deleteMany({ where });
        return ok(removed.count);
      }, "memory deleteMemoriesForSubject");
    },

    async countEntitiesForSubject(selector: MemoryErasureSelector): Promise<Result<number>> {
      return refuseMemory(async () => {
        const where = erasureWhere(selector);
        if (where === null) return ok(0);
        return ok(await transactions.reader().memoryEntity.count({ where }));
      }, "graph countEntitiesForSubject");
    },

    async countRelationshipsForSubject(selector: MemoryErasureSelector): Promise<Result<number>> {
      return refuseMemory(async () => {
        const where = erasureWhere(selector);
        if (where === null) return ok(0);
        return ok(await transactions.reader().memoryRelationship.count({ where }));
      }, "graph countRelationshipsForSubject");
    },

    async deleteRelationshipsForSubject(
      selector: MemoryErasureSelector,
      transaction: TransactionScope,
    ): Promise<Result<number>> {
      return refuseMemory(async () => {
        const writer = transactions.writer(transaction);
        const where = erasureWhere(selector);
        if (where === null) return ok(0);
        const removed = await writer.memoryRelationship.deleteMany({ where });
        return ok(removed.count);
      }, "graph deleteRelationshipsForSubject");
    },

    async deleteEntitiesForSubject(
      selector: MemoryErasureSelector,
      transaction: TransactionScope,
    ): Promise<Result<number>> {
      return refuseMemory(async () => {
        const writer = transactions.writer(transaction);
        const where = erasureWhere(selector);
        if (where === null) return ok(0);
        const removed = await writer.memoryEntity.deleteMany({ where });
        return ok(removed.count);
      }, "graph deleteEntitiesForSubject");
    },
  };
}
