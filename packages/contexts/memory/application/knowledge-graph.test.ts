import { asIdentifier } from "@platos/kernel";
import { describe, expect, it } from "vitest";

import type { EntityKey, MemoryEntityId, MemoryRelationshipId } from "../domain/index.js";
import { forgetEntity, relateEntities, rememberEntity } from "./knowledge-graph.js";
import {
  AGENT,
  bindingFixture,
  CLUSTER,
  entityFixture,
  harness,
  OUTSIDE_AGENT,
  PEER_AGENT,
  relationshipFixture,
  runtimeGrant,
  type MemoryHarness,
} from "./testing/fixtures.js";

const GRANT = { authorization: runtimeGrant(), endUserId: null, actingAgentId: null };
const CLUSTERED_BINDINGS = [
  bindingFixture({ agentId: AGENT, clusterId: CLUSTER }),
  bindingFixture({ agentId: PEER_AGENT, clusterId: CLUSTER }),
];

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

describe("rememberEntity", () => {
  it("creates a node and derives the slug from a display name", async () => {
    const context = harness();
    const upserted = await rememberEntity(context.dependencies, {
      ...GRANT,
      requestedAgentId: null,
      entityKey: "Acme Corp, Inc.",
      label: "Acme Corp",
    });
    expect(upserted.ok).toBe(true);
    if (!upserted.ok) throw new Error("unreachable");
    expect(upserted.value.outcome).toBe("created");
    expect(upserted.value.entity.entityKey).toBe("acme-corp-inc");
  });

  it("refuses a name that slugs to nothing", async () => {
    const context = harness();
    const upserted = await rememberEntity(context.dependencies, {
      ...GRANT,
      requestedAgentId: null,
      entityKey: "???",
    });
    expect(upserted.ok).toBe(false);
    if (upserted.ok) throw new Error("unreachable");
    expect(upserted.error.code).toBe("MEMORY_ENTITY_KEY_INVALID");
  });

  it("is IDEMPOTENT — a second upsert updates rather than appends", async () => {
    const context = harness();
    const first = await rememberEntity(context.dependencies, {
      ...GRANT,
      requestedAgentId: null,
      entityKey: "acme",
      label: "Acme",
    });
    const second = await rememberEntity(context.dependencies, {
      ...GRANT,
      requestedAgentId: null,
      entityKey: "acme",
      label: "Acme Ltd",
    });
    expect(first.ok && second.ok).toBe(true);
    if (!first.ok || !second.ok) throw new Error("unreachable");
    expect(second.value.outcome).toBe("updated");
    expect(second.value.entity.entityId).toBe(first.value.entity.entityId);
    expect(context.graph.allEntities()).toHaveLength(1);
  });

  it("UNIONS aliases across upserts", async () => {
    const context = harness();
    await rememberEntity(context.dependencies, {
      ...GRANT,
      requestedAgentId: null,
      entityKey: "acme",
      aliases: ["Acme"],
    });
    const second = await rememberEntity(context.dependencies, {
      ...GRANT,
      requestedAgentId: null,
      entityKey: "acme",
      aliases: ["ACME Inc"],
    });
    if (!second.ok) throw new Error("unreachable");
    expect(second.value.entity.aliases).toEqual(["Acme", "ACME Inc"]);
  });

  it("PROMOTES a standalone node when its agent has joined a cluster", async () => {
    const context = harness({ bindings: CLUSTERED_BINDINGS });
    node(context, "ent-1", "acme", { ownership: { agentId: AGENT, clusterId: null } });
    const upserted = await rememberEntity(context.dependencies, {
      ...GRANT,
      requestedAgentId: null,
      entityKey: "acme",
    });
    expect(upserted.ok).toBe(true);
    if (!upserted.ok) throw new Error("unreachable");
    expect(upserted.value.outcome).toBe("promoted");
    expect(upserted.value.entity.ownership.clusterId).toBe(CLUSTER);
    expect(context.graph.allEntities()).toHaveLength(1);
  });

  it("REFUSES when a clustered and a standalone node hold the same key", async () => {
    const context = harness({ bindings: CLUSTERED_BINDINGS });
    node(context, "ent-1", "acme", { ownership: { agentId: AGENT, clusterId: null } });
    node(context, "ent-2", "acme", { ownership: { agentId: PEER_AGENT, clusterId: CLUSTER } });
    const upserted = await rememberEntity(context.dependencies, {
      ...GRANT,
      requestedAgentId: null,
      entityKey: "acme",
    });
    expect(upserted.ok).toBe(false);
    if (upserted.ok) throw new Error("unreachable");
    expect(upserted.error.code).toBe("MEMORY_ENTITY_OWNERSHIP_CONFLICT");
  });

  it("embeds a NEW node's label but not an updated one", async () => {
    const context = harness();
    await rememberEntity(context.dependencies, {
      ...GRANT,
      requestedAgentId: null,
      entityKey: "acme",
      label: "Acme",
    });
    expect(context.embeddings.requests).toEqual(["Acme"]);
    await rememberEntity(context.dependencies, { ...GRANT, requestedAgentId: null, entityKey: "acme" });
    expect(context.embeddings.requests).toHaveLength(1);
  });

  it("refuses an unauthorized caller", async () => {
    const context = harness();
    const upserted = await rememberEntity(context.dependencies, {
      authorization: {},
      endUserId: null,
      actingAgentId: null,
      requestedAgentId: null,
      entityKey: "acme",
    });
    expect(upserted.ok).toBe(false);
  });
});

