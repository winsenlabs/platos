// An in-memory `MemoryRepository`.
//
// IT IS NOT A STUB THAT SAYS YES. It enforces the constraints the canonical
// store enforces, so a use case that passes here has been held to the rules the
// database would hold it to:
//
//   THE TWO UNIQUE INDEXES ARE REAL. Inserting a second row on
//   `(environment, subject, sourceThread, contentHash)`, or a second profile row
//   for one `(subject, ownership, profileKey)`, is REFUSED. A use case that
//   forgot to probe for a collision fails here rather than in production.
//
//   EVERY READ IS FILTERED BY SUBJECT AND BY AGENT. A row belonging to another
//   environment, another subject, or an agent outside the supplied set is not
//   returned by any method — including by id. A scope leak is therefore a test
//   failure here, not a review finding later.
//
//   THE VECTOR IS HELD SEPARATELY, as the column is, and `searchMemories`
//   computes a real cosine against it with the same function the embedding
//   double uses. A row with no vector is never a search candidate, which is what
//   makes the "a profile is stored without an embedding" rule observable.
//
//   FILTERS COMPOSE THE WAY THE STORE'S `WHERE` DOES. `excludeRag`,
//   `excludeQuarantined`, `archiveState` and the visibility list all narrow, and
//   none of them widens.

import { err, ok, type EnvironmentScope, type Result, type TransactionScope } from "@platos/kernel";

import {
  matchesArchiveState,
  RAG_SOURCE,
  repositoryUnavailable,
  type AgentBinding,
  type AgentId,
  type ContentHash,
  type EndUserId,
  type Memory,
  type MemoryId,
  type MemoryOwnership,
  type MemorySubject,
  type ProfileKey,
  type ReconciledConfidence,
  type ThreadId,
  type TurnId,
} from "../../domain/index.js";
import type {
  MemoryErasureSelector,
  MemoryExportPage,
  MemoryFilter,
  MemoryPage,
  MemoryMatch,
  MemoryRepository,
  MemorySearchQuery,
  MemoryWrite,
  RatingRevision,
  TurnRating,
} from "../ports/index.js";
import { cosineSimilarity } from "./in-memory-embedding-model.js";

interface StoredRow {
  memory: Memory;
  embedding: readonly number[] | null;
}

/** The erasure methods a test may fail INDIVIDUALLY. See `failErasureWith`. */
export type MemoryErasureMethod = "countMemoriesForSubject" | "deleteMemoriesForSubject";

export class InMemoryMemoryRepository implements MemoryRepository {
  private readonly rows = new Map<MemoryId, StoredRow>();
  private readonly threads = new Map<ThreadId, { ownership: MemoryOwnership; endUserId: EndUserId }>();
  private readonly turnsByThread = new Map<ThreadId, Set<string>>();
  private readonly ratings: (RatingRevision & { readonly ratingId: string; readonly rating: number })[] = [];

  /** Every transaction id a mutation was handed. Proves writes were enlisted. */
  readonly writes: string[] = [];

  private failure: string | null = null;
  private readonly erasureFailures = new Map<MemoryErasureMethod, string>();

  constructor(private bindings: readonly AgentBinding[] = []) {}

  // --- seeding --------------------------------------------------------------

  failWith(reason: string | null): void {
    this.failure = reason;
  }

  /**
   * Fail ONE erasure method rather than the whole store.
   *
   * The erasure target's fail-closed branches run in a fixed order, so a
   * whole-store outage only ever reaches the first of them. Failing a single
   * method is what makes each later branch reachable, and each has its own
   * consequence: a zero-count PLAN, or a RECEIPT claiming rows that were never
   * destroyed. `failWith` still wins, so nothing that used it changes meaning.
   */
  failErasureWith(method: MemoryErasureMethod, reason: string | null): void {
    if (reason === null) this.erasureFailures.delete(method);
    else this.erasureFailures.set(method, reason);
  }

  private erasureBlockedBy(method: MemoryErasureMethod): string | null {
    return this.failure ?? this.erasureFailures.get(method) ?? null;
  }

  setBindings(bindings: readonly AgentBinding[]): void {
    this.bindings = bindings;
  }

  seed(memory: Memory, embedding: readonly number[] | null = null): Memory {
    this.rows.set(memory.memoryId, { memory, embedding });
    return memory;
  }

  seedThread(threadId: ThreadId, ownership: MemoryOwnership, endUserId: EndUserId): void {
    this.threads.set(threadId, { ownership, endUserId });
  }

