// The `MemoryRepository` port — the canonical `Memory` store, as an interface.
//
// ADR M0.3 §1 row 8 makes this context the SOLE WRITER of `Memory`. This port is
// where that ownership is expressed: every mutation of the table in the V1 system
// passes through one of the methods below, and there is deliberately no generic
// `save(row)` or `query(where)` escape hatch through which another context could
// reach the table sideways.
//
// EVERY READ IS SCOPED BY SUBJECT AND BY AGENT, TOGETHER. There is no
// `findMemory(id)`. There is `findMemory(scope, agentIds, id)`, and an
// implementation MUST return `null` — not a row from another environment, another
// subject, or an agent outside the caller's cluster — when the id exists
// elsewhere. Making both a parameter rather than an ambient means a scope-less or
// an agent-less lookup does not compile.
//
// EVERY MUTATION TAKES A `TransactionScope`. The kernel's handle is opaque by
// construction (ADR M0.3 §3: no context passes a vendor transaction handle across
// a port), which is what lets a caller make a row write and an outbox append
// atomic without either side naming the other's technology.
//
// THE VECTOR NEVER APPEARS ON A `Memory`. `searchMemories` takes an embedding and
// returns rows with a similarity, and no method hands one back. The column is
// 1536 floats; putting it on the aggregate would put six kilobytes of noise into
// every listing, every log line and every test fixture, and nothing in this
// context reads an embedding for a decision.
//
// TWO METHODS READ ROWS THIS CONTEXT DOES NOT OWN, AND THAT IS DELIBERATE AND
// BOUNDED. `findSourceThreadOwnership` reads a `Thread` and `listRatingsForTurns`
// reads `MessageRating`. The sole-writer rule (ADR M0.3 §5.2) governs MUTATING
// delegates and exempts reads by name; the import ban (§2) governs code edges,
// and there is none — the adapter knows those tables, this package knows only
// these two signatures and the branded ids they take.
//
// Like every port in this programme, each method returns `Result`. A rejected
// promise is a defect, not an outcome.

import type { Result, TransactionScope } from "@platos/kernel";

import type {
  AgentBinding,
  AgentId,
  ContentHash,
  EndUserId,
  Memory,
  MemoryArchiveState,
  MemoryId,
  MemoryKind,
  MemoryOwnership,
  MemorySource,
  MemorySubject,
  MemoryVisibility,
  ProfileKey,
  ReconciledConfidence,
  ThreadId,
  TurnId,
} from "../../domain/index.js";
import type { EnvironmentScope } from "@platos/kernel";

/** Which rows a read may see. Every field narrows; none widens. */
export interface MemoryFilter {
  readonly subject: MemorySubject;
  /** The agents resolved by `domain/scope.ts`. Empty means "no agent is readable". */
  readonly agentIds: readonly AgentId[];
  readonly kind: MemoryKind | null;
  readonly source: MemorySource | null;
  readonly visibilities: readonly MemoryVisibility[];
  readonly archiveState: MemoryArchiveState;
  /** Retrieval-augmented rows are excluded from every path that feeds a turn. */
  readonly excludeRag: boolean;
  /** Recall excludes withdrawn rows; an operator listing does not. */
  readonly excludeQuarantined: boolean;
}

export interface MemoryPage {
  readonly items: readonly Memory[];
  readonly total: number;
}

/** One vector-search candidate: the row, and how close it was. */
export interface MemoryMatch {
  readonly memory: Memory;
  /** Cosine similarity in [0, 1] — `1 - distance`, computed by the store. */
  readonly score: number;
}

export interface MemorySearchQuery {
  readonly filter: MemoryFilter;
  /** The query vector. Produced by `EmbeddingModel`; never derived here. */
  readonly embedding: readonly number[];
  /**
   * How many candidates to return, which is the OVERFETCHED window and not the
   * caller's page (`domain/recall.ts`). Returning only the page would make
   * confidence reranking unable to promote anything.
   */
  readonly candidateLimit: number;
}

/** A keyset page, for exporting a whole subject without an offset scan. */
export interface MemoryExportPage {
  readonly items: readonly Memory[];
  readonly nextCursor: MemoryId | null;
}

/** Whose rows an erasure covers, in this context's columns. */
export interface MemoryErasureSelector {
  readonly environment: EnvironmentScope;
  /** Matches `Memory.endUserId`; null when the subject is not an end user. */
  readonly endUserId: EndUserId | null;
}

/** The current ratings on one turn, as the feedback reconciliation reads them. */
export interface TurnRating {
  readonly turnId: TurnId;
  /** +1, -1, or another value the tally counts as neither. */
  readonly rating: number;
}

/** A `MessageRating`'s identity and revision — enough to decide staleness. */
export interface RatingRevision {
  readonly environment: EnvironmentScope;
  readonly endUserId: EndUserId;
  readonly turnId: TurnId;
  readonly revision: number;
}

