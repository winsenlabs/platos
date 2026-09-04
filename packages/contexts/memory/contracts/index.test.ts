import { asIdentifier, type ErasureSubject, type TransactionId, type TransactionScope } from "@platos/kernel";
import { describe, expect, it } from "vitest";

import {
  ENVIRONMENT_SCOPE,
  entityFixture,
  harness,
  memoryFixture,
  relationshipFixture,
  runtimeGrant,
  SUBJECT_ID,
  THREAD,
  turnsFixture,
} from "../application/testing/fixtures.js";
import { deterministicEmbedding } from "../application/testing/in-memory-embedding-model.js";
import type { ContentHash, EntityKey, MemoryEntityId, MemoryId } from "../domain/index.js";
import {
  DEFAULT_EXTRACTION_POLICY,
  DEFAULT_MEMORY_POLICY,
  MEMORY_ERROR_CODES,
  MEMORY_EVENT_NAMES,
  MEMORY_KINDS,
  memoryContract,
  SYNTHESIZED_PROFILE_KEY,
  authorizeMemoryRuntime,
  isMemoryRuntimeAuthorization,
  stableSlug,
  type MemoryContract,
} from "./index.js";

function contractFor(): { contract: MemoryContract; context: ReturnType<typeof harness> } {
  const context = harness();
  return { contract: memoryContract(context.dependencies), context };
}

const READ = {
  authorization: runtimeGrant(),
  endUserId: null,
  actingAgentId: null,
  requestedAgentIds: [],
  kind: null,
  source: null,
  visibilityIn: undefined,
  archiveState: null,
  includeArchived: null,
  limit: null,
  offset: null,
};

describe("the published surface", () => {
  it("names itself, and is frozen so nothing can be patched onto it", () => {
    const { contract } = contractFor();
    expect(contract.name).toBe("memory");
    expect(Object.isFrozen(contract)).toBe(true);
  });

  it("publishes the vocabulary a caller needs to build a command", () => {
    expect(MEMORY_KINDS).toContain("profile");
    expect(MEMORY_ERROR_CODES.length).toBeGreaterThan(0);
    expect(DEFAULT_MEMORY_POLICY.recall.defaultLimit).toBeGreaterThan(0);
    expect(DEFAULT_EXTRACTION_POLICY.enabled).toBe(true);
    expect(SYNTHESIZED_PROFILE_KEY).toBe("_synthesized");
    expect(stableSlug("Acme Corp")).toBe("acme-corp");
  });

  it("publishes the runtime MINT, which `conversations` cannot get elsewhere", () => {
    const minted = authorizeMemoryRuntime({
      ancestry: {
        organizationId: asIdentifier("org-1"),
        projectId: asIdentifier("proj-1"),
        environmentId: asIdentifier("env-1"),
      },
      endUserId: asIdentifier("user-1"),
      actingAgentId: null,
      actorId: asIdentifier("actor-1"),
    });
    expect(isMemoryRuntimeAuthorization(minted)).toBe(true);
    expect(isMemoryRuntimeAuthorization({ ...minted })).toBe(false);
  });

  it("declares its integration events under this context's prefix", () => {
    expect(MEMORY_EVENT_NAMES.length).toBeGreaterThan(0);
    for (const name of MEMORY_EVENT_NAMES) expect(name.startsWith("memory.")).toBe(true);
    expect(new Set(MEMORY_EVENT_NAMES).size).toBe(MEMORY_EVENT_NAMES.length);
  });
});