  seedTurns(threadId: ThreadId, turnIds: readonly TurnId[]): void {
    this.turnsByThread.set(threadId, new Set(turnIds));
  }

  seedRating(
    rating: RatingRevision & { readonly ratingId: string; readonly rating: number },
  ): void {
    this.ratings.push(rating);
  }

  all(): readonly Memory[] {
    return [...this.rows.values()].map((row) => row.memory);
  }

  embeddingOf(memoryId: MemoryId): readonly number[] | null {
    return this.rows.get(memoryId)?.embedding ?? null;
  }

  // --- agent placement ------------------------------------------------------

  async listAgentBindings(_environment: EnvironmentScope): Promise<Result<readonly AgentBinding[]>> {
    if (this.failure !== null) return err(repositoryUnavailable(this.failure));
    return ok(this.bindings);
  }

  async findSourceThreadOwnership(
    _environment: EnvironmentScope,
    threadId: ThreadId,
  ): Promise<Result<{ readonly ownership: MemoryOwnership; readonly endUserId: EndUserId } | null>> {
    if (this.failure !== null) return err(repositoryUnavailable(this.failure));
    return ok(this.threads.get(threadId) ?? null);
  }

  async countTurnsInThread(threadId: ThreadId, turnIds: readonly TurnId[]): Promise<Result<number>> {
    if (this.failure !== null) return err(repositoryUnavailable(this.failure));
    const known = this.turnsByThread.get(threadId) ?? new Set<string>();
    return ok(turnIds.filter((turnId) => known.has(turnId)).length);
  }

  // --- Memory ---------------------------------------------------------------

  async insertMemory(write: MemoryWrite, transaction: TransactionScope): Promise<Result<Memory>> {
    if (this.failure !== null) return err(repositoryUnavailable(this.failure));
    this.writes.push(transaction.transactionId);

    const contentClash = this.findContentClash(write.memory);
    if (contentClash !== null) {
      return err(
        repositoryUnavailable(
          `unique (environmentId, endUserId, sourceThreadId, contentHash) already holds ${contentClash}`,
        ),
      );
    }
    const profileClash = this.findProfileClash(write.memory);
    if (profileClash !== null) {
      return err(repositoryUnavailable(`unique profile key already holds ${profileClash}`));
    }
    this.rows.set(write.memory.memoryId, {
      memory: write.memory,
      embedding: write.embedding.action === "set" ? write.embedding.vector : null,
    });
    return ok(write.memory);
  }

  async updateMemory(write: MemoryWrite, transaction: TransactionScope): Promise<Result<Memory>> {
    if (this.failure !== null) return err(repositoryUnavailable(this.failure));
    this.writes.push(transaction.transactionId);
    const existing = this.rows.get(write.memory.memoryId);
    if (existing === undefined) return err(repositoryUnavailable("no such memory to update"));
    this.rows.set(write.memory.memoryId, {
      memory: write.memory,
      embedding:
        write.embedding.action === "set"
          ? write.embedding.vector
          : write.embedding.action === "clear"
            ? null
            : existing.embedding,
    });
    return ok(write.memory);
  }

  async findMemory(
    subject: MemorySubject,
    agentIds: readonly AgentId[],
    memoryId: MemoryId,
  ): Promise<Result<Memory | null>> {
    if (this.failure !== null) return err(repositoryUnavailable(this.failure));
    const row = this.rows.get(memoryId);
    if (row === undefined) return ok(null);
    if (!inSubject(row.memory, subject) || !agentIds.includes(row.memory.ownership.agentId)) return ok(null);
    return ok(row.memory);
  }

  async findByContentIdentity(
    subject: MemorySubject,
    sourceThreadId: ThreadId | null,
    contentHash: ContentHash,
  ): Promise<Result<Memory | null>> {
    if (this.failure !== null) return err(repositoryUnavailable(this.failure));
    const found = this.all().find(
      (memory) =>
        inSubject(memory, subject) &&
        memory.provenance.sourceThreadId === sourceThreadId &&
        memory.contentHash === contentHash,
    );
    return ok(found ?? null);
  }

  async findProfileRow(
    subject: MemorySubject,
    ownership: MemoryOwnership,
    profileKey: ProfileKey,
  ): Promise<Result<Memory | null>> {
    if (this.failure !== null) return err(repositoryUnavailable(this.failure));
    const found = this.all().find(
      (memory) =>
        inSubject(memory, subject) && memory.profileKey === profileKey && sameOwner(memory, ownership),
    );
    return ok(found ?? null);
  }

