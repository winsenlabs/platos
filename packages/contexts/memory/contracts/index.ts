// The published surface of the `memory` context.
//
// ADR M0.3 §2: another context may import THIS entrypoint and nothing else —
// never `domain/`, never `application/`, never an adapter. The one context the
// §1 DAG permits to reach it is `conversations`, plus `apps/core-api` through
// the composition root.
//
// THE DRIVEN PORTS ARE NOT RE-EXPORTED HERE. `MemoryRepository`,
// `KnowledgeGraphRepository`, `Cache`, `EmbeddingModel`, `ExtractionJudge` and
// `ContentDigest` are adapter-facing, not context-facing, and they are published
// from `application/ports/index.js` where their adapters import them (ADR M0.3
// §13). A context that could see `Cache` from here would be able to reach this
// context's keyspace without going through a use case.
//
// WHAT THIS SURFACE DELIBERATELY WITHHOLDS.
//
//   * NO EMBEDDING, ANYWHERE. The vector never reaches a `Memory` in the domain,
//     so there is nothing to strip — the omission is stated because a published
//     view is exactly where 1536 floats would eventually be added "for
//     debugging", and the column is meaningless outside this context.
//
//   * NO INTERNAL END-USER ID ON A VIEW. A caller names the subject with the id
//     it already holds; handing back the row's own `endUserId` would pass out a
//     handle into identity-access's store.
//
//   * NO `contentHash`. It is a dedupe key. Publishing it would let a caller
//     probe for the existence of a memory it cannot read by writing the same
//     sentence and watching for a collision.
//
//   * NO WAY TO WRITE A `Memory` WITH A PROVENANCE OTHER THAN `manual`. The
//     trusted-source privilege is an internal option on the use case, not a
//     field on any command below, so nothing outside this package can claim to
//     have extracted something.
//
// THE RUNTIME MINT *IS* PUBLISHED, and that is deliberate. `conversations` has
// to be able to construct the grant a turn recalls with, and there is no other
// context that can mint one for it (`domain/authorization.ts` records why).
// Publishing the mint keeps the two-layer unforgeability intact — a value still
// has to have come from a CALL, and no JSON body can be one.

import type { EnvironmentId, ErasureTarget, Result } from "@platos/kernel";

import type { MemoryMetadata } from "../domain/index.js";

// --- the identifier and vocabulary a caller needs to build a command --------

export type {
  ActorId,
  AgentId,
  ClusterId,
  ContentHash,
  EndUserId,
  EntityKey,
  MemoryEntityId,
  MemoryId,
  MemoryMetadata,
  MemoryRelationshipId,
  ProfileKey,
  ThreadId,
  TurnId,
} from "../domain/index.js";

export type {
  MemoryArchiveState,
  MemoryKind,
  MemorySource,
  MemoryVisibility,
} from "../domain/index.js";

export {
  ATOM_KINDS,
  MEMORY_ARCHIVE_STATES,
  MEMORY_ERROR_CODES,
  MEMORY_KINDS,
  MEMORY_SOURCES,
  MEMORY_VISIBILITIES,
  RAG_SOURCE,
  SYNTHESIZED_PROFILE_KEY,
  asMemoryIdentifier,
  normalizeProfileKey,
  stableSlug,
} from "../domain/index.js";

// The runtime grant, and its mint. See the note at the head of this file.
export type { EnvironmentAncestry, MemoryRuntimeAuthorization } from "../domain/index.js";
export { authorizeMemoryRuntime, isMemoryRuntimeAuthorization } from "../domain/index.js";

// Policy, published so the composition root can override a window without
// reaching into this package for the shape of one.
export type {
  MemoryCachePolicy,
  MemoryGraphPolicy,
  MemoryPagePolicy,
  MemoryPolicy,
  MemoryProfilePolicy,
  MemoryRecallPolicy,
} from "../domain/index.js";
export { DEFAULT_MEMORY_POLICY } from "../domain/index.js";