describe("the views withhold what the note says they withhold", () => {
  it("a memory view carries NO embedding, NO subject id and NO content hash", async () => {
    const { contract, context } = contractFor();
    context.repository.seed(
      memoryFixture({
        memoryId: asIdentifier<MemoryId>("mem-1"),
        contentHash: asIdentifier<ContentHash>("hash-1"),
      }),
      deterministicEmbedding("prefers tea"),
    );
    const described = await contract.describeMemory({
      authorization: runtimeGrant(),
      endUserId: null,
      actingAgentId: null,
      memoryId: asIdentifier<MemoryId>("mem-1"),
    });
    expect(described.ok).toBe(true);
    if (!described.ok) throw new Error("unreachable");
    const keys = Object.keys(described.value);
    expect(keys).not.toContain("embedding");
    expect(keys).not.toContain("endUserId");
    expect(keys).not.toContain("contentHash");
    expect(keys).not.toContain("subject");
  });

  it("derives `agentVisible` on the view rather than carrying a second stored fact", async () => {
    const { contract, context } = contractFor();
    context.repository.seed(
      memoryFixture({ memoryId: asIdentifier<MemoryId>("mem-1"), visibility: "hidden" }),
      deterministicEmbedding("prefers tea"),
    );
    const described = await contract.describeMemory({
      authorization: runtimeGrant(),
      endUserId: null,
      actingAgentId: null,
      memoryId: asIdentifier<MemoryId>("mem-1"),
    });
    if (!described.ok) throw new Error("unreachable");
    expect(described.value.agentVisible).toBe(false);
    expect(described.value.visibility).toBe("hidden");
  });

  it("carries BOTH scores on a recalled memory", async () => {
    const { contract, context } = contractFor();
    context.repository.seed(memoryFixture({ content: "tea" }), deterministicEmbedding("tea"));
    const recalled = await contract.recall({
      authorization: runtimeGrant(),
      query: "tea",
      kind: null,
      requestedAgentIds: [],
      limit: null,
      minScore: null,
      visibilityIn: undefined,
    });
    expect(recalled.ok).toBe(true);
    if (!recalled.ok) throw new Error("unreachable");
    const first = recalled.value.memories[0];
    expect(first?.score).toBeCloseTo(1, 10);
    expect(first?.rankingScore).toBeGreaterThan(0);
    expect(first?.signals).toEqual([]);
  });
});