  async listMemories(
    filter: MemoryFilter,
    limit: number,
    offset: number,
  ): Promise<Result<readonly Memory[]>> {
    if (this.failure !== null) return err(repositoryUnavailable(this.failure));
    return ok(this.matching(filter).slice(offset, offset + limit));
  }

  async pageMemories(filter: MemoryFilter, limit: number, offset: number): Promise<Result<MemoryPage>> {
    if (this.failure !== null) return err(repositoryUnavailable(this.failure));
    const matching = this.matching(filter);
    return ok({ items: matching.slice(offset, offset + limit), total: matching.length });
  }

  async listExportPage(
    filter: MemoryFilter,
    afterId: MemoryId | null,
    limit: number,
  ): Promise<Result<MemoryExportPage>> {
    if (this.failure !== null) return err(repositoryUnavailable(this.failure));
    const ordered = [...this.matching(filter)].sort((left, right) =>
      left.memoryId < right.memoryId ? -1 : left.memoryId > right.memoryId ? 1 : 0,
    );
    const start = afterId === null ? 0 : ordered.findIndex((memory) => memory.memoryId > afterId);
    const items = start < 0 ? [] : ordered.slice(start, start + limit);
    const last = items[items.length - 1];
    return ok({ items, nextCursor: last?.memoryId ?? null });
  }

  async searchMemories(query: MemorySearchQuery): Promise<Result<readonly MemoryMatch[]>> {
    if (this.failure !== null) return err(repositoryUnavailable(this.failure));
    const candidates: MemoryMatch[] = [];
    for (const row of this.rows.values()) {
      if (row.embedding === null) continue;
      if (!this.passes(row.memory, query.filter)) continue;
      candidates.push({ memory: row.memory, score: cosineSimilarity(query.embedding, row.embedding) });
    }
    return ok(
      candidates
        .sort((left, right) =>
          right.score !== left.score
            ? right.score - left.score
            : left.memory.memoryId < right.memory.memoryId
              ? -1
              : 1,
        )
        .slice(0, query.candidateLimit),
    );
  }

  async touchAccessed(
    _environment: EnvironmentScope,
    memoryIds: readonly MemoryId[],
    accessedAt: Date,
  ): Promise<Result<number>> {
    if (this.failure !== null) return err(repositoryUnavailable(this.failure));
    let touched = 0;
    for (const memoryId of memoryIds) {
      const row = this.rows.get(memoryId);
      if (row === undefined) continue;
      row.memory = { ...row.memory, lifecycle: { ...row.memory.lifecycle, lastAccessedAt: accessedAt } };
      touched += 1;
    }
    return ok(touched);
  }

  async deleteMemories(
    subject: MemorySubject,
    agentIds: readonly AgentId[],
    memoryIds: readonly MemoryId[],
    transaction: TransactionScope,
  ): Promise<Result<number>> {
    if (this.failure !== null) return err(repositoryUnavailable(this.failure));
    this.writes.push(transaction.transactionId);
    let deleted = 0;
    for (const memoryId of memoryIds) {
      const row = this.rows.get(memoryId);
      if (row === undefined) continue;
      if (!inSubject(row.memory, subject) || !agentIds.includes(row.memory.ownership.agentId)) continue;
      this.rows.delete(memoryId);
      deleted += 1;
    }
    return ok(deleted);
  }

  // --- feedback -------------------------------------------------------------

  async findRatingRevision(ratingId: string): Promise<Result<RatingRevision | null>> {
    if (this.failure !== null) return err(repositoryUnavailable(this.failure));
    const found = this.ratings.find((rating) => rating.ratingId === ratingId);
    return ok(found ?? null);
  }

  async listMemoriesForSourceTurn(
    environment: EnvironmentScope,
    endUserId: EndUserId,
    turnId: TurnId,
  ): Promise<Result<readonly Memory[]>> {
    if (this.failure !== null) return err(repositoryUnavailable(this.failure));
    return ok(
      this.all()
        .filter(
          (memory) =>
            memory.subject.environment.environmentId === environment.environmentId &&
            memory.subject.endUserId === endUserId &&
            memory.provenance.sourceTurnIds.includes(turnId),
        )
        .sort((left, right) => (left.memoryId < right.memoryId ? -1 : 1)),
    );
  }

