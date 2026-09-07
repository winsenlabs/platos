// The differential: `conversations`' in-memory double and this adapter, asked
// the SAME questions, with their answers compared VERBATIM.
//
// The fake runs first and the real store second, and the two observation maps
// are compared key by key so a divergence names the step. Nothing is normalised
// on either side — no date coercion, no id masking, no sorting the comparison
// itself — because the scenario is already written to record only what BOTH
// stores can be asked for.
//
// THE FAKE IS THE CONTEXT'S OWN, imported from the package that declares the
// ports. A double this suite wrote would be a double that agrees with this
// adapter because the same person wrote both, which measures nothing.
//
// ONE DOUBLE SATISFIES ALL FOUR PORTS. `InMemoryConversations` implements
// `ThreadRepository`, `TurnRepository`, `PostmanRepository` and
// `ConversationsErasureStore` on one object, "because the four share a
// foreign-key graph" — so the four named slots below all hold the SAME instance,
// which is also what lets the erasure step see the threads the earlier steps
// wrote.

import { afterAll, beforeAll, expect, test } from "vitest";

import type {
  EnvironmentScope,
  TransactionScope,
} from "@platos/context-conversations/application/ports/index.js";
import {
  InMemoryConversations,
  TestUnitOfWork,
} from "@platos/context-conversations/application/testing/index.js";
import { runResult } from "@platos/context-conversations/application/ports/index.js";
import type { NotResult } from "@platos/context-conversations/application/ports/index.js";

import type {
  ConversationsConformanceIds,
  ConversationsObservation,
} from "./conversations-conformance.js";
import { runConversationsConformance } from "./conversations-conformance.js";
import type { ConversationsHarness, PeerChain } from "./conversations-harness.js";
import { startConversationsHarness } from "./conversations-harness.js";
import type { ConversationsStores } from "./conversations-repository.js";

let harness: ConversationsHarness;
let chain: PeerChain;
let ids: ConversationsConformanceIds;

beforeAll(async () => {
  harness = await startConversationsHarness();
  const scope = await harness.freshScope();
  chain = await harness.seedChain(scope);
  ids = {
    agentId: chain.agentId,
    agentVersionId: chain.agentVersionId,
    secondAgentVersionId: chain.secondAgentVersionId,
    clusterId: chain.clusterId,
    endUserId: chain.endUserId,
    templateId: chain.templateId,
    actorUserId: chain.actorUserId,
    modelPriceId: chain.modelPriceId,
    threadId: "c0000001-0000-4000-8000-000000000001",
    secondThreadId: "c0000001-0000-4000-8000-000000000002",
    firstTurnId: "c0000002-0000-4000-8000-000000000001",
    secondTurnId: "c0000002-0000-4000-8000-000000000002",
    replyTurnId: "c0000002-0000-4000-8000-000000000003",
    firstStepId: "c0000003-0000-4000-8000-000000000001",
    secondStepId: "c0000003-0000-4000-8000-000000000002",
    executionId: "c0000004-0000-4000-8000-000000000001",
    // A version-4, variant-8 uuid, because `PostmanExecution_contextHandle_check`
    // pins BOTH nibbles and the double would take any string at all.
    contextHandle: "c0000005-0000-4000-8000-000000000001",
    requestId: "c0000006-0000-4000-8000-000000000001",
    absentId: "dddddddd-dddd-4ddd-8ddd-dddddddddddd",
  };
}, 300_000);

afterAll(async () => {
  await harness?.stop();
});

test("the fake and the real store answer the same scenario identically", async () => {
  const scope: EnvironmentScope = chain.scope;

  const fake = new InMemoryConversations();
  const fakeUnitOfWork = new TestUnitOfWork();
  const fakeStores: ConversationsStores = {
    threads: fake,
    turns: fake,
    postman: fake,
    conversationsErasure: fake,
  };
  const fromFake: ConversationsObservation = await runConversationsConformance({
    stores: fakeStores,
    scope,
    ids,
    run: <Value>(work: (transaction: TransactionScope) => Promise<Value>) =>
      fakeUnitOfWork.run(work),
  });

  const fromReal: ConversationsObservation = await runConversationsConformance({
    stores: harness.stores,
    scope,
    ids,
    run: <Value>(work: (transaction: TransactionScope) => Promise<NotResult<Value>>) =>
      harness.base.adapter.unitOfWork.run<Value>(work),
  });

  // KEY BY KEY, so a divergence names the step rather than dumping two objects.
  expect(Object.keys(fromReal).sort()).toEqual(Object.keys(fromFake).sort());
  for (const step of Object.keys(fromFake)) {
    expect({ step, observed: fromReal[step] }).toEqual({ step, observed: fromFake[step] });
  }

  // The scenario has to have DONE something. A run that recorded nothing would
  // satisfy every assertion above.
  expect(Object.keys(fromFake).length).toBeGreaterThan(40);
}, 300_000);
