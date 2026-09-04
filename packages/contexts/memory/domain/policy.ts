// The tunable limits, in one place, as data.
//
// Every value here is transcribed from the behaviour the running memory,
// knowledge-graph, extraction and profile-cache services already have. They are
// a POLICY VALUE passed into a use case, not a module constant read from an
// ambient environment, because a limit read from a process variable inside a
// domain rule is untestable and is exactly the coupling ADR M0.3 §2 bans.
//
// The per-agent extraction policy is NOT here. It is stored on an agent version
// and resolved per sweep (`domain/extraction.ts`), which is a different lifetime:
// this document is the installation's, that one is the operator's.

import { DEFAULT_SYNTHESIS_THROTTLE_MS } from "./profile.js";
import { DEFAULT_MAX_HOPS } from "./traversal.js";
import {
  BULK_DELETE_MAX,
  DEFAULT_RECALL_LIMIT,
  EXPORT_PAGE_MAX,
  MAX_RECALL_LIMIT,
  OFFSET_MAX,
  PAGE_DEFAULT,
  PAGE_MAX,
} from "./recall.js";
import {
  EXTRACTION_WATERMARK_TTL_SECONDS,
  PROFILE_CACHE_TTL_SECONDS,
  WORKING_MEMORY_TTL_SECONDS,
} from "./working-set.js";

export interface MemoryPagePolicy {
  readonly defaultLimit: number;
  readonly maxLimit: number;
  readonly maxOffset: number;
  /** A wider ceiling for the export surface, which pages a whole subject. */
  readonly exportMaxLimit: number;
  /** How many ids one bulk delete may name. */
  readonly bulkDeleteMax: number;
}

export interface MemoryRecallPolicy {
  readonly defaultLimit: number;
  readonly maxLimit: number;
  /**
   * The similarity floor the automatic turn-start injection uses.
   *
   * Explicit recall defaults to zero — an operator asking for the ten closest
   * memories wants ten. Injection is different: it spends tokens on every turn
   * whether or not anything relevant exists, so it declines to inject rather
   * than inject something distant.
   */
  readonly injectionMinScore: number;
  /** How many entity seeds the graph arm of fused retrieval resolves. */
  readonly graphSeedLimit: number;
  /** How many nodes and edges a fused answer carries back as structure. */
  readonly graphEntityLimit: number;
  readonly graphRelationshipLimit: number;
}

export interface MemoryGraphPolicy {
  readonly defaultMaxHops: number;
}

export interface MemoryProfilePolicy {
  readonly synthesisThrottleMs: number;
  readonly cacheTtlSeconds: number;
}

export interface MemoryCachePolicy {
  readonly workingMemoryTtlSeconds: number;
  readonly extractionWatermarkTtlSeconds: number;
}

export interface MemoryPolicy {
  readonly page: MemoryPagePolicy;
  readonly recall: MemoryRecallPolicy;
  readonly graph: MemoryGraphPolicy;
  readonly profile: MemoryProfilePolicy;
  readonly cache: MemoryCachePolicy;
}

export const DEFAULT_MEMORY_POLICY: MemoryPolicy = Object.freeze({
  page: Object.freeze({
    defaultLimit: PAGE_DEFAULT,
    maxLimit: PAGE_MAX,
    maxOffset: OFFSET_MAX,
    exportMaxLimit: EXPORT_PAGE_MAX,
    bulkDeleteMax: BULK_DELETE_MAX,
  }),
  recall: Object.freeze({
    defaultLimit: DEFAULT_RECALL_LIMIT,
    maxLimit: MAX_RECALL_LIMIT,
    injectionMinScore: 0.35,
    graphSeedLimit: 6,
    graphEntityLimit: 12,
    graphRelationshipLimit: 20,
  }),
  graph: Object.freeze({ defaultMaxHops: DEFAULT_MAX_HOPS }),
  profile: Object.freeze({
    synthesisThrottleMs: DEFAULT_SYNTHESIS_THROTTLE_MS,
    cacheTtlSeconds: PROFILE_CACHE_TTL_SECONDS,
  }),
  cache: Object.freeze({
    workingMemoryTtlSeconds: WORKING_MEMORY_TTL_SECONDS,
    extractionWatermarkTtlSeconds: EXTRACTION_WATERMARK_TTL_SECONDS,
  }),
});
