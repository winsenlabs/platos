// The differential: `memory`'s two in-memory doubles and this adapter, asked the
// SAME questions, with their answers compared VERBATIM.
//
// The fake runs first and the real store second, and the two observation maps
// are compared key by key so a divergence names the step. Nothing is normalised
// on either side — no date coercion, no id masking, no sorting the comparison
// itself — because the scenario is already written to record only what BOTH
// stores can be asked for. See `memory-conformance.ts` for the five things that
// are deliberately not among them.
//
// THE FAKES ARE THE CONTEXT'S OWN, imported from the package that declares the
// ports. Doubles this suite wrote would be doubles that agree with this adapter
// because the same person wrote both, which measures nothing.

import { afterAll, beforeAll, expect, test } from "vitest";

import type {
  AgentId,
  ClusterId,
  EndUserId,
  ThreadId,
  TransactionScope,
  TurnId,
} from "@platos/context-memory/application/ports/index.js";
import { asMemoryIdentifier, EMBEDDING_DIMENSIONS } from "@platos/context-memory/application/ports/index.js";
import {
  InMemoryKnowledgeGraphRepository,
  InMemoryMemoryRepository,
} from "@platos/context-memory/application/testing/index.js";

import type { MemoryChain, MemoryHarness } from "./memory-harness.js";
import { startMemoryHarness } from "./memory-harness.js";
import type { MemoryConformanceIds, MemoryObservation } from "./memory-conformance.js";
import { runMemoryConformance } from "./memory-conformance.js";

let harness: MemoryHarness;
let chain: MemoryChain;
let ids: MemoryConformanceIds;

/** The same vector both sides use. Unit-length, so every cosine is exact. */
function unitVector(axis: number): readonly number[] {
  return Array.from({ length: EMBEDDING_DIMENSIONS }, (_unused, index) =>
    index === axis % EMBEDDING_DIMENSIONS ? 1 : 0,
  );
}

beforeAll(async () => {
  harness = await startMemoryHarness();
  const scope = await harness.freshScope();
  chain = await harness.seedChain(scope);
  ids = {
    scope,
    endUserId: chain.endUserId,
    agentId: chain.agentId,
    peerAgentId: chain.peerAgentId,
    outsideAgentId: chain.outsideAgentId,
    clusterId: chain.clusterId,
    threadId: chain.threadId,
    turnId: chain.turnId,
    secondTurnId: chain.secondTurnId,
    ratingId: chain.ratingId,
    memoryIds: [
      harness.base.freshId("0040"),
      harness.base.freshId("0041"),
      harness.base.freshId("0042"),
      harness.base.freshId("0047"),
    ],
    entityIds: [harness.base.freshId("0043"), harness.base.freshId("0044"), harness.base.freshId("0045")],
    relationshipId: harness.base.freshId("0046"),
    // A uuid of the right SHAPE that names no row, so every miss is a miss
    // rather than a refusal about the id's spelling.
    absentId: "dddddddd-dddd-4ddd-8ddd-dddddddddddd",
  };
}, 300_000);

afterAll(async () => {
  await harness?.stop();
});

