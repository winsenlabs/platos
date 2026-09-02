import { asIdentifier, environmentScope } from "@platos/kernel";
import { describe, expect, it } from "vitest";

import type { EndUserId, MemoryEntityId, MemoryRelationshipId } from "./identifiers.js";
import type { MemoryRelationship } from "./relationship.js";
import { memorySubject } from "./scope.js";
import {
  admitHops,
  DEFAULT_MAX_HOPS,
  HARD_MAX_HOPS,
  neighbourhoodOf,
  oneHopClosure,
  shortestPath,
} from "./traversal.js";

const ENVIRONMENT = environmentScope(asIdentifier("org-1"), asIdentifier("proj-1"), asIdentifier("env-1"));
const SUBJECT = memorySubject(ENVIRONMENT, asIdentifier<EndUserId>("user-1"));
const NOW = new Date("2026-09-03T12:00:00.000Z");

function node(name: string): MemoryEntityId {
  return asIdentifier<MemoryEntityId>(name);
}

let sequence = 0;
function edge(from: string, to: string, type = "knows"): MemoryRelationship {
  sequence += 1;
  return {
    relationshipId: asIdentifier<MemoryRelationshipId>(`rel-${sequence}`),
    subject: SUBJECT,
    ownership: { agentId: asIdentifier("agent-1"), clusterId: null },
    fromEntityId: node(from),
    toEntityId: node(to),
    relationshipType: type,
    weight: null,
    metadata: null,
    sourceMemoryId: null,
    createdAt: NOW,
  };
}

describe("the hop budget", () => {
  it("defaults to four and is hard-capped at six", () => {
    expect(DEFAULT_MAX_HOPS).toBe(4);
    expect(HARD_MAX_HOPS).toBe(6);
    expect(admitHops(undefined)).toBe(4);
    expect(admitHops(99)).toBe(6);
    expect(admitHops(0)).toBe(1);
    expect(admitHops(3)).toBe(3);
  });
});

describe("shortestPath", () => {
  const chain = [edge("a", "b"), edge("b", "c"), edge("c", "d")];

  it("a node to ITSELF is one hop with no edge, not null and not empty", () => {
    const path = shortestPath(chain, node("a"), node("a"));
    expect(path).toHaveLength(1);
    expect(path?.[0]?.relationship).toBeNull();
    expect(path?.[0]?.direction).toBeNull();
  });

  it("walks a chain and reports each hop's edge and direction", () => {
    const path = shortestPath(chain, node("a"), node("c"));
    expect(path?.map((hop) => hop.entityId)).toEqual(["a", "b", "c"]);
    expect(path?.map((hop) => hop.direction)).toEqual([null, "out", "out"]);
  });

  it("walks an edge BACKWARDS for reachability and says so in the direction", () => {
    const path = shortestPath([edge("a", "b")], node("b"), node("a"));
    expect(path?.map((hop) => hop.entityId)).toEqual(["b", "a"]);
    expect(path?.[1]?.direction).toBe("in");
  });

  it("returns the SHORTEST path when two exist", () => {
    const withShortcut = [...chain, edge("a", "d", "sponsors")];
    const path = shortestPath(withShortcut, node("a"), node("d"));
    expect(path?.map((hop) => hop.entityId)).toEqual(["a", "d"]);
  });

  it("returns null when no path exists", () => {
    expect(shortestPath([edge("a", "b")], node("a"), node("z"))).toBeNull();
  });

  it("returns null when the target is beyond the hop budget", () => {
    expect(shortestPath(chain, node("a"), node("d"), 2)).toBeNull();
    expect(shortestPath(chain, node("a"), node("d"), 3)).not.toBeNull();
  });

  it("terminates on a cycle rather than looping", () => {
    const cycle = [edge("a", "b"), edge("b", "c"), edge("c", "a")];
    expect(shortestPath(cycle, node("a"), node("z"), 6)).toBeNull();
    expect(shortestPath(cycle, node("a"), node("c"))?.length).toBe(2);
  });

  it("terminates on a self-edge", () => {
    expect(shortestPath([edge("a", "a")], node("a"), node("z"))).toBeNull();
  });

  it("handles an empty edge set", () => {
    expect(shortestPath([], node("a"), node("b"))).toBeNull();
  });

  it("does not treat edge WEIGHT as distance", () => {
    // Two hops of unweighted edges beat one hop, only because it is shorter.
    const graph = [edge("a", "b"), edge("b", "z"), edge("a", "m"), edge("m", "n"), edge("n", "z")];
    expect(shortestPath(graph, node("a"), node("z"))?.length).toBe(3);
  });
});

describe("neighbourhoodOf", () => {
  it("splits a node's edges by direction", () => {
    const graph = [edge("a", "b"), edge("c", "a"), edge("b", "c")];
    const neighbourhood = neighbourhoodOf(node("a"), graph);
    expect(neighbourhood.outbound.map((entry) => entry.toId)).toEqual(["b"]);
    expect(neighbourhood.inbound.map((entry) => entry.fromId)).toEqual(["c"]);
  });

  it("is empty for an isolated node", () => {
    const neighbourhood = neighbourhoodOf(node("z"), [edge("a", "b")]);
    expect(neighbourhood.outbound).toEqual([]);
    expect(neighbourhood.inbound).toEqual([]);
  });
});

describe("oneHopClosure", () => {
  it("INCLUDES the seeds, which are the most connected things there are", () => {
    const closure = oneHopClosure([node("a")], [edge("a", "b")]);
    expect([...closure].sort()).toEqual(["a", "b"]);
  });

  it("reaches neighbours in either direction", () => {
    const closure = oneHopClosure([node("a")], [edge("a", "b"), edge("c", "a")]);
    expect([...closure].sort()).toEqual(["a", "b", "c"]);
  });

  it("does NOT reach two hops out", () => {
    const closure = oneHopClosure([node("a")], [edge("a", "b"), edge("b", "c")]);
    expect(closure.has(node("c"))).toBe(false);
  });

  it("unions several seeds", () => {
    const closure = oneHopClosure([node("a"), node("x")], [edge("a", "b"), edge("x", "y")]);
    expect([...closure].sort()).toEqual(["a", "b", "x", "y"]);
  });
});