// The extraction policy, published because a transport renders and edits it.
export type { ExtractionPolicy, TranscriptTurn } from "../domain/index.js";
export { DEFAULT_EXTRACTION_POLICY, EXTRACTOR_VERSION } from "../domain/index.js";

import type { MemoryDependencies } from "../application/index.js";
import * as useCases from "../application/index.js";

// --- read models -------------------------------------------------------------

/** A memory as seen from outside. No vector, no subject id, no content hash. */
export interface MemoryView {
  readonly memoryId: string;
  readonly environmentId: EnvironmentId;
  readonly agentId: string;
  readonly clusterId: string | null;
  readonly kind: string;
  readonly profileKey: string | null;
  readonly content: string;
  readonly metadata: MemoryMetadata;
  readonly visibility: string;
  /** Derived from `visibility`; never a second stored fact. */
  readonly agentVisible: boolean;
  readonly source: string;
  readonly sourceThreadId: string | null;
  readonly sourceTurnIds: readonly string[];
  readonly extractorVersion: string | null;
  readonly confidence: number | null;
  readonly lastAccessedAt: Date | null;
  /** Non-null while feedback has withdrawn the memory from recall. */
  readonly quarantinedAt: Date | null;
  readonly archivedAt: Date | null;
  readonly createdAt: Date;
  readonly updatedAt: Date;
}

/**
 * A recalled memory and BOTH of its scores.
 *
 * They are separate because they answer different questions: `score` is raw
 * similarity and is what a caller comparing against a tuned threshold means;
 * `rankingScore` is what the page was ordered by. Publishing only one would make
 * every stored threshold in an installation silently wrong.
 */
export interface RecalledMemoryView {
  readonly memory: MemoryView;
  readonly score: number;
  readonly rankingScore: number;
  /** Which retrieval signals surfaced it. Empty for unfused recall. */
  readonly signals: readonly string[];
}

export interface MemoryPageView {
  readonly items: readonly MemoryView[];
  readonly total: number;
}

export interface MemoryExportPageView {
  readonly items: readonly MemoryView[];
  readonly nextCursor: string | null;
}

export interface EntityView {
  readonly entityId: string;
  readonly entityKey: string;
  readonly entityType: string;
  readonly label: string;
  readonly aliases: readonly string[];
  readonly metadata: MemoryMetadata;
  readonly agentId: string;
  readonly clusterId: string | null;
  readonly createdAt: Date;
  readonly updatedAt: Date;
}

export interface RelationshipView {
  readonly relationshipId: string;
  readonly fromEntityId: string;
  readonly toEntityId: string;
  readonly relationshipType: string;
  readonly weight: number | null;
  readonly metadata: MemoryMetadata;
  readonly sourceMemoryId: string | null;
  readonly createdAt: Date;
}

export interface EntityPageView {
  readonly items: readonly EntityView[];
  readonly total: number;
}

export interface EntityMatchView {
  readonly entity: EntityView;
  readonly score: number;
}

export interface PathHopView {
  readonly entityId: string;
  /** Null on the first hop — the start node was not reached by an edge. */
  readonly relationship: RelationshipView | null;
  readonly direction: "out" | "in" | null;
}

export interface NeighbourhoodView {
  readonly entity: EntityView;
  readonly outbound: readonly RelationshipView[];
  readonly inbound: readonly RelationshipView[];
  readonly neighbours: readonly EntityView[];
}

export interface ConnectionView {
  readonly hops: readonly PathHopView[];
  readonly entities: readonly EntityView[];
}

export interface RetrievedContextView {
  readonly memories: readonly RecalledMemoryView[];
  readonly entities: readonly EntityView[];
  readonly relationships: readonly RelationshipView[];
  readonly signals: {
    readonly dense: number;
    readonly graphConnected: number;
    readonly fused: number;
  };
}