/**
 * What a write does to the row's `vector(1536)` column.
 *
 * Three cases, and all three are reachable, which is why this is a union rather
 * than a nullable vector:
 *
 *   set    a new vector was computed — the content is new or has changed.
 *   keep   the content did not change, so recomputing it would spend a model
 *          call to store the same numbers.
 *   clear  the row became a `profile`, which the source stores WITHOUT an
 *          embedding: a profile is read by key from the turn-start injector and
 *          is never a semantic-search candidate, so an embedding on one is a
 *          row that can be recalled by a query it was never meant to answer.
 *
 * A nullable vector would collapse `keep` and `clear` into one value, and the
 * two are opposites.
 */
export type EmbeddingDirective =
  | { readonly action: "set"; readonly vector: readonly number[] }
  | { readonly action: "keep" }
  | { readonly action: "clear" };

export const KEEP_EMBEDDING: EmbeddingDirective = Object.freeze({ action: "keep" });
export const CLEAR_EMBEDDING: EmbeddingDirective = Object.freeze({ action: "clear" });

/** One row write: the aggregate, and what happens to its vector. */
export interface MemoryWrite {
  readonly memory: Memory;
  readonly embedding: EmbeddingDirective;
}

export interface MemoryRepository {
  // --- agent placement: the input every scope decision is made from ----------

  /**
   * Every agent bound into this environment.
   *
   * Read, not written: `AgentBinding` is `agents`' row. The resolution rules
   * (`domain/scope.ts`) are pure functions over this list, which is what makes
   * "may this caller read that agent?" answerable without a store.
   */
  listAgentBindings(environment: EnvironmentScope): Promise<Result<readonly AgentBinding[]>>;

  /**
   * The agent that owns a source thread, and the subject it belongs to.
   *
   * Null when the thread is not in this environment. The subject travels back so
   * a caller can refuse a thread that belongs to somebody else — without it, a
   * memory could be attributed to a thread the subject never had.
   */
  findSourceThreadOwnership(
    environment: EnvironmentScope,
    threadId: ThreadId,
  ): Promise<Result<{ readonly ownership: MemoryOwnership; readonly endUserId: EndUserId } | null>>;

  /** Do these turn ids all belong to that thread? Provenance cannot be assumed. */
  countTurnsInThread(threadId: ThreadId, turnIds: readonly TurnId[]): Promise<Result<number>>;

  // --- Memory: the row this context writes ----------------------------------

  insertMemory(write: MemoryWrite, transaction: TransactionScope): Promise<Result<Memory>>;

  updateMemory(write: MemoryWrite, transaction: TransactionScope): Promise<Result<Memory>>;

  findMemory(
    subject: MemorySubject,
    agentIds: readonly AgentId[],
    memoryId: MemoryId,
  ): Promise<Result<Memory | null>>;

  /**
   * The row an extraction append would collide with, or null.
   *
   * This is the `@@unique([environmentId, endUserId, sourceThreadId, contentHash])`
   * probe. The merge itself is a domain decision (`mergeRepeatedExtraction`), so
   * the store reports the collision rather than resolving it.
   */
  findByContentIdentity(
    subject: MemorySubject,
    sourceThreadId: ThreadId | null,
    contentHash: ContentHash,
  ): Promise<Result<Memory | null>>;

  /** The profile row for one key under one ownership, or null. */
  findProfileRow(
    subject: MemorySubject,
    ownership: MemoryOwnership,
    profileKey: ProfileKey,
  ): Promise<Result<Memory | null>>;

  listMemories(filter: MemoryFilter, limit: number, offset: number): Promise<Result<readonly Memory[]>>;

  pageMemories(filter: MemoryFilter, limit: number, offset: number): Promise<Result<MemoryPage>>;

  /** Ordered by id, so an export resumes exactly where it stopped. */
  listExportPage(
    filter: MemoryFilter,
    afterId: MemoryId | null,
    limit: number,
  ): Promise<Result<MemoryExportPage>>;

  searchMemories(query: MemorySearchQuery): Promise<Result<readonly MemoryMatch[]>>;

  /**
   * Stamp `lastAccessedAt` on rows a recall returned.
   *
   * Separate from the search so a failure here cannot fail the recall: the page
   * is already correct, and losing an access stamp costs ordering, not truth.
   */
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

  // --- feedback: recomputed from ratings, never accumulated ------------------

  /** The rating's current revision, or null when it no longer exists. */
  findRatingRevision(ratingId: string): Promise<Result<RatingRevision | null>>;

  /** Every memory whose `sourceTurnIds` contains that turn, ordered by id. */
  listMemoriesForSourceTurn(
    environment: EnvironmentScope,
    endUserId: EndUserId,
    turnId: TurnId,
  ): Promise<Result<readonly Memory[]>>;

  /** The ratings that are CURRENT on those turns. Read, not written. */
  listRatingsForTurns(
    environment: EnvironmentScope,
    endUserId: EndUserId,
    turnIds: readonly TurnId[],
  ): Promise<Result<readonly TurnRating[]>>;

  applyReconciledConfidence(
    memoryId: MemoryId,
    reconciled: ReconciledConfidence,
    transaction: TransactionScope,
  ): Promise<Result<void>>;

  // --- erasure: this context's half of the kernel `ErasureTarget` ------------

  countMemoriesForSubject(selector: MemoryErasureSelector): Promise<Result<number>>;

  deleteMemoriesForSubject(
    selector: MemoryErasureSelector,
    transaction: TransactionScope,
  ): Promise<Result<number>>;
}