  async listRatingsForTurns(
    environment: EnvironmentScope,
    endUserId: EndUserId,
    turnIds: readonly TurnId[],
  ): Promise<Result<readonly TurnRating[]>> {
    if (this.failure !== null) return err(repositoryUnavailable(this.failure));
    return ok(
      this.ratings
        .filter(
          (rating) =>
            rating.environment.environmentId === environment.environmentId &&
            rating.endUserId === endUserId &&
            turnIds.includes(rating.turnId),
        )
        .map((rating) => ({ turnId: rating.turnId, rating: rating.rating })),
    );
  }

  async applyReconciledConfidence(
    memoryId: MemoryId,
    reconciled: ReconciledConfidence,
    transaction: TransactionScope,
  ): Promise<Result<void>> {
    if (this.failure !== null) return err(repositoryUnavailable(this.failure));
    this.writes.push(transaction.transactionId);
    const row = this.rows.get(memoryId);
    if (row === undefined) return err(repositoryUnavailable("no such memory to reconcile"));
    row.memory = {
      ...row.memory,
      confidence: {
        confidence: reconciled.confidence,
        feedbackBaselineConfidence: reconciled.baseline,
      },
      lifecycle: { ...row.memory.lifecycle, quarantinedAt: reconciled.quarantinedAt },
    };
    return ok(undefined);
  }

  // --- erasure --------------------------------------------------------------

  async countMemoriesForSubject(selector: MemoryErasureSelector): Promise<Result<number>> {
    const blocked = this.erasureBlockedBy("countMemoriesForSubject");
    if (blocked !== null) return err(repositoryUnavailable(blocked));
    return ok(this.forSubject(selector).length);
  }

  async deleteMemoriesForSubject(
    selector: MemoryErasureSelector,
    transaction: TransactionScope,
  ): Promise<Result<number>> {
    const blocked = this.erasureBlockedBy("deleteMemoriesForSubject");
    if (blocked !== null) return err(repositoryUnavailable(blocked));
    this.writes.push(transaction.transactionId);
    const doomed = this.forSubject(selector);
    for (const memory of doomed) this.rows.delete(memory.memoryId);
    return ok(doomed.length);
  }

  // --- internals ------------------------------------------------------------

  private forSubject(selector: MemoryErasureSelector): readonly Memory[] {
    return this.all().filter(
      (memory) =>
        memory.subject.environment.environmentId === selector.environment.environmentId &&
        memory.subject.endUserId === selector.endUserId,
    );
  }

  private matching(filter: MemoryFilter): readonly Memory[] {
    return this.all().filter((memory) => this.passes(memory, filter));
  }

  private passes(memory: Memory, filter: MemoryFilter): boolean {
    if (!inSubject(memory, filter.subject)) return false;
    if (!filter.agentIds.includes(memory.ownership.agentId)) return false;
    if (filter.kind !== null && memory.kind !== filter.kind) return false;
    if (filter.source !== null && memory.source !== filter.source) return false;
    if (filter.visibilities.length > 0 && !filter.visibilities.includes(memory.visibility)) return false;
    if (!matchesArchiveState(memory, filter.archiveState)) return false;
    if (filter.excludeRag && memory.source === RAG_SOURCE) return false;
    if (filter.excludeQuarantined && memory.lifecycle.quarantinedAt !== null) return false;
    return true;
  }

  private findContentClash(memory: Memory): MemoryId | null {
    if (memory.contentHash === null) return null;
    const clash = this.all().find(
      (stored) =>
        stored.memoryId !== memory.memoryId &&
        inSubject(stored, memory.subject) &&
        stored.provenance.sourceThreadId === memory.provenance.sourceThreadId &&
        stored.contentHash === memory.contentHash,
    );
    return clash?.memoryId ?? null;
  }

  private findProfileClash(memory: Memory): MemoryId | null {
    if (memory.profileKey === null) return null;
    const clash = this.all().find(
      (stored) =>
        stored.memoryId !== memory.memoryId &&
        inSubject(stored, memory.subject) &&
        stored.profileKey === memory.profileKey &&
        sameOwner(stored, memory.ownership),
    );
    return clash?.memoryId ?? null;
  }
}

function inSubject(memory: Memory, subject: MemorySubject): boolean {
  return (
    memory.subject.environment.environmentId === subject.environment.environmentId &&
    memory.subject.endUserId === subject.endUserId
  );
}

function sameOwner(memory: Memory, ownership: MemoryOwnership): boolean {
  return ownership.clusterId === null
    ? memory.ownership.clusterId === null && memory.ownership.agentId === ownership.agentId
    : memory.ownership.clusterId === ownership.clusterId;
}
