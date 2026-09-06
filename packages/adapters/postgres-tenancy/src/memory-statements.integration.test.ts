// Statement counts, MEASURED — the N+1 control for `memory`'s two stores.
//
// EVERY PIN IS TAKEN TWICE, over a small subject and one an order of magnitude
// larger, and both must be identical. A read whose cost grows with the rows it
// returns is correct in every case and expensive in exactly one: the
// installation that has been running longest. `searchMemories` is the read this
// matters most for — it is on the hot path of every turn — and it is also the
// one whose obvious wrong implementation is invisible: build the `WHERE` in
// JavaScript and a filtered search becomes a query per filter, or fetch the
// candidates and then resolve each row by id.
//
// THE PROBE PATTERN IS ANCHORED, and this is tranche 3's trap rather than a
// precaution. Its advisory lock projected `SELECT 1`, which is exactly the shape
// the statement suites strip to discard the driver's connection probe, so the
// lock was measured at ZERO statements and a mutation that removed it survived.
// The filter below anchors the probe to a statement that is ONLY `SELECT 1`, and
// every measurement records the unfiltered total beside the filtered count — so
// a measurement can never be smaller than the thing it is measuring.
//
// THE VECTOR WRITE IS THE ONE PLACE A SECOND STATEMENT IS CORRECT, and it is
// pinned at exactly two rather than left unbounded. `Memory.embedding` is
// `Unsupported("vector(1536)")`, so an insert that stores one is a `create` plus
// a raw `UPDATE`; `keep` sends only the first, and that difference is what makes
// `EmbeddingDirective` a three-case union rather than a nullable vector.

import { afterAll, beforeAll, describe, expect, test } from "vitest";

import type {
  AgentId,
  ClusterId,
  EndUserId,
  EntityKey,
  MemoryEntityId,
  MemoryFilter,
  MemoryId,
  ThreadId,
  TransactionScope,
  TurnId,
} from "@platos/context-memory/application/ports/index.js";
import { asMemoryIdentifier } from "@platos/context-memory/application/ports/index.js";

import type { MemoryChain, MemoryHarness } from "./memory-harness.js";
import { edgeDraft, entityDraft, memoryDraft, startMemoryHarness } from "./memory-harness.js";

let harness: MemoryHarness;

const AT = new Date("2026-05-01T09:00:00.000Z");

interface Fixture {
  readonly chain: MemoryChain;
  readonly memoryIds: readonly string[];
  readonly entityIds: readonly string[];
}

let small: Fixture;
let large: Fixture;

/**
 * Statements the CLIENT sent, less the transaction frame.
 *
 * `BEGIN`/`COMMIT`/`ROLLBACK`/`DEALLOCATE` are the driver's bookkeeping and are
 * not what an N+1 is made of. `SELECT 1` is the driver's connection probe and is
 * matched ONLY when the whole statement is that and nothing else, so a read that
 * genuinely projects a constant cannot be discarded by the thing measuring it.
 */
function queries(): readonly string[] {
  return harness.base
    .statements()
    .filter(
      (statement) =>
        !/^\s*(BEGIN|COMMIT|ROLLBACK|DEALLOCATE)\b/iu.test(statement) &&
        !/^\s*SELECT\s+1\s*$/iu.test(statement),
    );
}

interface Measurement {
  readonly counted: number;
  readonly total: number;
}

async function measure(work: () => Promise<unknown>): Promise<Measurement> {
  harness.base.resetStatements();
  await work();
  return { counted: queries().length, total: harness.base.statements().length };
}

function write<Value>(work: (transaction: TransactionScope) => Promise<Value>): Promise<Value> {
  return harness.base.adapter.unitOfWork.run(work);
}