describe("every method reaches its use case", () => {
  it("writes, reads, pages, exports and forgets a memory", async () => {
    const { contract, context } = contractFor();
    const written = await contract.remember({
      authorization: runtimeGrant(),
      endUserId: null,
      actingAgentId: null,
      requestedAgentId: null,
      kind: "fact",
      content: "prefers tea",
      metadata: null,
      visibility: null,
      agentVisible: null,
      source: null,
      sourceThreadId: null,
      sourceTurnIds: [],
      extractorVersion: null,
      confidence: null,
    });
    expect(written.ok).toBe(true);
    if (!written.ok) throw new Error("unreachable");

    const listed = await contract.listMemories(READ);
    expect(listed.ok && listed.value).toHaveLength(1);

    const paged = await contract.pageMemories(READ);
    if (!paged.ok) throw new Error("unreachable");
    expect(paged.value.total).toBe(1);

    const exported = await contract.exportMemories({ ...READ, afterId: null });
    if (!exported.ok) throw new Error("unreachable");
    expect(exported.value.items).toHaveLength(1);

    const memoryId = asIdentifier<MemoryId>(written.value.memoryId);
    const archived = await contract.archive({
      authorization: runtimeGrant(),
      endUserId: null,
      actingAgentId: null,
      memoryId,
    });
    if (!archived.ok) throw new Error("unreachable");
    expect(archived.value.changed).toBe(true);

    const restored = await contract.restore({
      authorization: runtimeGrant(),
      endUserId: null,
      actingAgentId: null,
      memoryId,
    });
    if (!restored.ok) throw new Error("unreachable");
    expect(restored.value.memory.archivedAt).toBeNull();

    const revised = await contract.revise({
      authorization: runtimeGrant(),
      endUserId: null,
      actingAgentId: null,
      memoryId,
      content: "prefers coffee",
    });
    if (!revised.ok) throw new Error("unreachable");
    expect(revised.value.content).toBe("prefers coffee");

    const forgotten = await contract.forget({
      authorization: runtimeGrant(),
      endUserId: null,
      actingAgentId: null,
      memoryId,
    });
    expect(forgotten).toEqual({ ok: true, value: true });

    const bulk = await contract.forgetMany({
      authorization: runtimeGrant(),
      endUserId: null,
      actingAgentId: null,
      memoryIds: [],
    });
    expect(bulk).toEqual({ ok: true, value: 0 });
  });

  it("recalls, recalls across a cluster, and retrieves fused context", async () => {
    const { contract, context } = contractFor();
    context.repository.seed(memoryFixture({ content: "tea" }), deterministicEmbedding("tea"));
    const query = {
      authorization: runtimeGrant(),
      query: "tea",
      kind: null,
      limit: null,
      minScore: null,
      visibilityIn: undefined,
    };
    expect((await contract.recall({ ...query, requestedAgentIds: [] })).ok).toBe(true);
    expect((await contract.recallAcrossCluster(query)).ok).toBe(true);

    const fused = await contract.retrieveContext({
      authorization: runtimeGrant(),
      query: "tea",
      requestedAgentIds: [],
      limit: null,
      minScore: null,
    });
    expect(fused.ok).toBe(true);
    if (!fused.ok) throw new Error("unreachable");
    expect(fused.value.signals.dense).toBe(1);
  });

  it("upserts a node, asserts an edge, and reads the graph back", async () => {
    const { contract, context } = contractFor();
    const grant = { authorization: runtimeGrant(), endUserId: null, actingAgentId: null };

    const first = await contract.rememberEntity({ ...grant, requestedAgentId: null, entityKey: "Sam" });
    const second = await contract.rememberEntity({ ...grant, requestedAgentId: null, entityKey: "Acme" });
    expect(first.ok && second.ok).toBe(true);
    if (!first.ok || !second.ok) throw new Error("unreachable");
    expect(first.value.outcome).toBe("created");

    const related = await contract.relateEntities({
      ...grant,
      requestedAgentId: null,
      fromEntityId: asIdentifier<MemoryEntityId>(first.value.entity.entityId),
      toEntityId: asIdentifier<MemoryEntityId>(second.value.entity.entityId),
      relationshipType: "works_at",
    });
    expect(related.ok).toBe(true);

    const listed = await contract.listEntities({ ...grant, requestedAgentIds: [], limit: null, offset: null });
    if (!listed.ok) throw new Error("unreachable");
    expect(listed.value.total).toBe(2);

    const searched = await contract.searchEntities({
      ...grant,
      requestedAgentIds: [],
      query: "Sam",
      limit: null,
    });
    if (!searched.ok) throw new Error("unreachable");
    expect(searched.value[0]?.entity.entityKey).toBe("sam");

    const neighbourhood = await contract.describeNeighbourhood({
      ...grant,
      requestedAgentIds: [],
      entityId: asIdentifier<MemoryEntityId>(first.value.entity.entityId),
    });
    if (!neighbourhood.ok) throw new Error("unreachable");
    expect(neighbourhood.value.outbound).toHaveLength(1);
    expect(neighbourhood.value.inbound).toHaveLength(0);

    const connection = await contract.findConnection({
      ...grant,
      requestedAgentIds: [],
      fromEntityId: asIdentifier<MemoryEntityId>(first.value.entity.entityId),
      toEntityId: asIdentifier<MemoryEntityId>(second.value.entity.entityId),
      maxHops: null,
    });
    if (!connection.ok || connection.value === null) throw new Error("unreachable");
    expect(connection.value.hops).toHaveLength(2);
    expect(connection.value.hops[1]?.direction).toBe("out");

    const forgotten = await contract.forgetEntity({
      ...grant,
      entityId: asIdentifier<MemoryEntityId>(first.value.entity.entityId),
    });
    expect(forgotten).toEqual({ ok: true, value: true });
    expect(context.graph.allEntities()).toHaveLength(1);
  });

  it("reports NULL for two nodes with no connection", async () => {
    const { contract, context } = contractFor();
    context.graph.seedEntity(
      entityFixture({ entityId: asIdentifier<MemoryEntityId>("ent-1"), entityKey: asIdentifier<EntityKey>("a") }),
    );
    context.graph.seedEntity(
      entityFixture({ entityId: asIdentifier<MemoryEntityId>("ent-2"), entityKey: asIdentifier<EntityKey>("b") }),
    );
    const connection = await contract.findConnection({
      authorization: runtimeGrant(),
      endUserId: null,
      actingAgentId: null,
      requestedAgentIds: [],
      fromEntityId: asIdentifier<MemoryEntityId>("ent-1"),
      toEntityId: asIdentifier<MemoryEntityId>("ent-2"),
      maxHops: null,
    });
    expect(connection).toEqual({ ok: true, value: null });
  });

  it("extracts, synthesizes and reconciles", async () => {
    const { contract, context } = contractFor();
    context.repository.seedThread(THREAD, { agentId: asIdentifier("agent-1"), clusterId: null }, asIdentifier("user-1"));
    context.repository.seedTurns(THREAD, turnsFixture(20).map((turn) => turn.turnId as never));
    context.judge.answerExtractionWith({
      text: JSON.stringify({
        memories: [
          { kind: "fact", content: "a", confidence: 0.9 },
          { kind: "fact", content: "b", confidence: 0.9 },
          { kind: "fact", content: "c", confidence: 0.9 },
          { kind: "fact", content: "d", confidence: 0.9 },
        ],
      }),
    });
    const extracted = await contract.extractFromConversation({
      authorization: runtimeGrant(),
      threadId: THREAD,
      turns: turnsFixture(6),
      storedPolicy: null,
    });
    expect(extracted.ok).toBe(true);
    if (!extracted.ok) throw new Error("unreachable");
    expect(extracted.value.memoriesWritten).toBe(4);

    context.judge.answerSynthesisWith({ text: "You lead platform." });
    const synthesized = await contract.synthesizeProfile({
      authorization: runtimeGrant(),
      endUserId: null,
      actingAgentId: null,
    });
    if (!synthesized.ok) throw new Error("unreachable");
    expect(synthesized.value.written).toBe(true);

    const fromRating = await contract.reconcileFromRating({
      authorization: runtimeGrant(),
      ratingId: "rating-1",
      expectedRevision: 1,
    });
    if (!fromRating.ok) throw new Error("unreachable");
    expect(fromRating.value.standing).toBe("missing");

    const fromTurn = await contract.reconcileFromTurn({
      authorization: runtimeGrant(),
      environment: ENVIRONMENT_SCOPE,
      endUserId: asIdentifier("user-1"),
      turnId: asIdentifier("turn-1"),
    });
    expect(fromTurn.ok).toBe(true);
  });
});