export interface RecallView {
  readonly memories: readonly RecalledMemoryView[];
  readonly candidatesConsidered: number;
  /** False when the access stamp could not be written. Never fails a recall. */
  readonly accessStamped: boolean;
}

export interface EntityUpsertView {
  readonly entity: EntityView;
  readonly outcome: "created" | "updated" | "promoted";
}

export interface LifecycleChangeView {
  readonly changed: boolean;
  readonly memory: MemoryView;
}

// --- commands and queries ----------------------------------------------------

export type {
  BulkForgetCommand,
  ConnectionQuery,
  DescribeMemoryQuery,
  DescribeNeighbourhoodQuery,
  ExportMemoriesQuery,
  ExtractFromConversationCommand,
  ExtractionReport,
  ExtractionSkip,
  ForgetCommand,
  ForgetEntityCommand,
  ListEntitiesQuery,
  MemoryDependencies,
  PageMemoriesQuery,
  ReadMemoriesQuery,
  RecallQuery,
  ReconcileRatingCommand,
  ReconcileTurnCommand,
  ReconciliationReport,
  RelateEntitiesCommand,
  RememberCommand,
  RememberEntityCommand,
  RetrieveContextQuery,
  ReviseCommand,
  SearchEntitiesQuery,
  SynthesisReport,
  SynthesizeProfileCommand,
} from "../application/index.js";

/**
 * Retained from the generated skeleton so no sibling placeholder breaks. The
 * "aggregate" this context hands out is one memory, which is the row every
 * other shape here is assembled from.
 */
export type MemoryAggregate = MemoryView;

/**
 * The `memory` capability, as every other context sees it.
 *
 * Every method returns the kernel's `Result`: a failure a caller must handle is
 * visible in the type, and no store or model exception crosses this boundary.
 */
export interface MemoryContract {
  readonly name: "memory";

  // ---- memories: the control surface (operator grant) ---------------------
  remember(command: useCases.RememberCommand): Promise<Result<MemoryView>>;
  revise(command: useCases.ReviseCommand): Promise<Result<MemoryView>>;
  describeMemory(query: useCases.DescribeMemoryQuery): Promise<Result<MemoryView>>;
  listMemories(query: useCases.PageMemoriesQuery): Promise<Result<readonly MemoryView[]>>;
  pageMemories(query: useCases.PageMemoriesQuery): Promise<Result<MemoryPageView>>;
  /** Keyset paging by id, for walking a whole subject. */
  exportMemories(query: useCases.ExportMemoriesQuery): Promise<Result<MemoryExportPageView>>;

  // ---- memories: lifecycle -------------------------------------------------
  archive(command: useCases.ForgetCommand): Promise<Result<LifecycleChangeView>>;
  restore(command: useCases.ForgetCommand): Promise<Result<LifecycleChangeView>>;
  forget(command: useCases.ForgetCommand): Promise<Result<boolean>>;
  forgetMany(command: useCases.BulkForgetCommand): Promise<Result<number>>;

  // ---- recall (runtime grant) ---------------------------------------------
  /**
   * The seam a turn reaches for. It does not compose a prompt: deciding what to
   * do with a recalled memory belongs to `conversations`, which the ADR extracts
   * last.
   */
  recall(query: useCases.RecallQuery): Promise<Result<RecallView>>;
  /** Recall across the acting agent's whole cluster, derived from its binding. */
  recallAcrossCluster(query: Omit<useCases.RecallQuery, "requestedAgentIds">): Promise<Result<RecallView>>;
  /** Dense recall fused with the knowledge graph. The `MemoryRetriever` seam. */
  retrieveContext(query: useCases.RetrieveContextQuery): Promise<Result<RetrievedContextView>>;

