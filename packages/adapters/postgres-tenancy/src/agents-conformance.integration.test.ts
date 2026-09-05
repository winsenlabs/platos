// The differential: ONE scenario, two stores, observations compared verbatim.
//
// `InMemoryAgentsRepository` and `InMemoryScaffolding` are the contract fixtures
// this context publishes, and their headers claim they enforce what the store
// enforces. This suite is where that claim is checked against a real PostgreSQL
// rather than restated.
//
// A DIVERGENCE IS REPORTED AS A NAMED STEP, not as a diff of two large objects.
// The comparison walks the two observation lists in order and fails on the first
// step whose values differ, naming it — because "the adapter behaves differently
// somehow" is not a finding anybody can act on.
//
// Excluded from `vitest run` by the package's own `test` script and run by
// `pnpm test:postgres-tenancy:integration` in the `postgres-tenancy-repository`
// CI job, because the typecheck job has no Docker daemon.

import { afterAll, beforeAll, describe, expect, test } from "vitest";

import {
  InMemoryAgentsRepository,
  InMemoryScaffolding,
  ImmediateUnitOfWork,
} from "@platos/context-agents/application/index.js";
import { DEFAULT_AGENTS_POLICY } from "@platos/context-agents/application/ports/index.js";

import {
  runAgentsScenario,
  type AgentsScenarioIds,
  type Observation,
} from "./agents-conformance.js";
import {
  runScaffoldingScenario,
  type ScaffoldingScenarioIds,
} from "./agents-conformance-scaffolding.js";
import {
  FIRST_SKILL,
  HOME_ENVIRONMENT,
  PEER_ENVIRONMENT,
  scopeOf,
  SECOND_SKILL,
  startAgentsHarness,
  type AgentsHarness,
} from "./agents-harness.js";

let harness: AgentsHarness;

const HOME = scopeOf(HOME_ENVIRONMENT);
const PEER = scopeOf(PEER_ENVIRONMENT);
const DEFAULTS = DEFAULT_AGENTS_POLICY.defaults;

/** Fixed uuids, so the two stores are handed the SAME identifiers. */
const IDS: AgentsScenarioIds = {
  firstAgent: "cc000000-0000-4000-8000-000000000001",
  firstVersion: "cc000000-0000-4000-8000-000000000002",
  firstBinding: "cc000000-0000-4000-8000-000000000003",
  secondVersion: "cc000000-0000-4000-8000-000000000004",
  secondAgent: "cc000000-0000-4000-8000-000000000005",
  secondAgentVersion: "cc000000-0000-4000-8000-000000000006",
  secondAgentBinding: "cc000000-0000-4000-8000-000000000007",
  cluster: "cc000000-0000-4000-8000-000000000008",
  clashingAgent: "cc000000-0000-4000-8000-000000000009",
  clashingVersion: "cc000000-0000-4000-8000-00000000000a",
  clashingCluster: "cc000000-0000-4000-8000-00000000000b",
};

const SCAFFOLDING_IDS: ScaffoldingScenarioIds = {
  ownMacro: "cd000000-0000-4000-8000-000000000001",
  sharedMacro: "cd000000-0000-4000-8000-000000000002",
  privateMacro: "cd000000-0000-4000-8000-000000000003",
  peerMacro: "cd000000-0000-4000-8000-000000000004",
  clashingMacro: "cd000000-0000-4000-8000-000000000005",
  defaultTemplate: "cd000000-0000-4000-8000-000000000006",
  plainTemplate: "cd000000-0000-4000-8000-000000000007",
  clashingTemplate: "cd000000-0000-4000-8000-000000000008",
};

beforeAll(async () => {
  harness = await startAgentsHarness();
}, 300_000);

afterAll(async () => {
  await harness?.stop();
});

