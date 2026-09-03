// Use case: fused retrieval — the seam where the graph participates in recall.
//
// Plain recall is one cosine query, and the knowledge graph is write-only unless
// something reads it back. This is that something. Two signals are fused with
// Reciprocal Rank Fusion (`domain/fusion.ts`):
//
//   dense  the ordinary vector search over memories.
//   graph  the situation resolved to entities, expanded one hop, and then the
//          dense hits that are TAGGED with any of those entities, most-connected
//          first. Extraction already stamps `metadata.entities`, so the trace
//          from a memory to the graph is a lookup rather than a search.
//
// THE GRAPH ARM RE-RANKS THE DENSE CANDIDATES; IT DOES NOT FETCH NEW ONES. That
// is a real constraint and it is deliberate: a memory that is connected to the
// situation but semantically distant is usually connected to everything (a hub
// node), and admitting it would let one popular entity dominate every recall.
// What fusion buys is that a memory which is BOTH close and connected collects
// two contributions and rises above one that is only close.
//
// EITHER ARM MAY FAIL WITHOUT FAILING THE WHOLE. A graph that cannot be searched
// leaves the dense answer standing, which is exactly the answer plain recall
// would have given; the report says which signals contributed, so a caller can
// see that the graph arm was empty rather than inferring it. A failing DENSE arm
// is different and is returned as an error: there is no answer without it.

import { err, ok, type Result } from "@platos/kernel";

import {
  oneHopClosure,
  rrfFuse,
  taggedEntityKeys,
  clampInteger,
  type AgentId,
  type Memory,
  type MemoryEntity,
  type MemoryEntityId,
  type MemoryRelationship,
} from "../domain/index.js";
import { resolveReadScope, runtimeEnvironment, verifyRuntime, type ReadScope } from "./authorization.js";
import type { MemoryDependencies } from "./dependencies.js";
import { embedQuery } from "./embedding.js";
import { recall, type RecalledMemory } from "./recall.js";

/** The prefix a fused key carries, so two id spaces cannot collide in one map. */
const MEMORY_KEY_PREFIX = "mem:";

export const DENSE_SIGNAL = "dense";
export const GRAPH_SIGNAL = "graph";

export interface RetrieveContextQuery {
  /** A `MemoryRuntimeAuthorization`. The subject travels inside it. */
  readonly authorization: unknown;
  readonly query: string;
  readonly requestedAgentIds: readonly AgentId[];
  readonly limit: number | null;
  readonly minScore: number | null;
}

export interface FusedMemory extends RecalledMemory {
  /** Which signals surfaced this memory. Ordered, because fusion sums in order. */
  readonly signals: readonly string[];
}

export interface RetrievedContext {
  readonly memories: readonly FusedMemory[];
  /** The nodes the situation resolved to, plus their one-hop neighbours. */
  readonly entities: readonly MemoryEntity[];
  readonly relationships: readonly MemoryRelationship[];
  readonly signals: {
    readonly dense: number;
    readonly graphConnected: number;
    readonly fused: number;
  };
}

export async function retrieveContext(
  dependencies: MemoryDependencies,
  query: RetrieveContextQuery,
): Promise<Result<RetrievedContext>> {
  const granted = verifyRuntime(dependencies, query.authorization);
  if (!granted.ok) return err(granted.error);

  const limit = clampInteger(
    query.limit ?? dependencies.policy.recall.defaultLimit,
    1,
    dependencies.policy.recall.maxLimit,
  );
  // The dense arm is asked for more than the page, because fusion reorders it and
  // a candidate that only the graph arm would have promoted has to be present to
  // be promoted. Twice the page, floored at twenty, is the source's window.
  const denseLimit = Math.max(limit * 2, 20);

  const dense = await recall(dependencies, {
    authorization: query.authorization,
    query: query.query,
    kind: null,
    requestedAgentIds: query.requestedAgentIds,
    limit: denseLimit,
    minScore: query.minScore,
    visibilityIn: undefined,
  });
  if (!dense.ok) return err(dense.error);

  const scope = await resolveReadScope(
    dependencies,
    {
      environment: runtimeEnvironment(granted.value),
      endUserId: granted.value.endUserId,
      actingAgentId: granted.value.actingAgentId,
    },
    query.requestedAgentIds,
  );
  if (!scope.ok) return err(scope.error);

  const slice = await resolveGraphSlice(dependencies, scope.value, query.query);
  const graphKeys = rankByConnection(dense.value.memories, slice.connectedKeys);

  const rankings = new Map<string, readonly string[]>();
  rankings.set(DENSE_SIGNAL, dense.value.memories.map((recalled) => key(recalled.memory)));
  if (graphKeys.length > 0) rankings.set(GRAPH_SIGNAL, graphKeys);
  const fused = rrfFuse(rankings);

  const byKey = new Map(dense.value.memories.map((recalled) => [key(recalled.memory), recalled] as const));
  const memories: FusedMemory[] = [];
  for (const entry of fused) {
    const recalled = byKey.get(entry.key);
    if (recalled === undefined) continue;
    memories.push({ ...recalled, signals: entry.signals });
    if (memories.length >= limit) break;
  }

  return ok({
    memories: Object.freeze(memories),
    entities: slice.entities,
    relationships: slice.relationships,
    signals: {
      dense: dense.value.memories.length,
      graphConnected: graphKeys.length,
      fused: fused.length,
    },
  });
}