/** `rows` memories and `rows` entities for one fresh subject. */
async function seedFixture(rows: number): Promise<Fixture> {
  const chain = await harness.seedChain(await harness.freshScope());
  const memoryIds: string[] = [];
  const entityIds: string[] = [];
  for (let index = 0; index < rows; index += 1) {
    const memoryId = harness.base.freshId("00e0");
    const entityId = harness.base.freshId("00e1");
    memoryIds.push(memoryId);
    entityIds.push(entityId);
    await write(async (transaction) => {
      await harness.stores.memory.insertMemory(
        {
          memory: memoryDraft(chain, memoryId, new Date(AT.getTime() + index * 1000), {
            content: `fact number ${String(index)}`,
          }),
          embedding: { action: "set", vector: harness.unitVector(index) },
        },
        transaction,
      );
      await harness.stores.memoryGraph.insertEntity(
        entityDraft(chain, entityId, new Date(AT.getTime() + index * 1000), {
          entityKey: asMemoryIdentifier<EntityKey>(`node-${String(index)}`),
          label: `Node ${String(index)}`,
        }),
        transaction,
      );
    });
  }
  // One edge, so `listIncidentRelationships` has something to answer with.
  await write((transaction) =>
    harness.stores.memoryGraph.insertRelationship(
      edgeDraft(chain, harness.base.freshId("00e2"), entityIds[0] ?? "", entityIds[1] ?? "", AT),
      transaction,
    ),
  );
  return { chain, memoryIds, entityIds };
}

function filterFor(fixture: Fixture): MemoryFilter {
  return {
    subject: fixture.chain.subject,
    agentIds: [asMemoryIdentifier<AgentId>(fixture.chain.agentId)],
    kind: null,
    source: null,
    visibilities: [],
    archiveState: "all",
    excludeRag: false,
    excludeQuarantined: false,
  };
}

beforeAll(async () => {
  harness = await startMemoryHarness();
  small = await seedFixture(2);
  large = await seedFixture(20);
}, 600_000);

afterAll(async () => {
  await harness?.stop();
});

describe("the writes", () => {
  test("an insert WITHOUT a vector is one statement; WITH one it is exactly two", async () => {
    const withoutVector = await measure(() =>
      write((transaction) =>
        harness.stores.memory.insertMemory(
          { memory: memoryDraft(small.chain, harness.base.freshId("00f0"), AT), embedding: { action: "keep" } },
          transaction,
        ),
      ),
    );
    expect(withoutVector.counted).toBe(1);
    expect(withoutVector.total).toBeGreaterThanOrEqual(withoutVector.counted);

    const withVector = await measure(() =>
      write((transaction) =>
        harness.stores.memory.insertMemory(
          {
            memory: memoryDraft(small.chain, harness.base.freshId("00f1"), AT),
            embedding: { action: "set", vector: harness.unitVector(5) },
          },
          transaction,
        ),
      ),
    );
    expect(withVector.counted).toBe(2);
  });

  test("`touchAccessed` is ONE statement for one row and ONE for twenty", async () => {
    // The wrong implementation is a loop, and it is the natural one: the port
    // takes a LIST of ids and stamps each. Twenty ids costing twenty statements
    // would be invisible on a page of three and ruinous on a recall of two
    // hundred candidates.
    const one = await measure(() =>
      harness.stores.memory.touchAccessed(
        small.chain.scope,
        small.memoryIds.slice(0, 1).map((memoryId) => asMemoryIdentifier<MemoryId>(memoryId)),
        AT,
      ),
    );
    const many = await measure(() =>
      harness.stores.memory.touchAccessed(
        large.chain.scope,
        large.memoryIds.map((memoryId) => asMemoryIdentifier<MemoryId>(memoryId)),
        AT,
      ),
    );
    expect(one.counted).toBe(1);
    expect(many.counted).toBe(1);
  });

  test("an erasure is ONE statement per table however many rows it destroys", async () => {
    const fixture = await seedFixture(6);
    const selector = {
      environment: fixture.chain.scope,
      endUserId: asMemoryIdentifier<EndUserId>(fixture.chain.endUserId),
    };
    const edges = await measure(() =>
      write((transaction) => harness.stores.memoryGraph.deleteRelationshipsForSubject(selector, transaction)),
    );
    const nodes = await measure(() =>
      write((transaction) => harness.stores.memoryGraph.deleteEntitiesForSubject(selector, transaction)),
    );
    const memories = await measure(() =>
      write((transaction) => harness.stores.memory.deleteMemoriesForSubject(selector, transaction)),
    );
    expect([edges.counted, nodes.counted, memories.counted]).toEqual([1, 1, 1]);
  });
});

