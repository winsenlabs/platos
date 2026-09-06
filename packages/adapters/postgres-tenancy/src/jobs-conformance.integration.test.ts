// The differential: `jobs`' two in-memory doubles and this adapter, asked the
// SAME questions, with their answers compared VERBATIM.
//
// The fake runs first and the real store second, and the two observation maps
// are compared key by key so a divergence names the step. Nothing is normalised
// on either side — no date coercion, no id masking, no sorting the comparison
// itself — because the scenario is already written to record only what BOTH
// stores can be asked for. See `jobs-conformance.ts` for the five things that
// are deliberately not among them.
//
// THE FAKES ARE THE CONTEXT'S OWN, imported from the package that declares the
// ports. Doubles this suite wrote would be doubles that agree with this adapter
// because the same person wrote both, which measures nothing.

import { afterAll, beforeAll, expect, test } from "vitest";

import type { TransactionScope } from "@platos/context-jobs/application/ports/index.js";
import {
  ImmediateUnitOfWork,
  InMemoryApprovalsRepository,
  InMemoryJobsRepository,
} from "@platos/context-jobs/application/testing/index.js";

import type { ApprovalPeers, JobsHarness } from "./jobs-harness.js";
import { startJobsHarness } from "./jobs-harness.js";
import type { JobsConformanceIds, JobsObservation } from "./jobs-conformance.js";
import { runJobsConformance } from "./jobs-conformance.js";
import type { JobsStores } from "./jobs-repository.js";

let harness: JobsHarness;
let peers: ApprovalPeers;
let ids: JobsConformanceIds;

beforeAll(async () => {
  harness = await startJobsHarness();
  const scope = await harness.freshScope();
  peers = await harness.seedPeers(scope);
  ids = {
    agentId: peers.agentId,
    threadId: peers.threadId,
    turnId: peers.turnId,
    secondTurnId: peers.secondTurnId,
    jobIds: [
      "cccccccc-0001-4000-8000-000000000001",
      "cccccccc-0001-4000-8000-000000000002",
      "cccccccc-0001-4000-8000-000000000003",
    ],
    approvalRowIds: [
      "cccccccc-0002-4000-8000-000000000001",
      "cccccccc-0002-4000-8000-000000000002",
      "cccccccc-0002-4000-8000-000000000003",
      "cccccccc-0002-4000-8000-000000000004",
    ],
    // A uuid of the right SHAPE that names no row, so every miss is a miss
    // rather than a refusal about the id's spelling.
    absentId: "dddddddd-dddd-4ddd-8ddd-dddddddddddd",
  };
}, 300_000);

afterAll(async () => {
  await harness?.stop();
});

/** The two doubles, assembled under the same names the adapter publishes. */
function fakeStores(): { readonly stores: JobsStores; readonly unitOfWork: ImmediateUnitOfWork } {
  return {
    stores: {
      jobs: new InMemoryJobsRepository(),
      approvals: new InMemoryApprovalsRepository(),
    },
    unitOfWork: new ImmediateUnitOfWork(),
  };
}

test("the fakes and the real store answer the same scenario identically", async () => {
  const scope = peers.scope;

  const fake = fakeStores();
  const fromFake: JobsObservation = await runJobsConformance({
    stores: fake.stores,
    scope,
    ids,
    run: <Value>(work: (transaction: TransactionScope) => Promise<Value>) =>
      fake.unitOfWork.run(work),
  });

  const fromReal: JobsObservation = await runJobsConformance({
    stores: harness.stores,
    scope,
    ids,
    run: <Value>(work: (transaction: TransactionScope) => Promise<Value>) =>
      harness.base.adapter.unitOfWork.run(work),
  });

  // KEY BY KEY, so a divergence names the step rather than dumping two objects.
  expect(Object.keys(fromReal).sort()).toEqual(Object.keys(fromFake).sort());
  for (const step of Object.keys(fromFake)) {
    expect({ step, observed: fromReal[step] }).toEqual({ step, observed: fromFake[step] });
  }

  // The scenario has to have DONE something. A run that recorded nothing would
  // satisfy every assertion above.
  expect(Object.keys(fromFake).length).toBeGreaterThan(45);
}, 300_000);
