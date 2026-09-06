// The five SET reads on `Memory`, and the one translation of `MemoryFilter`
// they all share.
//
// ONE FILTER TRANSLATION, USED FOUR TIMES. `MemoryFilter` has eight fields and
// every one of them NARROWS; `memoryFilterWhere` below is the only place any of
// them becomes SQL, so `listMemories`, `pageMemories`, `listExportPage` and
// `searchMemories` cannot disagree about what `excludeRag` means. The source
// this is extracted from spells the same predicates out at six call sites, which
// is how `excludeQuarantined` came to be applied on two paths and not on a
// third.
//
// `source` AND `excludeRag` ARE TWO CONDITIONS, NOT ONE FIELD. A caller may ask
// for `source: "manual"` AND `excludeRag: true`, and a `where` object with one
// `source` key would silently keep whichever assignment ran last. They are
// pushed into an `AND` list instead, so both survive — and the case where both
// are set is a named one, because it is exactly the shape a single-key object
// would have lost.
//
// THE ORDER IS ASCENDING BY `createdAt`, THEN BY `id`, AND THE SECOND HALF IS
// NOT DECORATION. `Memory.createdAt` is `timestamp(3)`, so two rows written in
// the same millisecond TIE — and a paged listing whose order is not TOTAL
// repeats rows on one page and drops them from the next. The direction is the
// one the port does not state and `InMemoryMemoryRepository` does: its listings
// answer in insertion order, so ascending is the total order that agrees with
// the double the shared conformance scenario compares against. `listExportPage`
// is ordered by `id` alone, because its cursor IS an id and a keyset resume has
// to sort by the column it resumes on.
//
// AN EMPTY `agentIds` ANSWERS WITHOUT A STATEMENT. The port says "Empty means
// no agent is readable", so the answer is knowable without the database, and
// sending `agentId IN ()` would spend a round trip to be told nothing. It is
// also what keeps the statement-count pins honest: every count in
// `memory-statements.integration.test.ts` is measured with a non-empty set.

import type {
  EndUserId,
  EnvironmentScope,
  Memory,
  MemoryExportPage,
  MemoryFilter,
  MemoryId,
  MemoryMatch,
  MemoryPage,
  MemorySearchQuery,
  Result,
  TurnId,
} from "@platos/context-memory/application/ports/index.js";
import { ok, RAG_SOURCE } from "@platos/context-memory/application/ports/index.js";

import { requireUuid, requireUuidList, toVectorLiteral } from "./memory-guards.js";
import { refuseMemory } from "./memory-refusal.js";
import { MEMORY_COLUMNS, subjectWhere, toMemory } from "./memory-rows.js";
import type { MemoryRow } from "./memory-rows.js";
import { selectMemoryCandidates } from "./memory-vectors.js";
import type { TenancyTransactions } from "./transaction.js";

/** Ascending, and TOTAL. See the header for why both halves are needed. */
const LISTING_ORDER = [{ createdAt: "asc" }, { id: "asc" }] as const;

/** Every narrowing in `MemoryFilter`, as one `where`. */
export function memoryFilterWhere(filter: MemoryFilter): Record<string, unknown> {
  const conditions: Record<string, unknown>[] = [];
  if (filter.kind !== null) conditions.push({ kind: filter.kind });
  if (filter.source !== null) conditions.push({ source: filter.source });
  if (filter.visibilities.length > 0) conditions.push({ visibility: { in: [...filter.visibilities] } });
  if (filter.archiveState === "active") conditions.push({ archivedAt: null });
  if (filter.archiveState === "archived") conditions.push({ archivedAt: { not: null } });
  if (filter.excludeRag) conditions.push({ source: { not: RAG_SOURCE } });
  if (filter.excludeQuarantined) conditions.push({ quarantinedAt: null });
  return {
    ...subjectWhere(filter.subject),
    agentId: { in: [...filter.agentIds] },
    AND: conditions,
  };
}

export interface MemoryListingStore {
  listMemories(filter: MemoryFilter, limit: number, offset: number): Promise<Result<readonly Memory[]>>;
  pageMemories(filter: MemoryFilter, limit: number, offset: number): Promise<Result<MemoryPage>>;
  listExportPage(
    filter: MemoryFilter,
    afterId: MemoryId | null,
    limit: number,
  ): Promise<Result<MemoryExportPage>>;
  searchMemories(query: MemorySearchQuery): Promise<Result<readonly MemoryMatch[]>>;
  listMemoriesForSourceTurn(
    environment: EnvironmentScope,
    endUserId: EndUserId,
    turnId: TurnId,
  ): Promise<Result<readonly Memory[]>>;
}

