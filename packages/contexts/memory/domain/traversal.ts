// Walking the graph: shortest path, and the one-hop neighbourhood recall uses.
//
// Both are breadth-first over an edge set the caller has already scoped, and
// both are PURE. The source interleaves the search with a database round trip
// per frontier, which makes "does this path exist?" answerable only against a
// live store; here the frontier expansion is a function of an edge list, so
// every branch — including "the target is the start" and "the hop budget ran
// out" — is exercisable in memory.
//
// BREADTH-FIRST, NOT DEPTH-FIRST OR WEIGHTED. The question is "how are these two
// connected", and the shortest connection is the one worth showing. Edge weights
// exist but are NOT distances: a weight is how strongly a relationship was
// asserted, and treating a strongly-asserted edge as short would return a longer
// path because it was better attested, which answers a different question.
//
// EDGES ARE UNDIRECTED FOR REACHABILITY AND DIRECTED IN THE ANSWER. A path may
// walk `a works_at b` backwards to get from `b` to `a`, because the relationship
// still connects them; the hop that comes back says `direction: "in"` so a
// reader can tell which way the fact points.
//
// THE HOP BUDGET IS A HARD CEILING, NOT A DEFAULT. Four hops by default and six
// at the most: past six, in a graph where everyone mentions everyone, a path
// exists between almost any pair and reporting one says nothing.

import type { MemoryEntityId } from "./identifiers.js";
import { clampInteger } from "./recall.js";
import { incidentEdges, type EdgeDirection, type MemoryRelationship } from "./relationship.js";

export const DEFAULT_MAX_HOPS = 4;
export const HARD_MAX_HOPS = 6;

export function admitHops(requested: number | undefined): number {
  return clampInteger(requested ?? DEFAULT_MAX_HOPS, 1, HARD_MAX_HOPS);
}

/** One step of a path: the node reached, and the edge that reached it. */
export interface PathHop {
  readonly entityId: MemoryEntityId;
  /** Null on the first hop — the start node was not reached by an edge. */
  readonly relationship: MemoryRelationship | null;
  readonly direction: EdgeDirection | null;
}

/**
 * The shortest path between two nodes, or null when none exists inside the
 * budget.
 *
 * A path from a node to ITSELF is a single hop with no edge, not null and not an
 * empty list: "they are the same node" is a true answer, and an empty list would
 * be indistinguishable from "no path".
 */
export function shortestPath(
  edges: readonly MemoryRelationship[],
  startId: MemoryEntityId,
  targetId: MemoryEntityId,
  maxHops: number = DEFAULT_MAX_HOPS,
): readonly PathHop[] | null {
  if (startId === targetId) return [{ entityId: startId, relationship: null, direction: null }];

  const trace = new Map<MemoryEntityId, PathHop>([
    [startId, { entityId: startId, relationship: null, direction: null }],
  ]);
  const previous = new Map<MemoryEntityId, MemoryEntityId>();
  let frontier: MemoryEntityId[] = [startId];

  for (let depth = 0; depth < maxHops && frontier.length > 0; depth += 1) {
    const next: MemoryEntityId[] = [];
    for (const entityId of frontier) {
      for (const edge of incidentEdges(entityId, edges)) {
        if (trace.has(edge.neighbourId)) continue;
        trace.set(edge.neighbourId, {
          entityId: edge.neighbourId,
          relationship: edge.relationship,
          direction: edge.direction,
        });
        previous.set(edge.neighbourId, entityId);
        if (edge.neighbourId === targetId) return backtrace(trace, previous, startId, targetId);
        next.push(edge.neighbourId);
      }
    }
    frontier = next;
  }
  return null;
}

/**
 * Walk the recorded predecessors back from the target and reverse.
 *
 * Guarded against a missing link rather than assuming the map is total: a
 * caller can only reach this through `shortestPath`, but returning the partial
 * suffix is still better than looping if that ever stops being true.
 */
function backtrace(
  trace: ReadonlyMap<MemoryEntityId, PathHop>,
  previous: ReadonlyMap<MemoryEntityId, MemoryEntityId>,
  startId: MemoryEntityId,
  targetId: MemoryEntityId,
): readonly PathHop[] {
  const reversed: PathHop[] = [];
  let cursor: MemoryEntityId | undefined = targetId;
  while (cursor !== undefined) {
    const hop = trace.get(cursor);
    if (hop === undefined) break;
    reversed.push(hop);
    if (cursor === startId) break;
    cursor = previous.get(cursor);
  }
  return Object.freeze(reversed.reverse());
}

/** A node's immediate neighbourhood, split by direction. */
export interface Neighbourhood {
  readonly entityId: MemoryEntityId;
  readonly outbound: readonly { readonly relationship: MemoryRelationship; readonly toId: MemoryEntityId }[];
  readonly inbound: readonly { readonly relationship: MemoryRelationship; readonly fromId: MemoryEntityId }[];
}

export function neighbourhoodOf(
  entityId: MemoryEntityId,
  edges: readonly MemoryRelationship[],
): Neighbourhood {
  const outbound: { relationship: MemoryRelationship; toId: MemoryEntityId }[] = [];
  const inbound: { relationship: MemoryRelationship; fromId: MemoryEntityId }[] = [];
  for (const edge of incidentEdges(entityId, edges)) {
    if (edge.direction === "out") outbound.push({ relationship: edge.relationship, toId: edge.neighbourId });
    else inbound.push({ relationship: edge.relationship, fromId: edge.neighbourId });
  }
  return { entityId, outbound: Object.freeze(outbound), inbound: Object.freeze(inbound) };
}

/**
 * Every node id reachable in one hop from any of `seeds`, seeds included.
 *
 * This is the set recall fuses against: a memory tagged with any of these slugs
 * is "connected to the situation". Returning the seeds as well is deliberate —
 * a memory attached to the node the query resolved to directly is the most
 * connected thing there is, not the least.
 */
export function oneHopClosure(
  seeds: readonly MemoryEntityId[],
  edges: readonly MemoryRelationship[],
): ReadonlySet<MemoryEntityId> {
  const closure = new Set<MemoryEntityId>(seeds);
  for (const seed of seeds) {
    for (const edge of incidentEdges(seed, edges)) closure.add(edge.neighbourId);
  }
  return closure;
}
