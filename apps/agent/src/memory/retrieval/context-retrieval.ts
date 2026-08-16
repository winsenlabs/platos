/**
 * Multi-signal context retrieval — the "graph participates in recall" seam.
 *
 * Today `recall` (and the automatic memory injection) is a single cosine query
 * over the flat memory store; the knowledge graph is write-only. This fuses two
 * signals with Reciprocal Rank Fusion (rrf.ts, lifted from Bridge's
 * brain.context):
 *
 *   dense — MemoryService.semanticSearch (cosine over embedded memories).
 *   graph — resolve the situation to KG entities (searchEntities) → 1-hop
 *           expand (getRelationships) → the memories connected to those
 *           entities (via memory.metadata.entities, which extraction already
 *           stamps) rank higher. Also surfaces the entity+relationship slice
 *           itself as structured context.
 *
 * Pure + dependency-injected (takes the two services structurally) so it unit
 * tests without Nest / a database. No new storage; assembles primitives Platos
 * already has.
 */
import { rrfFuse } from "./rrf";
import type { ScopeTuple, MemorySearchHit, SemanticSearchInput } from "../memory.service";
import type { EntityRow } from "../knowledge-graph.service";

/** Structural slices of the real services — keeps this testable. */
export interface RetrievalDeps {
  memory: {
    semanticSearch(scope: ScopeTuple, input: SemanticSearchInput): Promise<MemorySearchHit[]>;
  };
  graph?: {
    searchEntities(
      scope: ScopeTuple,
      input: {
        userId: string;
        query: string;
        limit?: number;
        agentId?: string | null;
        agentIds?: string[];
      },
    ): Promise<Array<{ entity: EntityRow; score: number }>>;
    getRelationships(
      scope: ScopeTuple,
      input: { entityId: string; agentId?: string | null; agentIds?: string[] },
      userId?: string,
    ): Promise<{
      entity: EntityRow;
      outbound: Array<{ relationship: { relationshipType: string }; to: EntityRow }>;
      inbound: Array<{ relationship: { relationshipType: string }; from: EntityRow }>;
    } | null>;
  };
}

export interface RelationshipEdge {
  from: string;
  type: string;
  to: string;
}

export interface FusedContext {
  /** Fused (dense ⊕ graph) memories, ranked, capped at `limit`. */
  memories: MemorySearchHit[];
  /** Entities the situation resolved to + their 1-hop neighbours. */
  entities: Array<{ id: string; key: string; type: string; label: string }>;
  /** The 1-hop relationship slice around the resolved entities. */
  relationships: RelationshipEdge[];
  signals: { dense: number; graphConnected: number; fused: number };
}

export interface FuseInput {
  query: string;
  userId: string;
  agentId?: string | null;
  /** Cluster-member ids — wins over agentId (shared-memory search). */
  agentIds?: string[];
  kind?: string;
  limit?: number;
  /** Min cosine score for the dense arm (injection path passes 0.35). */
  minScore?: number;
  /** Visibility filter for the dense arm; when omitted, agent-visible only. */
  visibilityIn?: SemanticSearchInput["visibilityIn"];
}

/** The entity slugs a memory was tagged with by extraction. */
function entitySlugs(meta: unknown): string[] {
  if (!meta || typeof meta !== "object") return [];
  const e = (meta as { entities?: unknown }).entities;
  return Array.isArray(e) ? e.filter((x): x is string => typeof x === "string") : [];
}

