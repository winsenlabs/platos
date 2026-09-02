import { asIdentifier } from "@platos/kernel";
import { describe, expect, it } from "vitest";

import type { EntityKey, MemoryEntityId, MemoryId, MemoryMetadata } from "../domain/index.js";
import { DENSE_SIGNAL, GRAPH_SIGNAL, rankByConnection, retrieveContext } from "./retrieve-context.js";
import {
  entityFixture,
  harness,
  memoryFixture,
  relationshipFixture,
  runtimeGrant,
  type MemoryHarness,
} from "./testing/fixtures.js";
import { deterministicEmbedding } from "./testing/in-memory-embedding-model.js";

const QUERY = {
  authorization: runtimeGrant(),
  query: "acme",
  requestedAgentIds: [],
  limit: null,
  minScore: null,
};

function seedMemory(
  context: MemoryHarness,
  id: string,
  content: string,
  metadata: MemoryMetadata = null,
): void {
  const memory = memoryFixture({ memoryId: asIdentifier<MemoryId>(id), content, metadata });
  context.repository.seed(memory, deterministicEmbedding(content));
}

function seedNode(context: MemoryHarness, id: string, key: string): void {
  context.graph.seedEntity(
    entityFixture({
      entityId: asIdentifier<MemoryEntityId>(id),
      entityKey: asIdentifier<EntityKey>(key),
      label: key,
    }),
  );
}

describe("retrieveContext", () => {
  it("returns the dense answer when the subject has NO graph", async () => {
    const context = harness();
    seedMemory(context, "mem-1", "acme");
    const retrieved = await retrieveContext(context.dependencies, QUERY);
    expect(retrieved.ok).toBe(true);
    if (!retrieved.ok) throw new Error("unreachable");
    expect(retrieved.value.memories.map((entry) => entry.memory.memoryId)).toEqual(["mem-1"]);
    expect(retrieved.value.signals.graphConnected).toBe(0);
    expect(retrieved.value.memories[0]?.signals).toEqual([DENSE_SIGNAL]);
  });

  it("PROMOTES a memory that is both close AND connected to the situation", async () => {
    const context = harness();
    // Both are equally close to the query; only one is tagged with the entity.
    seedMemory(context, "mem-a", "acme corp", null);
    seedMemory(context, "mem-b", "acme corp", { entities: ["acme"] });
    seedNode(context, "ent-1", "acme");

    const retrieved = await retrieveContext(context.dependencies, { ...QUERY, query: "acme corp" });
    if (!retrieved.ok) throw new Error("unreachable");
    expect(retrieved.value.memories[0]?.memory.memoryId).toBe("mem-b");
    expect(retrieved.value.memories[0]?.signals).toEqual([DENSE_SIGNAL, GRAPH_SIGNAL]);
    expect(retrieved.value.signals.graphConnected).toBe(1);
  });

  it("reports the nodes the situation resolved to, and their neighbours", async () => {
    const context = harness();
    seedMemory(context, "mem-1", "acme");
    seedNode(context, "ent-1", "acme");
    seedNode(context, "ent-2", "sam");
    context.graph.seedRelationship(
      relationshipFixture({
        fromEntityId: asIdentifier<MemoryEntityId>("ent-2"),
        toEntityId: asIdentifier<MemoryEntityId>("ent-1"),
      }),
    );
    const retrieved = await retrieveContext(context.dependencies, QUERY);
    if (!retrieved.ok) throw new Error("unreachable");
    expect(retrieved.value.entities.map((entity) => entity.entityKey).sort()).toEqual(["acme", "sam"]);
    expect(retrieved.value.relationships).toHaveLength(1);
  });

  it("does NOT admit a connected memory the dense arm never returned", async () => {
    const context = harness();
    seedMemory(context, "mem-far", "entirely unrelated wording", { entities: ["acme"] });
    seedNode(context, "ent-1", "acme");
    const retrieved = await retrieveContext(context.dependencies, {
      ...QUERY,
      minScore: 0.9,
    });
    if (!retrieved.ok) throw new Error("unreachable");
    expect(retrieved.value.memories).toHaveLength(0);
  });

  it("leaves the dense answer standing when the GRAPH arm fails", async () => {
    const context = harness();
    seedMemory(context, "mem-1", "acme");
    seedNode(context, "ent-1", "acme");
    context.graph.failWith("graph down");
    const retrieved = await retrieveContext(context.dependencies, QUERY);
    expect(retrieved.ok).toBe(true);
    if (!retrieved.ok) throw new Error("unreachable");
    expect(retrieved.value.memories).toHaveLength(1);
    expect(retrieved.value.signals.graphConnected).toBe(0);
    expect(retrieved.value.entities).toHaveLength(0);
  });

  it("FAILS when the dense arm fails — there is no answer without it", async () => {
    const context = harness();
    context.repository.failWith("store down");
    const retrieved = await retrieveContext(context.dependencies, QUERY);
    expect(retrieved.ok).toBe(false);
    if (retrieved.ok) throw new Error("unreachable");
    expect(retrieved.error.code).toBe("MEMORY_REPOSITORY_UNAVAILABLE");
  });

  it("asks the dense arm for MORE than the page it returns", async () => {
    const context = harness();
    for (let index = 0; index < 30; index += 1) seedMemory(context, `mem-${index}`, "acme");
    const retrieved = await retrieveContext(context.dependencies, { ...QUERY, limit: 3 });
    if (!retrieved.ok) throw new Error("unreachable");
    expect(retrieved.value.memories).toHaveLength(3);
    expect(retrieved.value.signals.dense).toBe(20);
  });

  it("requires the RUNTIME grant", async () => {
    const context = harness();
    const retrieved = await retrieveContext(context.dependencies, {
      ...QUERY,
      authorization: context.tenancy.grant(),
    });
    expect(retrieved.ok).toBe(false);
  });

  it("caps how much graph structure it reports", async () => {
    const context = harness({});
    seedMemory(context, "mem-1", "acme");
    for (let index = 0; index < 30; index += 1) seedNode(context, `ent-${index}`, `acme-${index}`);
    const retrieved = await retrieveContext(context.dependencies, QUERY);
    if (!retrieved.ok) throw new Error("unreachable");
    expect(retrieved.value.entities.length).toBeLessThanOrEqual(
      context.dependencies.policy.recall.graphEntityLimit,
    );
  });
});

