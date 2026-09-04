import { asIdentifier } from "@platos/kernel";
import { describe, expect, it } from "vitest";

import type { EntityKey, MemoryEntityId, MemoryRelationshipId } from "../domain/index.js";
import { describeNeighbourhood, findConnection, listEntities, searchEntities } from "./graph-queries.js";
import {
  entityFixture,
  harness,
  relationshipFixture,
  runtimeGrant,
  type MemoryHarness,
} from "./testing/fixtures.js";

const GRANT = { authorization: runtimeGrant(), endUserId: null, actingAgentId: null };

function node(context: MemoryHarness, id: string, key: string, overrides = {}) {
  return context.graph.seedEntity(
    entityFixture({
      entityId: asIdentifier<MemoryEntityId>(id),
      entityKey: asIdentifier<EntityKey>(key),
      label: key,
      ...overrides,
    }),
  );
}

describe("graph reads", () => {
  it("lists a subject's nodes with a total", async () => {
    const context = harness();
    node(context, "ent-1", "sam");
    node(context, "ent-2", "acme");
    const listed = await listEntities(context.dependencies, {
      ...GRANT,
      requestedAgentIds: [],
      limit: 1,
      offset: 0,
    });
    expect(listed.ok).toBe(true);
    if (!listed.ok) throw new Error("unreachable");
    expect(listed.value.items).toHaveLength(1);
    expect(listed.value.total).toBe(2);
  });

  it("searches by label similarity", async () => {
    const context = harness();
    node(context, "ent-1", "acme corp");
    node(context, "ent-2", "sam");
    const found = await searchEntities(context.dependencies, {
      ...GRANT,
      requestedAgentIds: [],
      query: "acme corp",
      limit: 1,
    });
    expect(found.ok).toBe(true);
    if (!found.ok) throw new Error("unreachable");
    expect(found.value[0]?.entity.entityId).toBe("ent-1");
    expect(found.value[0]?.score).toBeCloseTo(1, 10);
  });

  it("describes a node's neighbourhood, split by direction", async () => {
    const context = harness();
    node(context, "ent-1", "sam");
    node(context, "ent-2", "acme");
    node(context, "ent-3", "platform");
    context.graph.seedRelationship(
      relationshipFixture({
        relationshipId: asIdentifier<MemoryRelationshipId>("rel-1"),
        fromEntityId: asIdentifier<MemoryEntityId>("ent-1"),
        toEntityId: asIdentifier<MemoryEntityId>("ent-2"),
      }),
    );
    context.graph.seedRelationship(
      relationshipFixture({
        relationshipId: asIdentifier<MemoryRelationshipId>("rel-2"),
        fromEntityId: asIdentifier<MemoryEntityId>("ent-3"),
        toEntityId: asIdentifier<MemoryEntityId>("ent-1"),
        relationshipType: "led_by",
      }),
    );
    const described = await describeNeighbourhood(context.dependencies, {
      ...GRANT,
      requestedAgentIds: [],
      entityId: asIdentifier<MemoryEntityId>("ent-1"),
    });
    expect(described.ok).toBe(true);
    if (!described.ok) throw new Error("unreachable");
    expect(described.value.neighbourhood.outbound).toHaveLength(1);
    expect(described.value.neighbourhood.inbound).toHaveLength(1);
    expect(described.value.neighbours).toHaveLength(2);
  });

  it("refuses a neighbourhood for a node the caller cannot see", async () => {
    const context = harness();
    const described = await describeNeighbourhood(context.dependencies, {
      ...GRANT,
      requestedAgentIds: [],
      entityId: asIdentifier<MemoryEntityId>("ent-missing"),
    });
    expect(described.ok).toBe(false);
    if (described.ok) throw new Error("unreachable");
    expect(described.error.code).toBe("MEMORY_ENTITY_NOT_FOUND");
  });
});

describe("findConnection", () => {
  function chain(context: MemoryHarness): void {
    for (const [index, key] of ["a", "b", "c", "d"].entries()) {
      node(context, `ent-${index + 1}`, key);
    }
    for (const [index, pair] of [
      ["ent-1", "ent-2"],
      ["ent-2", "ent-3"],
      ["ent-3", "ent-4"],
    ].entries()) {
      context.graph.seedRelationship(
        relationshipFixture({
          relationshipId: asIdentifier<MemoryRelationshipId>(`rel-${index + 1}`),
          fromEntityId: asIdentifier<MemoryEntityId>(pair[0] ?? ""),
          toEntityId: asIdentifier<MemoryEntityId>(pair[1] ?? ""),
          relationshipType: "knows",
        }),
      );
    }
  }

  it("finds a multi-hop path and resolves every node on it", async () => {
    const context = harness();
    chain(context);
    const connection = await findConnection(context.dependencies, {
      ...GRANT,
      requestedAgentIds: [],
      fromEntityId: asIdentifier<MemoryEntityId>("ent-1"),
      toEntityId: asIdentifier<MemoryEntityId>("ent-4"),
      maxHops: null,
    });
    expect(connection.ok).toBe(true);
    if (!connection.ok || connection.value === null) throw new Error("unreachable");
    expect(connection.value.hops.map((hop) => hop.entityId)).toEqual([
      "ent-1",
      "ent-2",
      "ent-3",
      "ent-4",
    ]);
    expect(connection.value.entities).toHaveLength(4);
  });

  it("returns NULL when the budget cannot reach the target", async () => {
    const context = harness();
    chain(context);
    const connection = await findConnection(context.dependencies, {
      ...GRANT,
      requestedAgentIds: [],
      fromEntityId: asIdentifier<MemoryEntityId>("ent-1"),
      toEntityId: asIdentifier<MemoryEntityId>("ent-4"),
      maxHops: 2,
    });
    expect(connection.ok).toBe(true);
    if (!connection.ok) throw new Error("unreachable");
    expect(connection.value).toBeNull();
  });

  it("refuses an endpoint the caller cannot see", async () => {
    const context = harness();
    chain(context);
    const connection = await findConnection(context.dependencies, {
      ...GRANT,
      requestedAgentIds: [],
      fromEntityId: asIdentifier<MemoryEntityId>("ent-1"),
      toEntityId: asIdentifier<MemoryEntityId>("ent-missing"),
      maxHops: null,
    });
    expect(connection.ok).toBe(false);
    if (connection.ok) throw new Error("unreachable");
    expect(connection.error.code).toBe("MEMORY_ENTITY_NOT_FOUND");
  });

  it("a node to ITSELF is one hop, not null", async () => {
    const context = harness();
    chain(context);
    const connection = await findConnection(context.dependencies, {
      ...GRANT,
      requestedAgentIds: [],
      fromEntityId: asIdentifier<MemoryEntityId>("ent-1"),
      toEntityId: asIdentifier<MemoryEntityId>("ent-1"),
      maxHops: null,
    });
    if (!connection.ok || connection.value === null) throw new Error("unreachable");
    expect(connection.value.hops).toHaveLength(1);
  });
});
