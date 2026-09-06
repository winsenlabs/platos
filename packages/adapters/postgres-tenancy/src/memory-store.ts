// The `Memory` row itself: the four writes and the three point reads.
//
// THE VECTOR IS A SECOND STATEMENT, AND IT HAS TO BE. `Memory.embedding` is
// `Unsupported("vector(1536)")`, which the generated client cannot put in a
// `data` block — so an insert that stores a vector is `create` followed by the
// raw `UPDATE` in `memory-vectors.ts`, inside the caller's transaction, and
// either both land or neither does. That is why `EmbeddingDirective` being a
// three-case union rather than a nullable vector matters here more than
// anywhere: `keep` sends NO second statement, so re-storing a row whose content
// did not change costs one statement rather than two, and `clear` on an INSERT
// sends none either, because a row PostgreSQL has just defaulted to NULL is
// already cleared.
//
// AN UPDATE NEVER SENDS AN OWNER COLUMN. `Memory_owner_immutable` is a BEFORE
// UPDATE trigger over `environmentId`, `endUserId`, `agentId`, `clusterId`,
// `sourceThreadId` and `extractorVersion`, and it raises 23514 on any change —
// which on PostgreSQL aborts the enclosing transaction. `memoryWriteData` omits
// the first five entirely, so no statement this file sends can move them.
//
// *** THE SIXTH IS `extractorVersion`, AND THE DOMAIN'S OWN MERGE RULE MOVES
// IT. *** `mergeRepeatedExtraction` in `domain/memory.ts` takes "the newer one,
// so a row records which extractor last confirmed it", and the trigger names
// that column as an ownership key. Re-extraction with the SAME extractor is
// unaffected — the trigger compares OLD to NEW — but a version BUMP is a legal
// domain operation the canonical schema refuses. It is sent anyway rather than
// silently dropped, so the refusal is the database's and is visible; the named
// case is in `memory-rules.integration.test.ts` and it is reported.
//
// `touchAccessed` IS RAW, AND FOR ONE REASON. `Memory.updatedAt` is `@updatedAt`,
// so any delegate update bumps it — and `domain/memory.ts` is explicit that
// reading a memory is not a revision of it ("letting recall touch `updatedAt`
// would make every listing reorder itself under load"). A raw `UPDATE` that
// names one column is the only statement that keeps that rule. It is also the
// one write on this port that takes NO `TransactionScope`, because a failed
// access stamp must not fail a recall that is already correct — so it resolves
// through `atomic()`, which JOINS the caller's transaction when there is one and
// opens its own when there is not.

import type {
  ContentHash,
  EnvironmentScope,
  Memory,
  MemoryId,
  MemoryOwnership,
  MemorySubject,
  MemoryWrite,
  ProfileKey,
  ReconciledConfidence,
  Result,
  ThreadId,
  TransactionScope,
  AgentId,
} from "@platos/context-memory/application/ports/index.js";
import { ok } from "@platos/context-memory/application/ports/index.js";

import {
  requireStorableBaseline,
  requireStorableConfidence,
  requireStorableMemory,
  requireUuid,
  requireUuidList,
  toVectorLiteral,
} from "./memory-guards.js";
import { refuseMemory } from "./memory-refusal.js";
import { MEMORY_COLUMNS, memoryWriteData, subjectWhere, toMemory } from "./memory-rows.js";
import type { MemoryRow } from "./memory-rows.js";
import { writeMemoryEmbedding } from "./memory-vectors.js";
import type { TenancyTransactions } from "./transaction.js";

export interface MemoryRowStore {
  insertMemory(write: MemoryWrite, transaction: TransactionScope): Promise<Result<Memory>>;
  updateMemory(write: MemoryWrite, transaction: TransactionScope): Promise<Result<Memory>>;
  findMemory(
    subject: MemorySubject,
    agentIds: readonly AgentId[],
    memoryId: MemoryId,
  ): Promise<Result<Memory | null>>;
  findByContentIdentity(
    subject: MemorySubject,
    sourceThreadId: ThreadId | null,
    contentHash: ContentHash,
  ): Promise<Result<Memory | null>>;
  findProfileRow(
    subject: MemorySubject,
    ownership: MemoryOwnership,
    profileKey: ProfileKey,
  ): Promise<Result<Memory | null>>;
  touchAccessed(
    environment: EnvironmentScope,
    memoryIds: readonly MemoryId[],
    accessedAt: Date,
  ): Promise<Result<number>>;
  deleteMemories(
    subject: MemorySubject,
    agentIds: readonly AgentId[],
    memoryIds: readonly MemoryId[],
    transaction: TransactionScope,
  ): Promise<Result<number>>;
  applyReconciledConfidence(
    memoryId: MemoryId,
    reconciled: ReconciledConfidence,
    transaction: TransactionScope,
  ): Promise<Result<void>>;
}