/** The doubles, seeded with exactly the peer rows the container holds. */
function buildFakes(): {
  readonly stores: { readonly memory: InMemoryMemoryRepository; readonly memoryGraph: InMemoryKnowledgeGraphRepository };
  readonly run: <Value>(work: (transaction: TransactionScope) => Promise<Value>) => Promise<Value>;
} {
  const memory = new InMemoryMemoryRepository([
    { agentId: asMemoryIdentifier<AgentId>(chain.agentId), clusterId: asMemoryIdentifier<ClusterId>(chain.clusterId) },
    { agentId: asMemoryIdentifier<AgentId>(chain.peerAgentId), clusterId: asMemoryIdentifier<ClusterId>(chain.clusterId) },
    { agentId: asMemoryIdentifier<AgentId>(chain.outsideAgentId), clusterId: null },
  ]);
  memory.seedThread(
    asMemoryIdentifier<ThreadId>(chain.threadId),
    { agentId: asMemoryIdentifier<AgentId>(chain.agentId), clusterId: asMemoryIdentifier<ClusterId>(chain.clusterId) },
    asMemoryIdentifier<EndUserId>(chain.endUserId),
  );
  memory.seedTurns(asMemoryIdentifier<ThreadId>(chain.threadId), [
    asMemoryIdentifier<TurnId>(chain.turnId),
    asMemoryIdentifier<TurnId>(chain.secondTurnId),
  ]);
  memory.seedRating({
    ratingId: chain.ratingId,
    environment: chain.scope,
    endUserId: asMemoryIdentifier<EndUserId>(chain.endUserId),
    turnId: asMemoryIdentifier<TurnId>(chain.turnId),
    revision: 1,
    rating: 1,
  });
  let counter = 0;
  return {
    stores: { memory, memoryGraph: new InMemoryKnowledgeGraphRepository() },
    run: <Value>(work: (transaction: TransactionScope) => Promise<Value>) =>
      work({ transactionId: asMemoryIdentifier(`fake-txn-${String((counter += 1))}`) }),
  };
}

test("the in-memory doubles and the PostgreSQL stores answer the scenario identically", async () => {
  const fakes = buildFakes();
  const fake: MemoryObservation = await runMemoryConformance({
    stores: fakes.stores,
    ids,
    run: fakes.run,
    unitVector,
  });

  const real: MemoryObservation = await runMemoryConformance({
    stores: harness.stores,
    ids,
    run: (work) => harness.base.adapter.unitOfWork.run(work),
    unitVector,
  });

  // The KEY SETS first, so a step one side skipped is reported as a missing step
  // rather than as an undefined value inside a diff of forty entries.
  expect(Object.keys(real).sort()).toEqual(Object.keys(fake).sort());

  for (const step of Object.keys(fake)) {
    expect({ step, value: real[step] }).toEqual({ step, value: fake[step] });
  }
}, 300_000);

test("the scenario is not vacuous: both ports are driven, every write is enlisted, and a refusal is recorded", async () => {
  // A differential that compared two empty maps would pass forever, and one
  // whose every step succeeded could not detect a store that never refuses
  // anything. This runs the scenario against the DOUBLES alone — no container —
  // and pins its shape.
  const fakes = buildFakes();
  const observed = await runMemoryConformance({
    stores: fakes.stores,
    ids,
    run: fakes.run,
    unitVector,
  });

  // Enough steps to be a scenario, and both ports present in the map.
  expect(Object.keys(observed).length).toBeGreaterThanOrEqual(55);
  expect(Object.keys(observed).some((step) => step.startsWith("insertMemory") || step === "insertManual")).toBe(true);
  expect(Object.keys(observed).some((step) => step.startsWith("insertEntity"))).toBe(true);

  // At least one step is a REFUSAL. `insertRelationshipDuplicate` is the one the
  // scenario forces on both sides, and it is the reason the unique on
  // `(from, to, type)` is evidence rather than an assumption.
  expect(observed["insertRelationshipDuplicate"]).toBe("MEMORY_REPOSITORY_UNAVAILABLE");

  // EVERY mutation went through a transaction. The doubles record the id they
  // were handed, so an empty list here would mean the scenario reached a write
  // path that never took one — which is the property `transaction.ts` refuses
  // three separate ways on the real store.
  expect(fakes.stores.memory.writes.length).toBeGreaterThan(0);
  expect(fakes.stores.memoryGraph.writes.length).toBeGreaterThan(0);
  expect(fakes.stores.memory.writes.every((id) => id.startsWith("fake-txn-"))).toBe(true);
  expect(fakes.stores.memoryGraph.writes.every((id) => id.startsWith("fake-txn-"))).toBe(true);
}, 60_000);