export function createMemoryListingStore(transactions: TenancyTransactions): MemoryListingStore {
  return {
    async listMemories(
      filter: MemoryFilter,
      limit: number,
      offset: number,
    ): Promise<Result<readonly Memory[]>> {
      return refuseMemory(async () => {
        requireUuidList("agentIds", filter.agentIds);
        if (filter.agentIds.length === 0) return ok([]);
        const rows = await transactions.reader().memory.findMany({
          where: memoryFilterWhere(filter),
          select: MEMORY_COLUMNS,
          orderBy: [...LISTING_ORDER],
          skip: offset,
          take: limit,
        });
        return ok(rows.map((row) => toMemory(filter.subject, row as MemoryRow)));
      }, "memory listMemories");
    },

    /**
     * The operator page, and its TOTAL.
     *
     * TWO statements, and it is the only method on this port that costs two
     * reads: a page and a count of everything the page was cut from cannot be
     * one statement without a window function the client cannot express. They
     * are issued SEQUENTIALLY on `reader()`, which is the caller's open
     * transaction when there is one and the pool when there is not — so a caller
     * that wants the page and the total on one snapshot opens a unit of work,
     * and a caller that does not gets two independent reads and may see a total
     * a concurrent write has already moved. That is stated rather than fixed,
     * because the fix a store could apply alone — opening its own transaction —
     * would be a SECOND transaction inside the caller's, which
     * `transaction.ts` exists to make impossible.
     */
    async pageMemories(
      filter: MemoryFilter,
      limit: number,
      offset: number,
    ): Promise<Result<MemoryPage>> {
      return refuseMemory(async () => {
        requireUuidList("agentIds", filter.agentIds);
        if (filter.agentIds.length === 0) return ok({ items: [], total: 0 });
        const where = memoryFilterWhere(filter);
        const reader = transactions.reader();
        const rows = await reader.memory.findMany({
          where,
          select: MEMORY_COLUMNS,
          orderBy: [...LISTING_ORDER],
          skip: offset,
          take: limit,
        });
        const total = await reader.memory.count({ where });
        return ok({
          items: rows.map((row) => toMemory(filter.subject, row as MemoryRow)),
          total,
        });
      }, "memory pageMemories");
    },

    /**
     * A keyset page, so an export resumes where it stopped.
     *
     * `nextCursor` is the LAST id of this page and is null on an empty one,
     * which is what `InMemoryMemoryRepository` answers too. It is deliberately
     * NOT "null when the page was short": a caller cannot distinguish a page
     * that happened to end on the last row from one that did not, so the cursor
     * is reported and the next call returns nothing.
     */
    async listExportPage(
      filter: MemoryFilter,
      afterId: MemoryId | null,
      limit: number,
    ): Promise<Result<MemoryExportPage>> {
      return refuseMemory(async () => {
        requireUuidList("agentIds", filter.agentIds);
        if (afterId !== null) requireUuid("afterId", afterId);
        if (filter.agentIds.length === 0) return ok({ items: [], nextCursor: null });
        const where = memoryFilterWhere(filter);
        const rows = await transactions.reader().memory.findMany({
          where: afterId === null ? where : { ...where, id: { gt: afterId } },
          select: MEMORY_COLUMNS,
          orderBy: { id: "asc" },
          take: limit,
        });
        const items = rows.map((row) => toMemory(filter.subject, row as MemoryRow));
        return ok({ items, nextCursor: items[items.length - 1]?.memoryId ?? null });
      }, "memory listExportPage");
    },

    /**
     * The vector search, as ONE statement.
     *
     * The whole filter travels as parameters that can turn themselves off — see
     * `memory-vectors.ts` — so a search with six narrowings costs exactly what a
     * search with none costs, and the sole-writer gate can attribute the SQL
     * because it is static. `candidateLimit` is the OVERFETCHED window the port
     * documents, not the caller's page.
     */
    async searchMemories(query: MemorySearchQuery): Promise<Result<readonly MemoryMatch[]>> {
      return refuseMemory(async () => {
        const filter = query.filter;
        requireUuidList("agentIds", filter.agentIds);
        requireUuid("environmentId", filter.subject.environment.environmentId);
        requireUuid("endUserId", filter.subject.endUserId);
        if (filter.agentIds.length === 0) return ok([]);
        const rows = await selectMemoryCandidates(transactions.reader(), {
          environmentId: filter.subject.environment.environmentId,
          endUserId: filter.subject.endUserId,
          agentCsv: filter.agentIds.join(","),
          kind: filter.kind,
          source: filter.source,
          visibilityCsv: filter.visibilities.join(","),
          activeOnly: filter.archiveState === "active",
          archivedOnly: filter.archiveState === "archived",
          excludeRag: filter.excludeRag,
          excludeQuarantined: filter.excludeQuarantined,
          vector: toVectorLiteral("MemorySearchQuery.embedding", query.embedding),
          candidateLimit: query.candidateLimit,
        });
        return ok(rows.map((row) => ({ memory: toMemory(filter.subject, row), score: row.score })));
      }, "memory searchMemories");
    },

    async listMemoriesForSourceTurn(
      environment: EnvironmentScope,
      endUserId: EndUserId,
      turnId: TurnId,
    ): Promise<Result<readonly Memory[]>> {
      return refuseMemory(async () => {
        requireUuid("environmentId", environment.environmentId);
        requireUuid("endUserId", endUserId);
        requireUuid("turnId", turnId);
        const subject = { environment, endUserId };
        const rows = await transactions.reader().memory.findMany({
          where: {
            environmentId: environment.environmentId,
            endUserId,
            sourceTurnIds: { has: turnId },
          },
          select: MEMORY_COLUMNS,
          orderBy: { id: "asc" },
        });
        return ok(rows.map((row) => toMemory(subject, row as MemoryRow)));
      }, "memory listMemoriesForSourceTurn");
    },
  };
}