export function createMemoryRowStore(transactions: TenancyTransactions): MemoryRowStore {
  return {
    async insertMemory(write: MemoryWrite, transaction: TransactionScope): Promise<Result<Memory>> {
      return refuseMemory(async () => {
        const writer = transactions.writer(transaction);
        const memory = write.memory;
        requireStorableMemory(memory);
        const vector =
          write.embedding.action === "set"
            ? toVectorLiteral("Memory.embedding", write.embedding.vector)
            : null;
        const row = await writer.memory.create({
          data: {
            id: memory.memoryId,
            environmentId: memory.subject.environment.environmentId,
            endUserId: memory.subject.endUserId,
            agentId: memory.ownership.agentId,
            clusterId: memory.ownership.clusterId,
            sourceThreadId: memory.provenance.sourceThreadId,
            createdAt: memory.lifecycle.createdAt,
            ...memoryWriteData(memory),
          },
          select: MEMORY_COLUMNS,
        });
        if (vector !== null) {
          await writeMemoryEmbedding(
            writer,
            memory.subject.environment.environmentId,
            memory.memoryId,
            vector,
          );
        }
        return ok(toMemory(memory.subject, row as MemoryRow));
      }, "memory insertMemory");
    },

    async updateMemory(write: MemoryWrite, transaction: TransactionScope): Promise<Result<Memory>> {
      return refuseMemory(async () => {
        const writer = transactions.writer(transaction);
        const memory = write.memory;
        requireStorableMemory(memory);
        const vector =
          write.embedding.action === "set"
            ? toVectorLiteral("Memory.embedding", write.embedding.vector)
            : null;
        const row = await writer.memory.update({
          // Keyed on the pair rather than on the primary key alone: a memory id
          // is installation-wide, and an update that trusted the id would edit
          // another tenant's row whenever a caller's subject and its id
          // disagreed. `cost-budgets.ts` gives the same reason for the same shape.
          where: {
            id: memory.memoryId,
            environmentId: memory.subject.environment.environmentId,
            endUserId: memory.subject.endUserId,
          },
          data: memoryWriteData(memory),
          select: MEMORY_COLUMNS,
        });
        if (write.embedding.action !== "keep") {
          await writeMemoryEmbedding(
            writer,
            memory.subject.environment.environmentId,
            memory.memoryId,
            vector,
          );
        }
        return ok(toMemory(memory.subject, row as MemoryRow));
      }, "memory updateMemory");
    },

    async findMemory(
      subject: MemorySubject,
      agentIds: readonly AgentId[],
      memoryId: MemoryId,
    ): Promise<Result<Memory | null>> {
      return refuseMemory(async () => {
        requireUuid("memoryId", memoryId);
        requireUuidList("agentIds", agentIds);
        const row = await transactions.reader().memory.findFirst({
          where: { id: memoryId, ...subjectWhere(subject), agentId: { in: [...agentIds] } },
          select: MEMORY_COLUMNS,
        });
        return ok(row === null ? null : toMemory(subject, row as MemoryRow));
      }, "memory findMemory");
    },

    /**
     * The `@@unique([environmentId, endUserId, sourceThreadId, contentHash])`
     * probe, as a read.
     *
     * `sourceThreadId: null` reaches PostgreSQL as `IS NULL`, which is the
     * honest translation of the argument — and it is worth saying that the
     * INDEX does not enforce that case: PostgreSQL treats NULLs as distinct, so
     * two direct writes with the same hash and no thread do not collide there.
     * The probe still finds the first of them, so a caller that asks before
     * appending gets the merge the domain intends.
     */
    async findByContentIdentity(
      subject: MemorySubject,
      sourceThreadId: ThreadId | null,
      contentHash: ContentHash,
    ): Promise<Result<Memory | null>> {
      return refuseMemory(async () => {
        const row = await transactions.reader().memory.findFirst({
          where: { ...subjectWhere(subject), sourceThreadId, contentHash },
          select: MEMORY_COLUMNS,
          orderBy: [{ createdAt: "asc" }, { id: "asc" }],
        });
        return ok(row === null ? null : toMemory(subject, row as MemoryRow));
      }, "memory findByContentIdentity");
    },

    /**
     * The profile row for one key under one ownership.
     *
     * *** THERE IS NO UNIQUE INDEX BEHIND THIS READ, AND THE MIGRATION SAYS SO
     * ON PURPOSE. *** `20260824111500_memory_profile_key_and_source_contract`
     * ends with "Memory_profile_standalone_key and Memory_profile_cluster_key
     * are created by MemoryProfileBackfillService only after encrypted metadata
     * has been decrypted, normalized, deduplicated, remapped, and verified
     * atomically" — so on a database built from the migrations that ship, a
     * second profile row for one `(subject, ownership, key)` is STORABLE.
     * `InMemoryMemoryRepository.insertMemory` refuses it. The order below is
     * total, so this read is at least deterministic about which of two rows it
     * answers with, and the divergence is pinned and reported rather than
     * hidden behind a probe that pretends to be a constraint.
     */
    async findProfileRow(
      subject: MemorySubject,
      ownership: MemoryOwnership,
      profileKey: ProfileKey,
    ): Promise<Result<Memory | null>> {
      return refuseMemory(async () => {
        requireUuid("agentId", ownership.agentId);
        const owner =
          ownership.clusterId === null
            ? { clusterId: null, agentId: ownership.agentId }
            : { clusterId: ownership.clusterId };
        const row = await transactions.reader().memory.findFirst({
          where: { ...subjectWhere(subject), profileKey, ...owner },
          select: MEMORY_COLUMNS,
          orderBy: [{ createdAt: "asc" }, { id: "asc" }],
        });
        return ok(row === null ? null : toMemory(subject, row as MemoryRow));
      }, "memory findProfileRow");
    },

    async touchAccessed(
      environment: EnvironmentScope,
      memoryIds: readonly MemoryId[],
      accessedAt: Date,
    ): Promise<Result<number>> {
      return refuseMemory(async () => {
        requireUuid("environmentId", environment.environmentId);
        requireUuidList("memoryIds", memoryIds);
        if (memoryIds.length === 0) return ok(0);
        const csv = memoryIds.join(",");
        const touched = await transactions.atomic(
          async (writer) => writer.$executeRaw`
            UPDATE "Memory"
               SET "lastAccessedAt" = ${accessedAt}
             WHERE "environmentId" = ${environment.environmentId}::uuid
               AND "id" = ANY(string_to_array(${csv}, ',')::uuid[])`,
        );
        return ok(touched);
      }, "memory touchAccessed");
    },

    async deleteMemories(
      subject: MemorySubject,
      agentIds: readonly AgentId[],
      memoryIds: readonly MemoryId[],
      transaction: TransactionScope,
    ): Promise<Result<number>> {
      return refuseMemory(async () => {
        const writer = transactions.writer(transaction);
        requireUuidList("agentIds", agentIds);
        requireUuidList("memoryIds", memoryIds);
        const removed = await writer.memory.deleteMany({
          where: {
            ...subjectWhere(subject),
            agentId: { in: [...agentIds] },
            id: { in: [...memoryIds] },
          },
        });
        return ok(removed.count);
      }, "memory deleteMemories");
    },

    /**
     * Write back what feedback recomputed.
     *
     * Keyed on the primary key ALONE, and that is the port's shape rather than
     * this store's choice: `applyReconciledConfidence` is handed a `MemoryId`
     * and no scope, because `reconcile-feedback.ts` has already resolved the row
     * through `listMemoriesForSourceTurn`, which is scoped. It is the one
     * statement in this package whose `WHERE` names no environment, and it is
     * recorded here so the next reader does not take it for a pattern.
     */
    async applyReconciledConfidence(
      memoryId: MemoryId,
      reconciled: ReconciledConfidence,
      transaction: TransactionScope,
    ): Promise<Result<void>> {
      return refuseMemory(async () => {
        const writer = transactions.writer(transaction);
        requireUuid("memoryId", memoryId);
        requireStorableConfidence(reconciled.confidence);
        requireStorableBaseline(reconciled.baseline);
        await writer.memory.update({
          where: { id: memoryId },
          data: {
            confidence: reconciled.confidence,
            feedbackBaselineConfidence: reconciled.baseline,
            quarantinedAt: reconciled.quarantinedAt,
          },
          select: { id: true },
        });
        return ok(undefined);
      }, "memory applyReconciledConfidence");
    },
  };
}
