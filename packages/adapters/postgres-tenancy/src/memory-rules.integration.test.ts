// Rules the canonical schema enforces that NO method on either port restates —
// and the one contract the real database proves UNHONOURABLE.
//
// A CONSTRAINT SUITE ASKS "does the store send a value the schema refuses?".
// THIS ONE ASKS "what does the schema do that the store does not know about?".
// Four row rules, one cascade, one foreign key that nulls, and two places where
// the context's own in-memory doubles are WRONG rather than different. Every one
// of them is a fact about the database that a reader of `memory-store.ts` or
// `memory-entities.ts` alone would not learn, and every one of them changes what
// a use case may assume.
//
// THE UNHONOURABLE CONTRACT IS REPORTED, NOT PAPERED OVER. WIN-258 T3 did the
// same with `OperatorSessionRevoker.revoke`, whose truthful count is
// unobtainable because a database rule has already revoked the rows before the
// port runs. Here it is `mergeRepeatedExtraction`, which takes "the newer
// extractorVersion, so a row records which extractor last confirmed it", while
// `Memory_owner_immutable` names `extractorVersion` as an ownership key. A
// re-extraction by a BUMPED extractor is a legal domain operation the schema
// refuses. Both halves are pinned below: the same version updates, a changed one
// is refused, and the row is unchanged either way.
//
// THE SECOND ONE IS IN `memory-vectors.integration.test.ts`, with the rest of
// what the two `vector(1536)` columns decide.

import { afterAll, beforeAll, describe, expect, test } from "vitest";

import type {
  AgentId,
  ClusterId,
  ContentHash,
  EntityKey,
  MemoryEntityId,
  MemoryId,
  ProfileKey,
  ThreadId,
  TransactionScope,
  TurnId,
} from "@platos/context-memory/application/ports/index.js";
import { asMemoryIdentifier } from "@platos/context-memory/application/ports/index.js";
import { runResult } from "@platos/context-memory/application/ports/index.js";
import type { NotResult } from "@platos/context-memory/application/ports/index.js";
import type { Result } from "@platos/context-memory/application/ports/index.js";

import type { MemoryChain, MemoryHarness } from "./memory-harness.js";
import { edgeDraft, entityDraft, memoryDraft, startMemoryHarness } from "./memory-harness.js";
import { countRowsWithEmbedding, writeMemoryEmbedding } from "./memory-vectors.js";

let harness: MemoryHarness;
let chain: MemoryChain;

const AT = new Date("2026-05-01T09:00:00.000Z");
const LATER = new Date("2026-06-01T09:00:00.000Z");

beforeAll(async () => {
  harness = await startMemoryHarness();
  chain = await harness.seedChain(await harness.freshScope());
}, 300_000);

afterAll(async () => {
  await harness?.stop();
});

function id(kind: string): string {
  return harness.base.freshId(kind);
}

function write<Value>(work: (transaction: TransactionScope) => Promise<Result<Value>>): Promise<Result<Value>> {
  return runResult(harness.base.adapter.unitOfWork, work);
}

const clusteredOwner = () => ({
  agentId: asMemoryIdentifier<AgentId>(chain.agentId),
  clusterId: asMemoryIdentifier<ClusterId>(chain.clusterId),
});

