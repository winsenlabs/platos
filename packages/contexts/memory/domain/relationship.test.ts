import { asIdentifier, environmentScope } from "@platos/kernel";
import { describe, expect, it } from "vitest";

import type {
  AgentId,
  ClusterId,
  EndUserId,
  MemoryEntityId,
  MemoryRelationshipId,
} from "./identifiers.js";
import {
  admitRelationship,
  incidentEdges,
  reassertRelationship,
  relationshipIdentity,
  sameRelationship,
  type MemoryRelationship,
} from "./relationship.js";
import { memorySubject, type MemoryOwnership } from "./scope.js";

const ENVIRONMENT = environmentScope(asIdentifier("org-1"), asIdentifier("proj-1"), asIdentifier("env-1"));
const SUBJECT = memorySubject(ENVIRONMENT, asIdentifier<EndUserId>("user-1"));
const NOW = new Date("2026-09-03T12:00:00.000Z");

const CLUSTER = asIdentifier<ClusterId>("cluster-1");
const AGENT_A: MemoryOwnership = { agentId: asIdentifier<AgentId>("agent-1"), clusterId: null };
const AGENT_B: MemoryOwnership = { agentId: asIdentifier<AgentId>("agent-2"), clusterId: null };
const PEER_A: MemoryOwnership = { agentId: asIdentifier<AgentId>("agent-1"), clusterId: CLUSTER };
const PEER_B: MemoryOwnership = { agentId: asIdentifier<AgentId>("agent-2"), clusterId: CLUSTER };

const FROM = asIdentifier<MemoryEntityId>("ent-1");
const TO = asIdentifier<MemoryEntityId>("ent-2");
const THIRD = asIdentifier<MemoryEntityId>("ent-3");

function relationship(overrides: Partial<MemoryRelationship> = {}): MemoryRelationship {
  return {
    relationshipId: asIdentifier<MemoryRelationshipId>("rel-1"),
    subject: SUBJECT,
    ownership: AGENT_A,
    fromEntityId: FROM,
    toEntityId: TO,
    relationshipType: "works_at",
    weight: 0.5,
    metadata: null,
    sourceMemoryId: null,
    createdAt: NOW,
    ...overrides,
  };
}

describe("edge identity", () => {
  it("is the triple the unique constraint is built on", () => {
    expect(Object.keys(relationshipIdentity(relationship())).sort()).toEqual([
      "fromEntityId",
      "relationshipType",
      "toEntityId",
    ]);
  });

  it("DIRECTION is part of the identity", () => {
    expect(
      sameRelationship(relationship(), relationship({ fromEntityId: TO, toEntityId: FROM })),
    ).toBe(false);
  });

  it("the TYPE is part of the identity", () => {
    expect(sameRelationship(relationship(), relationship({ relationshipType: "founded" }))).toBe(false);
  });

  it("two rows with the same triple are the same edge", () => {
    expect(
      sameRelationship(relationship(), relationship({ relationshipId: asIdentifier<MemoryRelationshipId>("rel-2") })),
    ).toBe(true);
  });
});