  // ---- knowledge graph -----------------------------------------------------
  rememberEntity(command: useCases.RememberEntityCommand): Promise<Result<EntityUpsertView>>;
  relateEntities(command: useCases.RelateEntitiesCommand): Promise<Result<RelationshipView>>;
  forgetEntity(command: useCases.ForgetEntityCommand): Promise<Result<boolean>>;
  listEntities(query: useCases.ListEntitiesQuery): Promise<Result<EntityPageView>>;
  searchEntities(query: useCases.SearchEntitiesQuery): Promise<Result<readonly EntityMatchView[]>>;
  describeNeighbourhood(query: useCases.DescribeNeighbourhoodQuery): Promise<Result<NeighbourhoodView>>;
  /** The shortest path between two nodes, or null when there is none. */
  findConnection(query: useCases.ConnectionQuery): Promise<Result<ConnectionView | null>>;

  // ---- extraction and consolidation (runtime grant) -----------------------
  /**
   * Initiated on a `TurnFinalized` event. The transcript arrives ON the command:
   * ADR M0.3 §1 row 8 forbids this context from importing `conversations`.
   */
  extractFromConversation(
    command: useCases.ExtractFromConversationCommand,
  ): Promise<Result<useCases.ExtractionReport>>;
  synthesizeProfile(
    command: useCases.SynthesizeProfileCommand,
  ): Promise<Result<useCases.SynthesisReport>>;

  // ---- feedback ------------------------------------------------------------
  reconcileFromRating(
    command: useCases.ReconcileRatingCommand,
  ): Promise<Result<useCases.ReconciliationReport>>;
  reconcileFromTurn(
    command: useCases.ReconcileTurnCommand,
  ): Promise<Result<useCases.ReconciliationReport>>;

  // ---- right to erasure ----------------------------------------------------
  /**
   * This context's `ErasureTarget` for the rows it is sole writer of. The
   * composition root collects one of these per context and injects the array
   * into `privacy` (ADR M0.3 §3).
   *
   * IT IS ON THE CONTRACT BECAUSE THERE IS NO OTHER DOOR. `package.json`
   * publishes exactly two entrypoints — this barrel and
   * `application/ports/index.js` — so a target that is not reachable from one of
   * them is not reachable from the composition root at all. `memory` is sole
   * writer of `Memory`, `MemoryEntity` and `MemoryRelationship`, so an
   * unpublished target means a right-to-erasure operation silently omits the
   * three models that hold what a subject actually said. `files` publishes it
   * the same way on v1, and so does `jobs`.
   */
  erasureTarget(): ErasureTarget;
}

/** The integration events this context publishes through the kernel outbox. */
export const MEMORY_EVENT_NAMES = [
  "memory.memory.remembered",
  "memory.memory.revised",
  "memory.memory.archived",
  "memory.memory.restored",
  "memory.memory.forgotten",
  "memory.memory.quarantined",
  "memory.entity.upserted",
  "memory.relationship.asserted",
  "memory.extraction.completed",
  "memory.profile.synthesized",
] as const;

export type MemoryEventName = (typeof MEMORY_EVENT_NAMES)[number];

/**
 * Bind the use cases into the driving port.
 *
 * The composition root builds the dependency bundle from adapters and calls this
 * once. Nothing here holds state: it is a lookup table from a contract method to
 * the one use case that implements it, which is what keeps the contract from
 * quietly growing behaviour of its own.
 */