/**
 * Order the dense hits by HOW MANY of the situation's entities they carry.
 *
 * Count, not presence: a memory tagged with three of the resolved entities is
 * more about the situation than one tagged with a single peripheral node. Ties
 * keep the dense order, which is stable, so the graph arm never reorders two
 * equally-connected memories against each other on nothing.
 */
export function rankByConnection(
  memories: readonly RecalledMemory[],
  connectedKeys: ReadonlySet<string>,
): readonly string[] {
  return memories
    .map((recalled, index) => ({
      key: key(recalled.memory),
      index,
      hits: taggedEntityKeys(recalled.memory.metadata).filter((slug) => connectedKeys.has(slug)).length,
    }))
    .filter((entry) => entry.hits > 0)
    .sort((left, right) => (right.hits !== left.hits ? right.hits - left.hits : left.index - right.index))
    .map((entry) => entry.key);
}

interface GraphSlice {
  readonly entities: readonly MemoryEntity[];
  readonly relationships: readonly MemoryRelationship[];
  readonly connectedKeys: ReadonlySet<string>;
}

const EMPTY_SLICE: GraphSlice = Object.freeze({
  entities: Object.freeze([]),
  relationships: Object.freeze([]),
  connectedKeys: new Set<string>(),
});

/**
 * Resolve the situation to entities and expand one hop.
 *
 * Every failure here yields the EMPTY slice rather than an error: this arm is an
 * enrichment, and a subject with no graph at all is the common case rather than
 * a fault. The caller can see it was empty from `signals.graphConnected`.
 */
async function resolveGraphSlice(
  dependencies: MemoryDependencies,
  scope: ReadScope,
  situation: string,
): Promise<GraphSlice> {
  const embedding = await embedQuery(dependencies, situation);
  if (!embedding.ok) return EMPTY_SLICE;

  const seeds = await dependencies.graph.searchEntities({
    subject: scope.subject,
    agentIds: scope.agentIds,
    embedding: embedding.value,
    limit: dependencies.policy.recall.graphSeedLimit,
  });
  if (!seeds.ok || seeds.value.length === 0) return EMPTY_SLICE;

  const seedIds = seeds.value.map((match) => match.entity.entityId);
  const edges = await dependencies.graph.listIncidentRelationships(scope.subject, scope.agentIds, seedIds);
  if (!edges.ok) return sliceOf(dependencies, seeds.value.map((match) => match.entity), []);

  const closure = oneHopClosure(seedIds, edges.value);
  const neighbours = await dependencies.graph.listEntitiesByIds(
    scope.subject,
    scope.agentIds,
    [...closure] as readonly MemoryEntityId[],
  );
  const entities = neighbours.ok ? neighbours.value : seeds.value.map((match) => match.entity);
  return sliceOf(dependencies, entities, edges.value);
}

function sliceOf(
  dependencies: MemoryDependencies,
  entities: readonly MemoryEntity[],
  relationships: readonly MemoryRelationship[],
): GraphSlice {
  const kept = entities.slice(0, dependencies.policy.recall.graphEntityLimit);
  return {
    entities: Object.freeze(kept),
    relationships: Object.freeze(relationships.slice(0, dependencies.policy.recall.graphRelationshipLimit)),
    // The closure is built from the KEPT entities, so the caps on what is
    // reported and what is fused against cannot drift apart.
    connectedKeys: new Set(kept.map((entity) => entity.entityKey)),
  };
}

function key(memory: Memory): string {
  return `${MEMORY_KEY_PREFIX}${memory.memoryId}`;
}