/**
 * The steps where the two stores are KNOWN to disagree, and what the database
 * answers instead.
 *
 * A divergence deleted from the scenario is a divergence hidden, so each one is
 * kept as a step and pinned from BOTH sides: the double must still accept, and
 * PostgreSQL must still refuse with this exact reason. A double that later grew
 * the missing index breaks this pin rather than silently passing, and so does a
 * store that stopped refusing.
 *
 * Both entries are the same defect in the double: `InMemoryScaffolding` carries
 * no unique index at all, while `Macro` is unique on `[environmentId, name]` and
 * `PostmanTemplate` on `[environmentId, agentId, name]`. A use case that writes a
 * second macro under a name already taken therefore passes every suite in the
 * tree and is refused in production.
 */
const KNOWN_DIVERGENCES = new Map<string, string>([
  ["insertMacro with a name already taken in this environment", "macro_name_taken"],
  ["insertTemplate with a name already taken for this agent", "template_name_taken"],
]);

function compare(fake: readonly Observation[], real: readonly Observation[]): void {
  expect(real.map((observation) => observation.step)).toEqual(
    fake.map((observation) => observation.step),
  );
  let divergences = 0;
  for (const [index, expected] of fake.entries()) {
    const actual = real[index]!;
    const known = KNOWN_DIVERGENCES.get(expected.step);
    if (known !== undefined) {
      divergences += 1;
      expect(expected.value, `the double no longer accepts "${expected.step}"`).toMatchObject({
        ok: true,
      });
      expect(actual.value, `PostgreSQL no longer refuses "${expected.step}"`).toMatchObject({
        ok: false,
        code: "AGENTS_REPOSITORY_UNAVAILABLE",
        details: { reason: known },
      });
      continue;
    }
    expect(
      { step: actual.step, value: actual.value },
      `step ${index + 1} "${expected.step}" diverged`,
    ).toEqual({ step: expected.step, value: expected.value });
  }
  expect(real.length).toBe(fake.length);
  expect(real.length).toBeGreaterThan(0);
  // Every declared divergence must have been REACHED. A step renamed out of the
  // scenario would otherwise leave a pin that can never fail.
  const declared = [...KNOWN_DIVERGENCES.keys()].filter((step) =>
    fake.some((observation) => observation.step === step),
  ).length;
  expect(divergences).toBe(declared);
}

describe("AgentsRepository conformance", () => {
  test("the double and PostgreSQL answer the same scenario identically", async () => {
    const fakeRepository = new InMemoryAgentsRepository();
    const fake = await runAgentsScenario(
      {
        repository: fakeRepository,
        unitOfWork: new ImmediateUnitOfWork(),
        firstSkill: FIRST_SKILL,
        secondSkill: SECOND_SKILL,
      },
      IDS,
      { home: HOME, peer: PEER },
      DEFAULTS,
    );
    const real = await runAgentsScenario(
      {
        repository: harness.repository,
        unitOfWork: harness.adapter.unitOfWork,
        firstSkill: FIRST_SKILL,
        secondSkill: SECOND_SKILL,
      },
      IDS,
      { home: HOME, peer: PEER },
      DEFAULTS,
    );
    compare(fake, real);
  }, 300_000);
});

describe("ScaffoldingRepository conformance", () => {
  test("the double and PostgreSQL answer the same scenario identically", async () => {
    // The templates need an agent that already exists in the home scope, and
    // PostgreSQL will not take a template for one that does not —
    // `PostmanTemplate_ancestry` refuses it. The double takes anything, which is
    // exactly why the agent is seeded through the port on both sides.
    const seeded = await harness.seedAgent({ slug: "scaffolding-host" });
    const fakeScaffolding = new InMemoryScaffolding();
    const fake = await runScaffoldingScenario(
      {
        scaffolding: fakeScaffolding,
        unitOfWork: new ImmediateUnitOfWork(),
        agentId: seeded.agent.agentId,
      },
      SCAFFOLDING_IDS,
      { home: HOME, peer: PEER },
    );
    const real = await runScaffoldingScenario(
      {
        scaffolding: harness.scaffolding,
        unitOfWork: harness.adapter.unitOfWork,
        agentId: seeded.agent.agentId,
      },
      SCAFFOLDING_IDS,
      { home: HOME, peer: PEER },
    );
    compare(fake, real);
  }, 300_000);
});