describe("failures cross the boundary as values", () => {
  it("an unauthorized call returns a `Result`, never a thrown error", async () => {
    const { contract } = contractFor();
    const described = await contract.describeMemory({
      authorization: {},
      endUserId: null,
      actingAgentId: null,
      memoryId: asIdentifier<MemoryId>("mem-1"),
    });
    expect(described.ok).toBe(false);
    if (described.ok) throw new Error("unreachable");
    expect(MEMORY_ERROR_CODES).toContain(described.error.code);
  });

  it("a store failure crosses as a domain error, not as an exception", async () => {
    const { contract, context } = contractFor();
    context.repository.failWith("store down");
    const listed = await contract.listMemories(READ);
    expect(listed.ok).toBe(false);
    if (listed.ok) throw new Error("unreachable");
    expect(listed.error.code).toBe("MEMORY_REPOSITORY_UNAVAILABLE");
  });
});

// THE ERASURE TARGET HAD NO PUBLICATION PATH. `createMemoryErasureTarget`
// existed, was tested directly, and was reachable from nowhere: `MemoryContract`
// declared no `erasureTarget()`, this barrel re-exported no erasure symbol, and
// `package.json` publishes exactly two entrypoints — this one and
// `application/ports/index.js`. The composition root could therefore not obtain
// it, so `privacy`'s multi-context erasure silently omitted the sole writer of
// `Memory`, `MemoryEntity` and `MemoryRelationship` — the three models that hold
// what a subject actually said.
//
// These cases go THROUGH the published binder rather than through
// `createMemoryErasureTarget`, so a binder that drops the method again goes red
// here even though the use case's own suite would stay green. `files` on v1 and
// `jobs` in this wave publish it the same way.
describe("the ErasureTarget the composition root collects", () => {
  const SUBJECT: ErasureSubject = {
    subjectKind: "end-user",
    subjectId: SUBJECT_ID,
    scope: ENVIRONMENT_SCOPE,
  };
  const TRANSACTION: TransactionScope = { transactionId: asIdentifier<TransactionId>("txn-1") };

  it("is published on the contract, named for this context", () => {
    const { contract } = contractFor();
    expect(contract.erasureTarget().targetName).toBe("memory");
  });

  it("plans and erases this context's three models through the published surface", async () => {
    const { contract, context } = contractFor();
    context.repository.seed(memoryFixture({ memoryId: asIdentifier<MemoryId>("mem-1") }));
    context.graph.seedEntity(entityFixture({ entityId: asIdentifier<MemoryEntityId>("ent-1") }));
    context.graph.seedRelationship(relationshipFixture());

    const target = contract.erasureTarget();
    const plan = await target.plan(SUBJECT);
    expect(plan.items.map((item) => item.model)).toEqual([
      "Memory",
      "MemoryEntity",
      "MemoryRelationship",
    ]);
    expect(plan.items.map((item) => item.rowCount)).toEqual([1, 1, 1]);

    const receipt = await target.erase(plan, TRANSACTION);
    expect(receipt.items.map((item) => item.rowCount)).toEqual([1, 1, 1]);
    expect(context.repository.all()).toHaveLength(0);
    expect(context.graph.allEntities()).toHaveLength(0);
    expect(context.graph.allRelationships()).toHaveLength(0);
  });
});