export function memoryContract(dependencies: MemoryDependencies): MemoryContract {
  const map = <Value, View>(result: Result<Value>, view: (value: Value) => View): Result<View> =>
    result.ok ? { ok: true, value: view(result.value) } : result;

  const contract: MemoryContract = {
    name: "memory",

    remember: async (command) =>
      map(await useCases.remember(dependencies, command), useCases.toMemoryView),
    revise: async (command) => map(await useCases.revise(dependencies, command), useCases.toMemoryView),
    describeMemory: async (query) =>
      map(await useCases.describeMemory(dependencies, query), useCases.toMemoryView),
    listMemories: async (query) =>
      map(await useCases.listMemories(dependencies, query), (memories) =>
        memories.map(useCases.toMemoryView),
      ),
    pageMemories: async (query) =>
      map(await useCases.pageMemories(dependencies, query), (page) => ({
        items: page.items.map(useCases.toMemoryView),
        total: page.total,
      })),
    exportMemories: async (query) =>
      map(await useCases.exportMemories(dependencies, query), (page) => ({
        items: page.items.map(useCases.toMemoryView),
        nextCursor: page.nextCursor,
      })),

    archive: async (command) => map(await useCases.archive(dependencies, command), lifecycleView),
    restore: async (command) => map(await useCases.restore(dependencies, command), lifecycleView),
    forget: (command) => useCases.forget(dependencies, command),
    forgetMany: (command) => useCases.forgetMany(dependencies, command),

    recall: async (query) => map(await useCases.recall(dependencies, query), recallView),
    recallAcrossCluster: async (query) =>
      map(await useCases.recallAcrossCluster(dependencies, query), recallView),
    retrieveContext: async (query) =>
      map(await useCases.retrieveContext(dependencies, query), (context) => ({
        memories: context.memories.map(useCases.toFusedMemoryView),
        entities: context.entities.map(useCases.toEntityView),
        relationships: context.relationships.map(useCases.toRelationshipView),
        signals: context.signals,
      })),

    rememberEntity: async (command) =>
      map(await useCases.rememberEntity(dependencies, command), (report) => ({
        entity: useCases.toEntityView(report.entity),
        outcome: report.outcome,
      })),
    relateEntities: async (command) =>
      map(await useCases.relateEntities(dependencies, command), useCases.toRelationshipView),
    forgetEntity: (command) => useCases.forgetEntity(dependencies, command),
    listEntities: async (query) =>
      map(await useCases.listEntities(dependencies, query), (page) => ({
        items: page.items.map(useCases.toEntityView),
        total: page.total,
      })),
    searchEntities: async (query) =>
      map(await useCases.searchEntities(dependencies, query), (matches) =>
        matches.map((match) => ({ entity: useCases.toEntityView(match.entity), score: match.score })),
      ),
    describeNeighbourhood: async (query) =>
      map(await useCases.describeNeighbourhood(dependencies, query), (report) => ({
        entity: useCases.toEntityView(report.entity),
        outbound: report.neighbourhood.outbound.map((edge) =>
          useCases.toRelationshipView(edge.relationship),
        ),
        inbound: report.neighbourhood.inbound.map((edge) =>
          useCases.toRelationshipView(edge.relationship),
        ),
        neighbours: report.neighbours.map(useCases.toEntityView),
      })),
    findConnection: async (query) =>
      map(await useCases.findConnection(dependencies, query), (report) =>
        report === null
          ? null
          : {
              hops: report.hops.map(useCases.toPathHopView),
              entities: report.entities.map(useCases.toEntityView),
            },
      ),

    extractFromConversation: (command) => useCases.extractFromConversation(dependencies, command),
    synthesizeProfile: (command) => useCases.synthesizeProfile(dependencies, command),

    reconcileFromRating: (command) => useCases.reconcileFromRating(dependencies, command),
    reconcileFromTurn: (command) => useCases.reconcileFromTurn(dependencies, command),

    erasureTarget: () => useCases.createMemoryErasureTarget(dependencies),
  };
  return Object.freeze(contract);
}

function lifecycleView(change: {
  readonly changed: boolean;
  readonly memory: Parameters<typeof useCases.toMemoryView>[0];
}): LifecycleChangeView {
  return { changed: change.changed, memory: useCases.toMemoryView(change.memory) };
}

function recallView(report: {
  readonly memories: readonly Parameters<typeof useCases.toRecalledMemoryView>[0][];
  readonly candidatesConsidered: number;
  readonly accessStamped: boolean;
}): RecallView {
  return {
    memories: report.memories.map(useCases.toRecalledMemoryView),
    candidatesConsidered: report.candidatesConsidered,
    accessStamped: report.accessStamped,
  };
}