describe("rankByConnection", () => {
  const recalled = (id: string, entities: readonly string[]) => ({
    memory: memoryFixture({ memoryId: asIdentifier<MemoryId>(id), metadata: { entities: [...entities] } }),
    score: 0.5,
    rankingScore: 0.5,
  });

  it("orders by HOW MANY of the situation's entities a memory carries", () => {
    const ranked = rankByConnection(
      [recalled("mem-a", ["acme"]), recalled("mem-b", ["acme", "sam"])],
      new Set(["acme", "sam"]),
    );
    expect(ranked).toEqual(["mem:mem-b", "mem:mem-a"]);
  });

  it("drops a memory carrying none of them", () => {
    const ranked = rankByConnection([recalled("mem-a", ["other"])], new Set(["acme"]));
    expect(ranked).toEqual([]);
  });

  it("keeps the DENSE order within an equal connection count", () => {
    const ranked = rankByConnection(
      [recalled("mem-b", ["acme"]), recalled("mem-a", ["acme"])],
      new Set(["acme"]),
    );
    expect(ranked).toEqual(["mem:mem-b", "mem:mem-a"]);
  });

  it("ignores a memory with no entity stamp at all", () => {
    const untagged = { memory: memoryFixture(), score: 0.5, rankingScore: 0.5 };
    expect(rankByConnection([untagged], new Set(["acme"]))).toEqual([]);
  });
});