export async function fuseContextRetrieval(
  deps: RetrievalDeps,
  scope: ScopeTuple,
  input: FuseInput,
): Promise<FusedContext> {
  const limit = Math.max(1, Math.min(50, input.limit ?? 10));
  const denseLimit = Math.max(limit * 2, 20);

  const scopeFilter =
    input.agentIds && input.agentIds.length > 0
      ? { agentIds: input.agentIds }
      : input.agentId
        ? { agentId: input.agentId }
        : {};

  const [dense, slice] = await Promise.all([
    deps.memory
      .semanticSearch(scope, {
        query: input.query,
        userId: input.userId,
        kind: input.kind,
        limit: denseLimit,
        excludeRag: true,
        ...(input.minScore !== undefined ? { minScore: input.minScore } : {}),
        ...(input.visibilityIn ? { visibilityIn: input.visibilityIn } : { agentVisibleOnly: true }),
        ...scopeFilter,
      })
      .catch(() => [] as MemorySearchHit[]),
    resolveGraphSlice(deps, scope, input).catch(() => ({
      entities: [] as FusedContext["entities"],
      relationships: [] as RelationshipEdge[],
      connectedSlugs: new Set<string>(),
    })),
  ]);

  // dense ranked list
  const denseKeys = dense.map((h) => `mem:${h.id}`);
  // graph ranked list: dense hits connected to a resolved entity, most-connected
  // first. This lets a memory that is BOTH semantically relevant AND connected
  // to an entity in the situation collect contributions from both signals and
  // float up — without a second (ciphertext) fetch.
  const graphKeys = dense
    .map((h) => ({ id: h.id, hits: entitySlugs(h.metadata).filter((s) => slice.connectedSlugs.has(s)).length }))
    .filter((x) => x.hits > 0)
    .sort((a, b) => b.hits - a.hits)
    .map((x) => `mem:${x.id}`);

  const rankings = new Map<string, readonly string[]>();
  rankings.set("dense", denseKeys);
  if (graphKeys.length > 0) rankings.set("graph", graphKeys);
  const fused = rrfFuse(rankings);

  const byId = new Map(dense.map((h) => [h.id, h] as const));
  const memories: MemorySearchHit[] = [];
  for (const f of fused) {
    const hit = byId.get(f.key.slice(4));
    if (!hit) continue;
    (hit as unknown as { signals?: string[] }).signals = f.signals;
    memories.push(hit);
    if (memories.length >= limit) break;
  }

  return {
    memories,
    entities: slice.entities,
    relationships: slice.relationships,
    signals: { dense: dense.length, graphConnected: graphKeys.length, fused: fused.length },
  };
}

async function resolveGraphSlice(
  deps: RetrievalDeps,
  scope: ScopeTuple,
  input: FuseInput,
): Promise<{ entities: FusedContext["entities"]; relationships: RelationshipEdge[]; connectedSlugs: Set<string> }> {
  const empty = { entities: [], relationships: [], connectedSlugs: new Set<string>() };
  if (!deps.graph) return empty;

  const hits = await deps.graph
    .searchEntities(scope, {
      userId: input.userId,
      query: input.query,
      limit: 6,
      ...(input.agentIds?.length
        ? { agentIds: input.agentIds }
        : input.agentId
          ? { agentId: input.agentId }
          : {}),
    })
    .catch(() => [] as Array<{ entity: EntityRow; score: number }>);
  const seeds = hits.map((x) => x.entity);
  if (seeds.length === 0) return empty;

  const entityById = new Map<string, EntityRow>();
  for (const e of seeds) entityById.set(e.id, e);
  const relationships: RelationshipEdge[] = [];

  const expansions = await Promise.all(
    seeds.slice(0, 6).map((e) => deps.graph!.getRelationships(scope, {
      entityId: e.id,
      ...(input.agentIds?.length
        ? { agentIds: input.agentIds }
        : input.agentId
          ? { agentId: input.agentId }
          : {}),
    }, input.userId).catch(() => null)),
  );
  for (const r of expansions) {
    if (!r) continue;
    for (const o of r.outbound ?? []) {
      if (!o?.to) continue;
      entityById.set(o.to.id, o.to);
      relationships.push({ from: r.entity.label, type: o.relationship.relationshipType, to: o.to.label });
    }
    for (const i of r.inbound ?? []) {
      if (!i?.from) continue;
      entityById.set(i.from.id, i.from);
      relationships.push({ from: i.from.label, type: i.relationship.relationshipType, to: r.entity.label });
    }
  }

  const connectedSlugs = new Set<string>();
  for (const e of entityById.values()) if (e.entityKey) connectedSlugs.add(e.entityKey);

  return {
    entities: [...entityById.values()]
      .slice(0, 12)
      .map((e) => ({ id: e.id, key: e.entityKey, type: e.entityType, label: e.label })),
    relationships: relationships.slice(0, 20),
    connectedSlugs,
  };
}