describe("Memory_owner_immutable", () => {
  test("an update that changes NOTHING immutable succeeds, including the same extractorVersion", async () => {
    const memoryId = id("0090");
    const extracted = {
      source: "extracted" as const,
      contentHash: asMemoryIdentifier<ContentHash>("1".repeat(64)),
      provenance: {
        sourceThreadId: asMemoryIdentifier<ThreadId>(chain.threadId),
        sourceTurnIds: [asMemoryIdentifier<TurnId>(chain.turnId)],
        extractorVersion: "extractor-v3",
        originalSource: null,
        originalSourceThreadId: null,
        originalSourceTurnIds: [],
      },
    };
    await write((transaction) =>
      harness.stores.memory.insertMemory(
        { memory: memoryDraft(chain, memoryId, AT, extracted), embedding: { action: "keep" } },
        transaction,
      ),
    );

    // The merge rule's OTHER three assignments — a wider turn set, a greater
    // confidence, a fresh access stamp — all land.
    const merged = await write((transaction) =>
      harness.stores.memory.updateMemory(
        {
          memory: memoryDraft(chain, memoryId, LATER, {
            ...extracted,
            provenance: {
              ...extracted.provenance,
              sourceTurnIds: [
                asMemoryIdentifier<TurnId>(chain.turnId),
                asMemoryIdentifier<TurnId>(chain.secondTurnId),
              ],
            },
            confidence: { confidence: 0.9, feedbackBaselineConfidence: null },
          }),
          embedding: { action: "keep" },
        },
        transaction,
      ),
    );
    expect(merged.ok).toBe(true);
    if (merged.ok) {
      expect(merged.value.provenance.sourceTurnIds).toHaveLength(2);
      expect(merged.value.confidence.confidence).toBe(0.9);
    }
  });

  test("*** a BUMPED extractorVersion is REFUSED, and `mergeRepeatedExtraction` produces one ***", async () => {
    // The finding. The rule is
    // `reject_canonical_owner_change('environmentId','endUserId','agentId','clusterId','sourceThreadId','extractorVersion')`
    // and the domain's merge rule takes `incoming.extractorVersion ?? existing`.
    // The store SENDS the column rather than silently dropping it, so the
    // refusal is the database's and is visible; a store that omitted it would
    // have returned `ok` for a write that did not happen.
    const memoryId = id("0091");
    const base = {
      source: "extracted" as const,
      contentHash: asMemoryIdentifier<ContentHash>("2".repeat(64)),
      provenance: {
        sourceThreadId: asMemoryIdentifier<ThreadId>(chain.threadId),
        sourceTurnIds: [asMemoryIdentifier<TurnId>(chain.turnId)],
        extractorVersion: "extractor-v3",
        originalSource: null,
        originalSourceThreadId: null,
        originalSourceTurnIds: [],
      },
    };
    await write((transaction) =>
      harness.stores.memory.insertMemory(
        { memory: memoryDraft(chain, memoryId, AT, base), embedding: { action: "keep" } },
        transaction,
      ),
    );

    const bumped = await write((transaction) =>
      harness.stores.memory.updateMemory(
        {
          memory: memoryDraft(chain, memoryId, LATER, {
            ...base,
            provenance: { ...base.provenance, extractorVersion: "extractor-v4" },
          }),
          embedding: { action: "keep" },
        },
        transaction,
      ),
    );
    expect(bumped.ok).toBe(false);
    if (!bumped.ok) {
      expect(bumped.error.code).toBe("MEMORY_REPOSITORY_UNAVAILABLE");
      expect(String(bumped.error.details?.["reason"] ?? "")).toMatch(/extractorVersion is immutable/u);
    }

    // The row is unchanged, which is what makes the refusal a refusal rather
    // than a partial write.
    const row = await harness.base.client.memory.findUnique({
      where: { id: memoryId },
      select: { extractorVersion: true },
    });
    expect(row?.extractorVersion).toBe("extractor-v3");
  });
});