describe("admitRelationship", () => {
  const draft = { fromEntityId: FROM, toEntityId: TO, relationshipType: "works_at" };

  it("trims the type and requires it", () => {
    const admitted = admitRelationship({ ...draft, relationshipType: "  works_at  " }, AGENT_A, AGENT_A);
    expect(admitted.ok).toBe(true);
    if (!admitted.ok) throw new Error("unreachable");
    expect(admitted.value.relationshipType).toBe("works_at");
    expect(admitRelationship({ ...draft, relationshipType: "   " }, AGENT_A, AGENT_A).ok).toBe(false);
  });

  it("accepts a weight in [0, 1] and refuses one outside it", () => {
    expect(admitRelationship({ ...draft, weight: 0 }, AGENT_A, AGENT_A).ok).toBe(true);
    expect(admitRelationship({ ...draft, weight: 1 }, AGENT_A, AGENT_A).ok).toBe(true);
    expect(admitRelationship({ ...draft, weight: 1.5 }, AGENT_A, AGENT_A).ok).toBe(false);
    expect(admitRelationship({ ...draft, weight: -1 }, AGENT_A, AGENT_A).ok).toBe(false);
    expect(admitRelationship({ ...draft, weight: Number.NaN }, AGENT_A, AGENT_A).ok).toBe(false);
  });

  it("accepts an explicitly null weight — asserted, unweighted", () => {
    expect(admitRelationship({ ...draft, weight: null }, AGENT_A, AGENT_A).ok).toBe(true);
  });

  it("joins two nodes owned by ONE agent", () => {
    expect(admitRelationship(draft, AGENT_A, AGENT_A).ok).toBe(true);
  });

  it("joins two nodes inside ONE cluster", () => {
    expect(admitRelationship(draft, PEER_A, PEER_B).ok).toBe(true);
  });

  it("REFUSES to join two agents' private nodes", () => {
    const admitted = admitRelationship(draft, AGENT_A, AGENT_B);
    expect(admitted.ok).toBe(false);
    if (admitted.ok) throw new Error("unreachable");
    expect(admitted.error.code).toBe("MEMORY_RELATIONSHIP_ENDPOINTS_SPLIT");
    expect(admitted.error.category).toBe("forbidden");
  });

  it("REFUSES to join a cluster node to a private one", () => {
    expect(admitRelationship(draft, PEER_A, AGENT_B).ok).toBe(false);
  });
});

describe("reassertRelationship", () => {
  it("replaces the weight when the new assertion carries one", () => {
    const reasserted = reassertRelationship(relationship(), {
      fromEntityId: FROM,
      toEntityId: TO,
      relationshipType: "works_at",
      weight: 0.9,
    });
    expect(reasserted.weight).toBe(0.9);
  });

  it("LEAVES the stored weight when the new assertion states none", () => {
    const reasserted = reassertRelationship(relationship(), {
      fromEntityId: FROM,
      toEntityId: TO,
      relationshipType: "works_at",
    });
    expect(reasserted.weight).toBe(0.5);
  });

  it("clears the weight when it is explicitly null", () => {
    const reasserted = reassertRelationship(relationship(), {
      fromEntityId: FROM,
      toEntityId: TO,
      relationshipType: "works_at",
      weight: null,
    });
    expect(reasserted.weight).toBeNull();
  });

  it("never moves `createdAt` — the edge was first observed when it was", () => {
    const reasserted = reassertRelationship(relationship(), {
      fromEntityId: FROM,
      toEntityId: TO,
      relationshipType: "works_at",
      weight: 0.9,
    });
    expect(reasserted.createdAt).toBe(NOW);
    expect(reasserted.relationshipId).toBe("rel-1");
  });
});

describe("incidentEdges", () => {
  const outward = relationship({
    relationshipId: asIdentifier<MemoryRelationshipId>("rel-1"),
    fromEntityId: FROM,
    toEntityId: TO,
  });
  const inward = relationship({
    relationshipId: asIdentifier<MemoryRelationshipId>("rel-2"),
    fromEntityId: THIRD,
    toEntityId: FROM,
  });
  const unrelated = relationship({
    relationshipId: asIdentifier<MemoryRelationshipId>("rel-3"),
    fromEntityId: TO,
    toEntityId: THIRD,
  });

  it("reports direction from the node's point of view", () => {
    const incident = incidentEdges(FROM, [outward, inward, unrelated]);
    expect(incident.map((edge) => edge.direction)).toEqual(["out", "in"]);
    expect(incident.map((edge) => edge.neighbourId)).toEqual([TO, THIRD]);
  });

  it("ignores edges that do not touch the node", () => {
    expect(incidentEdges(FROM, [unrelated])).toEqual([]);
  });

  it("preserves the order it was given, which keeps traversal deterministic", () => {
    const incident = incidentEdges(FROM, [inward, outward]);
    expect(incident.map((edge) => edge.relationship.relationshipId)).toEqual(["rel-2", "rel-1"]);
  });

  it("reports a self-edge ONCE, as outbound", () => {
    const loop = relationship({ fromEntityId: FROM, toEntityId: FROM });
    const incident = incidentEdges(FROM, [loop]);
    expect(incident).toHaveLength(1);
    expect(incident[0]?.direction).toBe("out");
  });
});