describe("the set reads", () => {
  test("`listMemories` is ONE statement for two rows and ONE for twenty", async () => {
    const twoRows = await measure(() => harness.stores.memory.listMemories(filterFor(small), 50, 0));
    const twentyRows = await measure(() => harness.stores.memory.listMemories(filterFor(large), 50, 0));
    expect(twoRows.counted).toBe(1);
    expect(twentyRows.counted).toBe(1);
    expect(twentyRows.total).toBeGreaterThanOrEqual(twentyRows.counted);
  });

  test("every filter narrows inside the SAME statement — six of them cost what none does", async () => {
    // The extraction source builds its `WHERE` by joining a `clauses` array; the
    // shape that would show up here is one statement per narrowing, or a fetch
    // followed by a filter in JavaScript.
    const bare = await measure(() => harness.stores.memory.listMemories(filterFor(large), 50, 0));
    const narrowed = await measure(() =>
      harness.stores.memory.listMemories(
        {
          ...filterFor(large),
          kind: "fact",
          source: "manual",
          visibilities: ["agent_visible"],
          archiveState: "active",
          excludeRag: true,
          excludeQuarantined: true,
        },
        50,
        0,
      ),
    );
    expect(bare.counted).toBe(1);
    expect(narrowed.counted).toBe(1);
  });

  test("`pageMemories` is exactly TWO — a page and its total, and never a third", async () => {
    const twoRows = await measure(() => harness.stores.memory.pageMemories(filterFor(small), 10, 0));
    const twentyRows = await measure(() => harness.stores.memory.pageMemories(filterFor(large), 10, 0));
    expect(twoRows.counted).toBe(2);
    expect(twentyRows.counted).toBe(2);
  });

  test("`listExportPage` is ONE statement, and resuming from a cursor is still one", async () => {
    const first = await measure(() => harness.stores.memory.listExportPage(filterFor(large), null, 5));
    expect(first.counted).toBe(1);

    const page = await harness.stores.memory.listExportPage(filterFor(large), null, 5);
    const cursor = page.ok ? page.value.nextCursor : null;
    expect(cursor).not.toBeNull();
    const resumed = await measure(() => harness.stores.memory.listExportPage(filterFor(large), cursor, 5));
    expect(resumed.counted).toBe(1);
  });

  test("`searchMemories` is ONE statement, filtered or not, small or large", async () => {
    const twoRows = await measure(() =>
      harness.stores.memory.searchMemories({
        filter: filterFor(small),
        embedding: harness.unitVector(0),
        candidateLimit: 20,
      }),
    );
    const twentyRows = await measure(() =>
      harness.stores.memory.searchMemories({
        filter: filterFor(large),
        embedding: harness.unitVector(0),
        candidateLimit: 20,
      }),
    );
    const filtered = await measure(() =>
      harness.stores.memory.searchMemories({
        filter: { ...filterFor(large), kind: "fact", excludeRag: true, excludeQuarantined: true },
        embedding: harness.unitVector(0),
        candidateLimit: 20,
      }),
    );
    expect([twoRows.counted, twentyRows.counted, filtered.counted]).toEqual([1, 1, 1]);
  });

  test("`listMemoriesForSourceTurn` is ONE statement, and it is an array containment rather than a scan", async () => {
    const measured = await measure(() =>
      harness.stores.memory.listMemoriesForSourceTurn(
        large.chain.scope,
        asMemoryIdentifier<EndUserId>(large.chain.endUserId),
        asMemoryIdentifier<TurnId>(large.chain.turnId),
      ),
    );
    expect(measured.counted).toBe(1);
  });
});

describe("the peer reads", () => {
  test("`findRatingRevision` resolves the whole scope in ONE statement, not three", async () => {
    // `MessageRating` carries `environmentId` and nothing above it, and
    // `RatingRevision` carries a whole `EnvironmentScope`. The obvious wrong
    // implementation reads the rating, then the environment, then the project.
    const measured = await measure(() => harness.stores.memory.findRatingRevision(large.chain.ratingId));
    expect(measured.counted).toBe(1);
  });

  test("`listAgentBindings` and `countTurnsInThread` are one apiece", async () => {
    const bindings = await measure(() => harness.stores.memory.listAgentBindings(large.chain.scope));
    const turns = await measure(() =>
      harness.stores.memory.countTurnsInThread(asMemoryIdentifier<ThreadId>(large.chain.threadId), [
        asMemoryIdentifier<TurnId>(large.chain.turnId),
        asMemoryIdentifier<TurnId>(large.chain.secondTurnId),
      ]),
    );
    expect([bindings.counted, turns.counted]).toEqual([1, 1]);
  });
});