describe("enforce_memory_entity_owner_transition", () => {
  async function seedStandalone(entityId: string, key: string): Promise<void> {
    await write((transaction) =>
      harness.stores.memoryGraph.insertEntity(
        entityDraft(chain, entityId, AT, {
          entityKey: asMemoryIdentifier<EntityKey>(key),
          ownership: { agentId: asMemoryIdentifier<AgentId>(chain.agentId), clusterId: null },
        }),
        transaction,
      ),
    );
  }

  test("a standalone node PROMOTES into the cluster its agent is actually bound to", async () => {
    const entityId = id("00a0");
    await seedStandalone(entityId, "promote-me");
    const promoted = await write((transaction) =>
      harness.stores.memoryGraph.updateEntity(
        entityDraft(chain, entityId, LATER, {
          entityKey: asMemoryIdentifier<EntityKey>("promote-me"),
          ownership: clusteredOwner(),
        }),
        transaction,
      ),
    );
    expect(promoted.ok).toBe(true);
    if (promoted.ok) expect(promoted.value.ownership.clusterId).toBe(chain.clusterId);
  });

  test("a promotion is REFUSED once the node has an edge", async () => {
    // `IF EXISTS (SELECT 1 FROM MemoryRelationship WHERE from = OLD.id OR to = OLD.id)`
    // — "MemoryEntity with existing relationships cannot change ownership scope".
    // Nothing in the domain knows this, and `promoteEntity` returns a value that
    // is refused here rather than at the call site.
    const from = id("00a1");
    const to = id("00a2");
    await seedStandalone(from, "linked-a");
    await seedStandalone(to, "linked-b");
    await write((transaction) =>
      harness.stores.memoryGraph.insertRelationship(
        edgeDraft(chain, id("00a3"), from, to, AT, {
          ownership: { agentId: asMemoryIdentifier<AgentId>(chain.agentId), clusterId: null },
        }),
        transaction,
      ),
    );

    const refused = await write((transaction) =>
      harness.stores.memoryGraph.updateEntity(
        entityDraft(chain, from, LATER, {
          entityKey: asMemoryIdentifier<EntityKey>("linked-a"),
          ownership: clusteredOwner(),
        }),
        transaction,
      ),
    );
    expect(refused.ok).toBe(false);
    if (!refused.ok) {
      expect(String(refused.error.details?.["reason"] ?? "")).toMatch(/existing relationships/u);
    }
  });

  test("a DEMOTION back to standalone is refused, and so is a re-parent", async () => {
    const entityId = id("00a4");
    await seedStandalone(entityId, "one-way");
    await write((transaction) =>
      harness.stores.memoryGraph.updateEntity(
        entityDraft(chain, entityId, LATER, {
          entityKey: asMemoryIdentifier<EntityKey>("one-way"),
          ownership: clusteredOwner(),
        }),
        transaction,
      ),
    );

    const demoted = await write((transaction) =>
      harness.stores.memoryGraph.updateEntity(
        entityDraft(chain, entityId, LATER, {
          entityKey: asMemoryIdentifier<EntityKey>("one-way"),
          ownership: { agentId: asMemoryIdentifier<AgentId>(chain.agentId), clusterId: null },
        }),
        transaction,
      ),
    );
    expect(demoted.ok).toBe(false);

    // A SECOND cluster in the same environment, to re-parent into.
    const otherCluster = id("00a5");
    harness.applyPeerRows(
      `INSERT INTO "AgentCluster" ("id","environmentId","name","slug","createdAt","updatedAt")
       VALUES ('${otherCluster}','${chain.scope.environmentId}','other','other-${otherCluster.slice(-12)}',
               '2026-05-01T09:00:00Z','2026-05-01T09:00:00Z');`,
    );
    const reparented = await write((transaction) =>
      harness.stores.memoryGraph.updateEntity(
        entityDraft(chain, entityId, LATER, {
          entityKey: asMemoryIdentifier<EntityKey>("one-way"),
          ownership: {
            agentId: asMemoryIdentifier<AgentId>(chain.agentId),
            clusterId: asMemoryIdentifier<ClusterId>(otherCluster),
          },
        }),
        transaction,
      ),
    );
    expect(reparented.ok).toBe(false);
  });
});

