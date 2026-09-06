// The differential: `governance`'s five in-memory doubles and this adapter,
// asked the SAME questions, with their answers compared VERBATIM.
//
// The fake runs first and the real store second, and the two observation maps
// are compared key by key so a divergence names the step. Nothing is normalised
// on either side — no date coercion, no id masking, no sorting the comparison
// itself — because the scenario is already written to record only what BOTH
// stores can be asked for. See `governance-conformance.ts` for why an id and an
// instant are not among those things.
//
// THE FAKE IS THE CONTEXT'S OWN, imported from the package that declares the
// ports. A double this suite wrote would be a double that agrees with this
// adapter because the same person wrote both, which measures nothing.

import { afterAll, beforeAll, expect, test } from "vitest";

import type { EnvironmentScope, TransactionScope } from "@platos/context-governance/application/ports/index.js";
import {
  InMemoryCriteriaRepository,
  InMemoryEvalsRepository,
  InMemoryGoldenSetsRepository,
  InMemoryRatingsRepository,
  InMemorySafetyLedger,
  InMemoryUnitOfWork,
} from "@platos/context-governance/application/testing/index.js";
import { runResult } from "@platos/context-governance/application/ports/index.js";
import type { NotResult } from "@platos/context-governance/application/ports/index.js";

import type { GovernanceHarness, PeerChain } from "./governance-harness.js";
import { startGovernanceHarness } from "./governance-harness.js";
import type {
  GovernanceConformanceIds,
  GovernanceObservation,
} from "./governance-conformance.js";
import { governanceConformanceClock, runGovernanceConformance } from "./governance-conformance.js";
import type { GovernanceStores } from "./governance-repository.js";

let harness: GovernanceHarness;
let chain: PeerChain;
let ids: GovernanceConformanceIds;

beforeAll(async () => {
  harness = await startGovernanceHarness();
  const scope = await harness.freshScope();
  chain = await harness.seedChain(scope);
  ids = {
    agentId: chain.agentId,
    agentVersionId: chain.agentVersionId,
    secondAgentVersionId: chain.secondAgentVersionId,
    endUserId: chain.endUserId,
    threadId: chain.threadId,
    turnId: chain.turnId,
    secondTurnId: chain.secondTurnId,
    // A uuid of the right SHAPE that names no row, so every `findById` miss is
    // a miss rather than a refusal about the id's spelling.
    absentId: "dddddddd-dddd-4ddd-8ddd-dddddddddddd",
  };
}, 300_000);

afterAll(async () => {
  await harness?.stop();
});

/** The five doubles, assembled under the same names the adapter publishes. */
function fakeStores(now: () => Date): {
  readonly stores: GovernanceStores;
  readonly unitOfWork: InMemoryUnitOfWork;
} {
  const criteria = new InMemoryCriteriaRepository(now);
  const evals = new InMemoryEvalsRepository(now);
  // The schema's `onDelete: Cascade` from `EvalCriterion` to `AgentEval`, wired
  // exactly as `buildGovernanceTestContext` wires it. Without it the double
  // would certify that a measurement outlives the question it was taken against.
  criteria.cascadeInto(evals);
  return {
    stores: {
      safety: new InMemorySafetyLedger(now),
      ratings: new InMemoryRatingsRepository(now),
      criteria,
      evals,
      goldenSets: new InMemoryGoldenSetsRepository(now),
    },
    unitOfWork: new InMemoryUnitOfWork(),
  };
}

test("the fake and the real store answer the same scenario identically", async () => {
  const scope: EnvironmentScope = chain.scope;

  const fake = fakeStores(governanceConformanceClock());
  const fromFake: GovernanceObservation = await runGovernanceConformance({
    stores: fake.stores,
    scope,
    ids,
    run: <Value>(work: (transaction: TransactionScope) => Promise<Value>) =>
      fake.unitOfWork.run(work),
  });

  const fromReal: GovernanceObservation = await runGovernanceConformance({
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