describe("relateEntities", () => {
  it("asserts an edge between two nodes the caller can see", async () => {
    const context = harness();
    node(context, "ent-1", "sam");
    node(context, "ent-2", "acme");
    const related = await relateEntities(context.dependencies, {
      ...GRANT,
      requestedAgentId: null,
      fromEntityId: asIdentifier<MemoryEntityId>("ent-1"),
      toEntityId: asIdentifier<MemoryEntityId>("ent-2"),
      relationshipType: "works_at",
      weight: 0.8,
    });
    expect(related.ok).toBe(true);
    if (!related.ok) throw new Error("unreachable");
    expect(related.value.relationshipType).toBe("works_at");
    expect(related.value.weight).toBe(0.8);
  });

  it("is IDEMPOTENT — re-asserting updates the weight rather than appending", async () => {
    const context = harness();
    node(context, "ent-1", "sam");
    node(context, "ent-2", "acme");
    const command = {
      ...GRANT,
      requestedAgentId: null,
      fromEntityId: asIdentifier<MemoryEntityId>("ent-1"),
      toEntityId: asIdentifier<MemoryEntityId>("ent-2"),
      relationshipType: "works_at",
    };
    const first = await relateEntities(context.dependencies, { ...command, weight: 0.4 });
    const second = await relateEntities(context.dependencies, { ...command, weight: 0.9 });
    expect(first.ok && second.ok).toBe(true);
    if (!first.ok || !second.ok) throw new Error("unreachable");
    expect(context.graph.allRelationships()).toHaveLength(1);
    expect(second.value.relationshipId).toBe(first.value.relationshipId);
    expect(second.value.weight).toBe(0.9);
  });

  it("keeps a REVERSED edge distinct from the forward one", async () => {
    const context = harness();
    node(context, "ent-1", "sam");
    node(context, "ent-2", "acme");
    const base = { ...GRANT, requestedAgentId: null, relationshipType: "knows" };
    await relateEntities(context.dependencies, {
      ...base,
      fromEntityId: asIdentifier<MemoryEntityId>("ent-1"),
      toEntityId: asIdentifier<MemoryEntityId>("ent-2"),
    });
    await relateEntities(context.dependencies, {
      ...base,
      fromEntityId: asIdentifier<MemoryEntityId>("ent-2"),
      toEntityId: asIdentifier<MemoryEntityId>("ent-1"),
    });
    expect(context.graph.allRelationships()).toHaveLength(2);
  });

  it("refuses an endpoint that does not exist", async () => {
    const context = harness();
    node(context, "ent-1", "sam");
    const related = await relateEntities(context.dependencies, {
      ...GRANT,
      requestedAgentId: null,
      fromEntityId: asIdentifier<MemoryEntityId>("ent-1"),
      toEntityId: asIdentifier<MemoryEntityId>("ent-missing"),
      relationshipType: "knows",
    });
    expect(related.ok).toBe(false);
    if (related.ok) throw new Error("unreachable");
    expect(related.error.code).toBe("MEMORY_ENTITY_NOT_FOUND");
  });

  it("refuses an endpoint owned by an agent OUTSIDE the caller's scope", async () => {
    const context = harness({
      bindings: [bindingFixture({ agentId: AGENT }), bindingFixture({ agentId: OUTSIDE_AGENT })],
    });
    node(context, "ent-1", "sam");
    node(context, "ent-2", "acme", { ownership: { agentId: OUTSIDE_AGENT, clusterId: null } });
    const related = await relateEntities(context.dependencies, {
      ...GRANT,
      requestedAgentId: null,
      fromEntityId: asIdentifier<MemoryEntityId>("ent-1"),
      toEntityId: asIdentifier<MemoryEntityId>("ent-2"),
      relationshipType: "knows",
    });
    expect(related.ok).toBe(false);
    if (related.ok) throw new Error("unreachable");
    expect(related.error.code).toBe("MEMORY_ENTITY_NOT_FOUND");
  });

  it("JOINS two nodes owned by different members of ONE cluster", async () => {
    const context = harness({ bindings: CLUSTERED_BINDINGS });
    node(context, "ent-1", "sam", { ownership: { agentId: AGENT, clusterId: CLUSTER } });
    node(context, "ent-2", "acme", { ownership: { agentId: PEER_AGENT, clusterId: CLUSTER } });
    const related = await relateEntities(context.dependencies, {
      ...GRANT,
      requestedAgentId: null,
      fromEntityId: asIdentifier<MemoryEntityId>("ent-1"),
      toEntityId: asIdentifier<MemoryEntityId>("ent-2"),
      relationshipType: "works_at",
    });
    expect(related.ok).toBe(true);
  });

  it("refuses a blank relationship type", async () => {
    const context = harness();
    node(context, "ent-1", "sam");
    node(context, "ent-2", "acme");
    const related = await relateEntities(context.dependencies, {
      ...GRANT,
      requestedAgentId: null,
      fromEntityId: asIdentifier<MemoryEntityId>("ent-1"),
      toEntityId: asIdentifier<MemoryEntityId>("ent-2"),
      relationshipType: "   ",
    });
    expect(related.ok).toBe(false);
    if (related.ok) throw new Error("unreachable");
    expect(related.error.code).toBe("MEMORY_RELATIONSHIP_INVALID");
  });
});

describe("forgetEntity", () => {
  it("destroys the node AND the edges that touched it", async () => {
    const context = harness();
    node(context, "ent-1", "sam");
    node(context, "ent-2", "acme");
    context.graph.seedRelationship(
      relationshipFixture({
        fromEntityId: asIdentifier<MemoryEntityId>("ent-1"),
        toEntityId: asIdentifier<MemoryEntityId>("ent-2"),
      }),
    );
    const forgotten = await forgetEntity(context.dependencies, {
      ...GRANT,
      entityId: asIdentifier<MemoryEntityId>("ent-1"),
    });
    expect(forgotten.ok).toBe(true);
    if (!forgotten.ok) throw new Error("unreachable");
    expect(forgotten.value).toBe(true);
    expect(context.graph.allEntities()).toHaveLength(1);
    expect(context.graph.allRelationships()).toHaveLength(0);
  });

  it("reports false rather than failing when there was nothing to destroy", async () => {
    const context = harness();
    const forgotten = await forgetEntity(context.dependencies, {
      ...GRANT,
      entityId: asIdentifier<MemoryEntityId>("ent-missing"),
    });
    if (!forgotten.ok) throw new Error("unreachable");
    expect(forgotten.value).toBe(false);
  });
});