describe("the cascades the receipt must not rely on", () => {
  test("deleting a node destroys its edges, and the count a receipt reports comes from deleting them explicitly", async () => {
    // `MemoryRelationship` holds `onDelete: Cascade` to BOTH endpoints, so
    // removing the nodes would take the edges with them — and a cascade reports
    // NOTHING. That is why `deleteRelationshipsForSubject` exists at all, and
    // why the erasure target calls it before `deleteEntitiesForSubject`.
    const from = id("00b0");
    const to = id("00b1");
    const edge = id("00b2");
    await harness.base.adapter.unitOfWork.run(async (transaction) => {
      await harness.stores.memoryGraph.insertEntity(
        entityDraft(chain, from, AT, { entityKey: asMemoryIdentifier<EntityKey>("cascade-a") }),
        transaction,
      );
      await harness.stores.memoryGraph.insertEntity(
        entityDraft(chain, to, AT, { entityKey: asMemoryIdentifier<EntityKey>("cascade-b") }),
        transaction,
      );
      await harness.stores.memoryGraph.insertRelationship(
        edgeDraft(chain, edge, from, to, AT),
        transaction,
      );
    });

    const removed = await write((transaction) =>
      harness.stores.memoryGraph.deleteEntity(
        chain.subject,
        [asMemoryIdentifier<AgentId>(chain.agentId)],
        asMemoryIdentifier<MemoryEntityId>(from),
        transaction,
      ),
    );
    expect(removed.ok && removed.value).toBe(true);
    // The edge went, and the boolean says nothing about it.
    expect(await harness.base.client.memoryRelationship.count({ where: { id: edge } })).toBe(0);
  });

  test("deleting a memory NULLS the edges it sourced rather than destroying them", async () => {
    // `onDelete: SetNull`, and the domain's own comment says why: "the
    // relationship was still observed". An erasure that expected the edge to go
    // with the memory would leave a graph it thought it had destroyed.
    const memoryId = id("00b3");
    const from = id("00b4");
    const to = id("00b5");
    const edge = id("00b6");
    await harness.base.adapter.unitOfWork.run(async (transaction) => {
      await harness.stores.memory.insertMemory(
        { memory: memoryDraft(chain, memoryId, AT), embedding: { action: "keep" } },
        transaction,
      );
      await harness.stores.memoryGraph.insertEntity(
        entityDraft(chain, from, AT, { entityKey: asMemoryIdentifier<EntityKey>("sourced-a") }),
        transaction,
      );
      await harness.stores.memoryGraph.insertEntity(
        entityDraft(chain, to, AT, { entityKey: asMemoryIdentifier<EntityKey>("sourced-b") }),
        transaction,
      );
      await harness.stores.memoryGraph.insertRelationship(
        edgeDraft(chain, edge, from, to, AT, { sourceMemoryId: asMemoryIdentifier<MemoryId>(memoryId) }),
        transaction,
      );
    });

    await write((transaction) =>
      harness.stores.memory.deleteMemories(
        chain.subject,
        [asMemoryIdentifier<AgentId>(chain.agentId)],
        [asMemoryIdentifier<MemoryId>(memoryId)],
        transaction,
      ),
    );

    const row = await harness.base.client.memoryRelationship.findUnique({
      where: { id: edge },
      select: { sourceMemoryId: true },
    });
    expect(row).toEqual({ sourceMemoryId: null });
  });
});



