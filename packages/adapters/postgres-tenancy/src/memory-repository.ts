// `memory`'s canonical store — two ports, one object, one connection, in the one
// directory ADR M0.3 §15 gives the ORM.
//
// TWO NAMED PROPERTIES, NOT A SPREAD, AND IT IS FORCED. `tools`, `agents`,
// `cost-monitoring` and `channels` each publish a composite whose method names
// are disjoint from everything else in this directory, so their composites are
// spread into `PostgresTenancyAdapter` and satisfied structurally.
// `KnowledgeGraphRepository` cannot be: it declares `findEntity(subject,
// agentIds, entityId)` and `TenancyRepository` — which this adapter already
// extends — declares `findEntity(entityId)`. Two members with one name and two
// signatures make `interface X extends TenancyRepository,
// KnowledgeGraphRepository` a TypeScript error, exactly as
// `SecretsRepository.appendAudit` and `ToolsRepository.appendAudit` did in the
// same file. The names below are `MemoryDependencies`' own slot names —
// `repository` and `graph` — spelled with the owner in front, because
// `repository` alone is not a name a directory serving nine owners can give to
// one of them.
//
// ONE TRANSACTION ACROSS BOTH PORTS, AND ACROSS THE OTHER EIGHT OWNERS. They are
// handed the SAME `TenancyTransactions`, so `memory-erasure-target.ts` — which
// counts a subject's memories, entities and edges, then destroys the edges, the
// nodes and the rows — runs in ONE unit of work rather than three, and an
// erasure that fails half way leaves nothing applied. A thirteenth adapter
// package holding only these two would have had its own pool and its own ambient
// frame, and `extract-from-conversation.ts` — which writes a memory and the
// entities extracted from it in one breath — would have been two transactions
// with a window between them.
//
// THE TWO PORTS ARE ASSEMBLED FROM FIVE MODULES, SPLIT BY WHOSE ROWS THEY TOUCH
// AND BY WHAT THEY DO. `memory-placement.ts` holds the five methods that read
// rows this context does NOT own, so every statement in the other four is on a
// row `memory` is the sole writer of. `memory-store.ts` holds the point writes
// and point reads on `Memory`, `memory-listing.ts` the set reads,
// `memory-entities.ts` and `memory-relationships.ts` the two graph tables, and
// `memory-erasure.ts` the six methods that span both ports because they are one
// operation.
//
// WHAT IS NOT HERE, AND WHY. `memory` declares SIX driven ports in five modules
// and this satisfies the TWO that are canonical stores.
//
//   `cache.ts` is a Cache, and ADR M0.3 §13 assigns it to this context BY NAME
//   while putting Redis behind `packages/adapters/redis-cache`: "Redis is an
//   implementation detail and does not define architectural ownership". Every
//   write on it carries a TTL and no method of it touches a canonical row.
//   Satisfying it from the canonical store would make an expiring projection
//   durable, which is the opposite of what the port is for.
//
//   `embedding-model.ts` declares TWO model seams — `EmbeddingModel` and
//   `ExtractionJudge`. Both are priced, timed calls to a provider, composed over
//   `providers` at the composition root, and neither writes a row.
//
//   `content-digest.ts` is a HOST capability: a synchronous, infallible
//   `node:crypto` hash that `domain/` may not reach for. It is not asynchronous,
//   it does not return a `Result`, and it has no store to be part of.

import type {
  KnowledgeGraphRepository,
  MemoryRepository,
} from "@platos/context-memory/application/ports/index.js";

import { createMemoryEntityStore } from "./memory-entities.js";
import { createMemoryErasureStore } from "./memory-erasure.js";
import { createMemoryListingStore } from "./memory-listing.js";
import { createMemoryPlacementReads } from "./memory-placement.js";
import { createMemoryRelationshipStore } from "./memory-relationships.js";
import { createMemoryRowStore } from "./memory-store.js";
import type { TenancyTransactions } from "./transaction.js";

/** The two canonical stores, under the names `MemoryDependencies` uses. */
export interface MemoryStores {
  readonly memory: MemoryRepository;
  readonly memoryGraph: KnowledgeGraphRepository;
}

/**
 * Build both stores over already-open transaction machinery.
 *
 * It takes `TenancyTransactions` rather than a client for the reason every
 * composite in this package does: a caller that built its own would get a second
 * `AsyncLocalStorage` frame, and a write carrying a scope minted by one would be
 * refused by the other with `scope_unknown` — a refusal that names the right
 * fact and the wrong cause.
 */
export function createMemoryStores(transactions: TenancyTransactions): MemoryStores {
  const placement = createMemoryPlacementReads(transactions);
  const rows = createMemoryRowStore(transactions);
  const listing = createMemoryListingStore(transactions);
  const entities = createMemoryEntityStore(transactions);
  const relationships = createMemoryRelationshipStore(transactions);
  const erasure = createMemoryErasureStore(transactions);

  return {
    memory: {
      listAgentBindings: placement.listAgentBindings,
      findSourceThreadOwnership: placement.findSourceThreadOwnership,
      countTurnsInThread: placement.countTurnsInThread,
      findRatingRevision: placement.findRatingRevision,
      listRatingsForTurns: placement.listRatingsForTurns,
      insertMemory: rows.insertMemory,
      updateMemory: rows.updateMemory,
      findMemory: rows.findMemory,
      findByContentIdentity: rows.findByContentIdentity,
      findProfileRow: rows.findProfileRow,
      touchAccessed: rows.touchAccessed,
      deleteMemories: rows.deleteMemories,
      applyReconciledConfidence: rows.applyReconciledConfidence,
      listMemories: listing.listMemories,
      pageMemories: listing.pageMemories,
      listExportPage: listing.listExportPage,
      searchMemories: listing.searchMemories,
      listMemoriesForSourceTurn: listing.listMemoriesForSourceTurn,
      countMemoriesForSubject: erasure.countMemoriesForSubject,
      deleteMemoriesForSubject: erasure.deleteMemoriesForSubject,
    },
    memoryGraph: {
      findEntityCandidates: entities.findEntityCandidates,
      insertEntity: entities.insertEntity,
      updateEntity: entities.updateEntity,
      findEntity: entities.findEntity,
      listEntitiesByIds: entities.listEntitiesByIds,
      listEntities: entities.listEntities,
      searchEntities: entities.searchEntities,
      deleteEntity: entities.deleteEntity,
      findRelationship: relationships.findRelationship,
      insertRelationship: relationships.insertRelationship,
      updateRelationship: relationships.updateRelationship,
      listIncidentRelationships: relationships.listIncidentRelationships,
      countEntitiesForSubject: erasure.countEntitiesForSubject,
      countRelationshipsForSubject: erasure.countRelationshipsForSubject,
      deleteRelationshipsForSubject: erasure.deleteRelationshipsForSubject,
      deleteEntitiesForSubject: erasure.deleteEntitiesForSubject,
    },
  };
}
