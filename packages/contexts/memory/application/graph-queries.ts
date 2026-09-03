// Use cases: read the knowledge graph.
//
// Four reads: list nodes, resolve nodes from a situation, describe one node's
// immediate neighbourhood, and find how two nodes are connected.
//
// THE TRAVERSAL IS EXPANSION HERE AND DECISION IN THE DOMAIN. Each hop is one
// `listIncidentRelationships` call for the whole frontier — not one call per
// node — and the expansion, the visited set and the backtrace are
// `domain/traversal.ts`, which is pure. That split is what makes "these two are
// four hops apart through these edges" a value a test can assert rather than a
// query plan nobody can read, and it is what bounds the round trips at the
// domain's hard six.
//
// THE HOP BUDGET IS ENFORCED IN TWO PLACES AND THAT IS DELIBERATE. `admitHops`
// clamps what a caller asked for, and the loop below stops at that number. A
// clamp alone would be enough if the loop were correct; the loop's bound being
// the clamped value is what makes it correct.
//
// EVERY EDGE READ IS SCOPED BY THE SAME AGENT IDS THE NODES WERE. A traversal
// that widened its edge scope by one hop would walk out of the caller's cluster
// through a node it was never allowed to see.

import { err, ok, type Result } from "@platos/kernel";

import {
  admitHops,
  clampInteger,
  entityNotFound,
  neighbourhoodOf,
  shortestPath,
  type AgentId,
  type EndUserId,
  type MemoryEntity,
  type MemoryEntityId,
  type MemoryRelationship,
  type Neighbourhood,
  type PathHop,
} from "../domain/index.js";
import { authorizeRead, type ReadScope } from "./authorization.js";
import type { MemoryDependencies } from "./dependencies.js";
import { embedQuery } from "./embedding.js";
import type { EntityMatch, EntityPage } from "./ports/index.js";

export interface GraphQuery {
  readonly authorization: unknown;
  /** Required under an operator grant; a runtime grant names its own subject. */
  readonly endUserId: EndUserId | null;
  readonly actingAgentId: AgentId | null;
  readonly requestedAgentIds: readonly AgentId[];
}

export interface ListEntitiesQuery extends GraphQuery {
  readonly limit: number | null;
  readonly offset: number | null;
}

export interface SearchEntitiesQuery extends GraphQuery {
  readonly query: string;
  readonly limit: number | null;
}

export interface DescribeNeighbourhoodQuery extends GraphQuery {
  readonly entityId: MemoryEntityId;
}

export interface ConnectionQuery extends GraphQuery {
  readonly fromEntityId: MemoryEntityId;
  readonly toEntityId: MemoryEntityId;
  readonly maxHops: number | null;
}

export async function listEntities(
  dependencies: MemoryDependencies,
  query: ListEntitiesQuery,
): Promise<Result<EntityPage>> {
  const scope = await authorizeRead(dependencies, query);
  if (!scope.ok) return err(scope.error);
  const limit = clampInteger(
    query.limit ?? dependencies.policy.page.defaultLimit,
    1,
    dependencies.policy.page.maxLimit,
  );
  const offset = clampInteger(query.offset ?? 0, 0, dependencies.policy.page.maxOffset);
  return dependencies.graph.listEntities(scope.value.subject, scope.value.agentIds, limit, offset);
}

export async function searchEntities(
  dependencies: MemoryDependencies,
  query: SearchEntitiesQuery,
): Promise<Result<readonly EntityMatch[]>> {
  const scope = await authorizeRead(dependencies, query);
  if (!scope.ok) return err(scope.error);
  const embedding = await embedQuery(dependencies, query.query);
  if (!embedding.ok) return err(embedding.error);
  return dependencies.graph.searchEntities({
    subject: scope.value.subject,
    agentIds: scope.value.agentIds,
    embedding: embedding.value,
    limit: clampInteger(
      query.limit ?? dependencies.policy.recall.graphSeedLimit,
      1,
      dependencies.policy.recall.maxLimit,
    ),
  });
}

/** One node, and the edges that touch it, split by direction. */
export interface NeighbourhoodReport {
  readonly entity: MemoryEntity;
  readonly neighbourhood: Neighbourhood;
  readonly neighbours: readonly MemoryEntity[];
}