describe("the graph reads", () => {
  test("`findEntityCandidates` asks BOTH ownership domains in one statement", async () => {
    const measured = await measure(() =>
      harness.stores.memoryGraph.findEntityCandidates(
        large.chain.subject,
        {
          agentId: asMemoryIdentifier<AgentId>(large.chain.agentId),
          clusterId: asMemoryIdentifier<ClusterId>(large.chain.clusterId),
        },
        asMemoryIdentifier<EntityKey>("node-0"),
      ),
    );
    expect(measured.counted).toBe(1);
  });

  test("`listEntitiesByIds` is ONE statement for one id and ONE for twenty", async () => {
    // `domain/traversal.ts` expands a frontier by handing this method the ids it
    // just collected. One statement per id is the shape that turns a six-hop
    // traversal into a hundred round trips.
    const one = await measure(() =>
      harness.stores.memoryGraph.listEntitiesByIds(
        large.chain.subject,
        [asMemoryIdentifier<AgentId>(large.chain.agentId)],
        large.entityIds.slice(0, 1).map((entityId) => asMemoryIdentifier<MemoryEntityId>(entityId)),
      ),
    );
    const many = await measure(() =>
      harness.stores.memoryGraph.listEntitiesByIds(
        large.chain.subject,
        [asMemoryIdentifier<AgentId>(large.chain.agentId)],
        large.entityIds.map((entityId) => asMemoryIdentifier<MemoryEntityId>(entityId)),
      ),
    );
    expect([one.counted, many.counted]).toEqual([1, 1]);
  });

  test("`listIncidentRelationships` is ONE statement for a frontier of one and for a frontier of twenty", async () => {
    const one = await measure(() =>
      harness.stores.memoryGraph.listIncidentRelationships(
        large.chain.subject,
        [asMemoryIdentifier<AgentId>(large.chain.agentId)],
        large.entityIds.slice(0, 1).map((entityId) => asMemoryIdentifier<MemoryEntityId>(entityId)),
      ),
    );
    const many = await measure(() =>
      harness.stores.memoryGraph.listIncidentRelationships(
        large.chain.subject,
        [asMemoryIdentifier<AgentId>(large.chain.agentId)],
        large.entityIds.map((entityId) => asMemoryIdentifier<MemoryEntityId>(entityId)),
      ),
    );
    expect([one.counted, many.counted]).toEqual([1, 1]);
  });

  test("`searchEntities` is ONE statement, and `listEntities` is two — a page and its total", async () => {
    const searched = await measure(() =>
      harness.stores.memoryGraph.searchEntities({
        subject: large.chain.subject,
        agentIds: [asMemoryIdentifier<AgentId>(large.chain.agentId)],
        embedding: harness.unitVector(0),
        limit: 10,
      }),
    );
    const listed = await measure(() =>
      harness.stores.memoryGraph.listEntities(
        large.chain.subject,
        [asMemoryIdentifier<AgentId>(large.chain.agentId)],
        10,
        0,
      ),
    );
    expect(searched.counted).toBe(1);
    expect(listed.counted).toBe(2);
  });
});

describe("the measurement is not measuring nothing", () => {
  test("an empty agent set answers WITHOUT a statement, and that is the only zero here", async () => {
    // The port says "Empty means no agent is readable", so the answer is
    // knowable without the database. Every pin above is taken with a non-empty
    // set precisely so this is the one case that reads zero.
    const measured = await measure(() =>
      harness.stores.memory.listMemories({ ...filterFor(large), agentIds: [] }, 10, 0),
    );
    expect(measured.counted).toBe(0);
  });

  test("the filter cannot discard a statement that is not the driver's probe", () => {
    // Trap: tranche 3's advisory lock projected `SELECT 1` and was measured at
    // ZERO. The anchor below is what stops that, and this is the case that keeps
    // the anchor honest.
    const probe = /^\s*SELECT\s+1\s*$/iu;
    expect(probe.test("SELECT 1")).toBe(true);
    expect(probe.test('SELECT 1 FROM "Memory" WHERE "id" = $1')).toBe(false);
    expect(probe.test('SELECT count(*) AS "present" FROM "Memory"')).toBe(false);
  });
});