describe("two more places the doubles and the database disagree", () => {
  test("the content-identity probe distinguishes a threaded row from an unthreaded one", async () => {
    // M-M16's guard. The unique is over FOUR columns and `sourceThreadId` is one
    // of them, so a probe that dropped it would report a collision the index does
    // not hold — and `mergeRepeatedExtraction` would then fold a fact extracted
    // from one conversation into a row written by hand.
    const hash = asMemoryIdentifier<ContentHash>("9".repeat(64));
    const unthreaded = id("00e3");
    const threaded = id("00e4");
    await harness.base.adapter.unitOfWork.run(async (transaction) => {
      await harness.stores.memory.insertMemory(
        { memory: memoryDraft(chain, unthreaded, AT, { contentHash: hash, content: "written by hand" }), embedding: { action: "keep" } },
        transaction,
      );
      await harness.stores.memory.insertMemory(
        {
          memory: memoryDraft(chain, threaded, AT, {
            content: "pulled out of a conversation",
            source: "extracted",
            contentHash: hash,
            provenance: {
              sourceThreadId: asMemoryIdentifier<ThreadId>(chain.threadId),
              sourceTurnIds: [asMemoryIdentifier<TurnId>(chain.turnId)],
              extractorVersion: "extractor-v3",
              originalSource: null,
              originalSourceThreadId: null,
              originalSourceTurnIds: [],
            },
          }),
          embedding: { action: "keep" },
        },
        transaction,
      );
    });

    const byThread = await harness.stores.memory.findByContentIdentity(
      chain.subject,
      asMemoryIdentifier<ThreadId>(chain.threadId),
      hash,
    );
    const byNothing = await harness.stores.memory.findByContentIdentity(chain.subject, null, hash);
    expect(byThread.ok && byThread.value?.memoryId).toBe(threaded);
    expect(byNothing.ok && byNothing.value?.memoryId).toBe(unthreaded);
  });

  test("the content-identity unique does NOT bind when the source thread is NULL", async () => {
    // `@@unique([environmentId, endUserId, sourceThreadId, contentHash])`, and
    // PostgreSQL treats NULLs as DISTINCT — so two direct writes with the same
    // hash and no thread do not collide. `InMemoryMemoryRepository` compares
    // `null === null` and refuses the second.
    const hash = asMemoryIdentifier<ContentHash>("3".repeat(64));
    const first = id("00d0");
    const second = id("00d1");
    const one = await write((transaction) =>
      harness.stores.memory.insertMemory(
        { memory: memoryDraft(chain, first, AT, { contentHash: hash }), embedding: { action: "keep" } },
        transaction,
      ),
    );
    const two = await write((transaction) =>
      harness.stores.memory.insertMemory(
        { memory: memoryDraft(chain, second, AT, { contentHash: hash }), embedding: { action: "keep" } },
        transaction,
      ),
    );
    expect(one.ok).toBe(true);
    expect(two.ok).toBe(true);

    // WITH a thread it DOES bind, which is what makes the case above about
    // NULLs rather than about a missing index.
    const threaded = {
      source: "extracted" as const,
      contentHash: asMemoryIdentifier<ContentHash>("4".repeat(64)),
      provenance: {
        sourceThreadId: asMemoryIdentifier<ThreadId>(chain.threadId),
        sourceTurnIds: [asMemoryIdentifier<TurnId>(chain.turnId)],
        extractorVersion: "extractor-v3",
        originalSource: null,
        originalSourceThreadId: null,
        originalSourceTurnIds: [],
      },
    };
    await write((transaction) =>
      harness.stores.memory.insertMemory(
        { memory: memoryDraft(chain, id("00d2"), AT, threaded), embedding: { action: "keep" } },
        transaction,
      ),
    );
    const collision = await write((transaction) =>
      harness.stores.memory.insertMemory(
        { memory: memoryDraft(chain, id("00d3"), AT, threaded), embedding: { action: "keep" } },
        transaction,
      ),
    );
    expect(collision.ok).toBe(false);
  });

  test("`countTurnsInThread` counts ROWS, so a repeated turn id counts once", async () => {
    // The double filters the caller's list and counts the duplicate twice. A
    // `COUNT(*)` over `IN` cannot, and `admitProvenance` de-duplicates before a
    // row is ever built — so the store's answer is the one the caller compares
    // its own de-duplicated list against.
    const counted = await harness.stores.memory.countTurnsInThread(
      asMemoryIdentifier<ThreadId>(chain.threadId),
      [asMemoryIdentifier<TurnId>(chain.turnId), asMemoryIdentifier<TurnId>(chain.turnId)],
    );
    expect(counted.ok && counted.value).toBe(1);
  });
});