export async function describeNeighbourhood(
  dependencies: MemoryDependencies,
  query: DescribeNeighbourhoodQuery,
): Promise<Result<NeighbourhoodReport>> {
  const scope = await authorizeRead(dependencies, query);
  if (!scope.ok) return err(scope.error);

  const entity = await dependencies.graph.findEntity(
    scope.value.subject,
    scope.value.agentIds,
    query.entityId,
  );
  if (!entity.ok) return err(entity.error);
  if (entity.value === null) return err(entityNotFound(query.entityId));

  const edges = await dependencies.graph.listIncidentRelationships(
    scope.value.subject,
    scope.value.agentIds,
    [query.entityId],
  );
  if (!edges.ok) return err(edges.error);

  const neighbourhood = neighbourhoodOf(query.entityId, edges.value);
  const neighbourIds = [
    ...new Set([
      ...neighbourhood.outbound.map((edge) => edge.toId),
      ...neighbourhood.inbound.map((edge) => edge.fromId),
    ]),
  ];
  const neighbours = await dependencies.graph.listEntitiesByIds(
    scope.value.subject,
    scope.value.agentIds,
    neighbourIds,
  );
  if (!neighbours.ok) return err(neighbours.error);
  return ok({ entity: entity.value, neighbourhood, neighbours: neighbours.value });
}

/** The hops of a path, with each node resolved. Null when there is no path. */
export interface ConnectionReport {
  readonly hops: readonly PathHop[];
  readonly entities: readonly MemoryEntity[];
}

export async function findConnection(
  dependencies: MemoryDependencies,
  query: ConnectionQuery,
): Promise<Result<ConnectionReport | null>> {
  const scope = await authorizeRead(dependencies, query);
  if (!scope.ok) return err(scope.error);

  const endpoints = await dependencies.graph.listEntitiesByIds(
    scope.value.subject,
    scope.value.agentIds,
    [query.fromEntityId, query.toEntityId],
  );
  if (!endpoints.ok) return err(endpoints.error);
  if (!endpoints.value.some((entity) => entity.entityId === query.fromEntityId)) {
    return err(entityNotFound(query.fromEntityId));
  }
  if (!endpoints.value.some((entity) => entity.entityId === query.toEntityId)) {
    return err(entityNotFound(query.toEntityId));
  }

  const maxHops = admitHops(query.maxHops ?? dependencies.policy.graph.defaultMaxHops);
  const edges = await gatherEdges(dependencies, scope.value, query.fromEntityId, maxHops);
  if (!edges.ok) return err(edges.error);

  const path = shortestPath(edges.value, query.fromEntityId, query.toEntityId, maxHops);
  if (path === null) return ok(null);

  const resolved = await dependencies.graph.listEntitiesByIds(
    scope.value.subject,
    scope.value.agentIds,
    path.map((hop) => hop.entityId),
  );
  if (!resolved.ok) return err(resolved.error);
  return ok({ hops: path, entities: resolved.value });
}

/**
 * Expand the frontier one hop at a time, accumulating edges.
 *
 * One store call per hop, for the WHOLE frontier — a per-node call would be a
 * fan-out that grows with the graph. The loop stops early when a hop adds no new
 * node, so a small connected component costs its own diameter rather than the
 * full budget.
 */
async function gatherEdges(
  dependencies: MemoryDependencies,
  scope: ReadScope,
  startId: MemoryEntityId,
  maxHops: number,
): Promise<Result<readonly MemoryRelationship[]>> {
  const edges: MemoryRelationship[] = [];
  const seenEdges = new Set<string>();
  const visited = new Set<MemoryEntityId>([startId]);
  let frontier: MemoryEntityId[] = [startId];

  for (let depth = 0; depth < maxHops && frontier.length > 0; depth += 1) {
    const incident = await dependencies.graph.listIncidentRelationships(
      scope.subject,
      scope.agentIds,
      frontier,
    );
    if (!incident.ok) return err(incident.error);

    const next: MemoryEntityId[] = [];
    for (const edge of incident.value) {
      if (!seenEdges.has(edge.relationshipId)) {
        seenEdges.add(edge.relationshipId);
        edges.push(edge);
      }
      for (const endpoint of [edge.fromEntityId, edge.toEntityId]) {
        if (visited.has(endpoint)) continue;
        visited.add(endpoint);
        next.push(endpoint);
      }
    }
    frontier = next;
  }
  return ok(edges);
}
