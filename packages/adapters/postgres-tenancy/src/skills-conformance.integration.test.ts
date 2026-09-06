// The conformance differential: ONE scenario, asked of `InMemorySkillsRepository`
// and of PostgreSQL, with the two observation maps compared VERBATIM.
//
// WHY A DIFFERENTIAL AND NOT TWO SUITES. Two independently written suites measure
// two things and agree by coincidence; this measures ONE thing twice. The double's
// own header claims it "is a REAL implementation of the port's contract" that
// "enforces the two properties a Postgres implementation would enforce with
// constraints" — and every use-case suite in `packages/contexts/skills` is written
// against it. This is where that claim is checked rather than admired.
//
// THE FAKE RUNS FIRST AND ITS MAP IS THE EXPECTATION, which is deliberate: a
// divergence then reads as "PostgreSQL answered X where the double answered Y",
// naming the step, and a suite that had built its expectation from the adapter
// would have made the adapter the specification.
//
// THE IDENTIFIERS ARE REAL UUIDS ON BOTH SIDES. `SequenceIdGenerator` mints
// `id-0001` and `scopeFor` mints `org-1`; both satisfy the double and both are
// refused by `@db.Uuid`. Feeding the double the shapes the database accepts is
// what makes a divergence a BEHAVIOUR difference rather than a shape one — the
// shape refusals have their own named cases in the constraints suite.

import { afterAll, beforeAll, expect, test } from "vitest";

import { InMemorySkillsRepository } from "@platos/context-skills/application/index.js";
import type {
  CatalogueScope,
  EnvironmentSkillId,
  ProjectSkillId,
  SkillId,
  TransactionScope,
} from "@platos/context-skills/application/ports/index.js";
import { asIdentifier, catalogueScope } from "@platos/context-skills/application/ports/index.js";

import {
  runSkillsConformance,
  type SkillsConformanceEnvironment,
  type SkillsConformanceIds,
  type SkillsObservation,
} from "./skills-conformance.js";
import { startSkillsHarness, type SkillsHarness, type SkillsTenant } from "./skills-harness.js";

let harness: SkillsHarness;
let tenant: SkillsTenant;
let foreign: SkillsTenant;

const IDS: SkillsConformanceIds = {
  missingSkillId: "cccccccc-0001-4000-8000-000000000001",
  missingEnvironmentSkillId: "cccccccc-0002-4000-8000-000000000001",
  foreignOrganizationId: "cccccccc-0003-4000-8000-000000000001",
};

beforeAll(async () => {
  harness = await startSkillsHarness();
  tenant = await harness.freshTenant();
  foreign = await harness.freshTenant();
}, 300_000);

afterAll(async () => {
  await harness?.stop();
});

/**
 * A uuid source the double can use, shaped exactly like the ones the column
 * accepts.
 *
 * The prefix distinguishes the three tables so a mixed-up id is visible in a
 * failure message rather than looking like any other uuid, and the counter is
 * shared so no two rows can collide.
 */
function uuidStamps() {
  let counter = 0;
  let tick = Date.parse("2026-05-01T09:00:00.000Z");
  const mint = (kind: string): string => {
    counter += 1;
    return `dddddddd-${kind}-4000-8000-${String(counter).padStart(12, "0")}`;
  };
  return {
    now: (): Date => {
      tick += 1;
      return new Date(tick);
    },
    skillId: (): SkillId => asIdentifier<SkillId>(mint("0001")),
    projectSkillId: (): ProjectSkillId => asIdentifier<ProjectSkillId>(mint("0002")),
    environmentSkillId: (): EnvironmentSkillId => asIdentifier<EnvironmentSkillId>(mint("0003")),
  };
}

function scopeOf(organizationId: string, projectId: string, environmentId: string): CatalogueScope {
  return catalogueScope({
    level: "environment",
    organizationId: asIdentifier(organizationId),
    projectId: asIdentifier(projectId),
    environmentId: asIdentifier(environmentId),
  });
}

async function runAgainstDouble(): Promise<SkillsObservation> {
  const repository = new InMemorySkillsRepository(uuidStamps());
  let counter = 0;
  const environment: SkillsConformanceEnvironment = {
    repository,
    scope: scopeOf(tenant.organizationId, tenant.projectId, tenant.environmentId),
    staging: scopeOf(tenant.organizationId, tenant.projectId, tenant.stagingEnvironmentId),
    foreign: scopeOf(foreign.organizationId, foreign.projectId, foreign.environmentId),
    ids: IDS,
    async run<Value>(work: (transaction: TransactionScope) => Promise<Value>): Promise<Value> {
      counter += 1;
      // The double takes a scope and ignores it, which is right for a map — but
      // it must still be a DISTINCT scope per call, or a store that keyed
      // anything on the token would be measured against one that never varies.
      return work({ transactionId: asIdentifier(`fake-txn-${counter}`) });
    },
  };
  return runSkillsConformance(environment);
}

async function runAgainstPostgres(): Promise<SkillsObservation> {
  const environment: SkillsConformanceEnvironment = {
    repository: harness.repository,
    scope: tenant.scope,
    staging: tenant.staging,
    foreign: foreign.scope,
    ids: IDS,
    run: (work) => harness.run(work),
  };
  return runSkillsConformance(environment);
}

test("the in-memory double and PostgreSQL answer the same scenario identically", async () => {
  const fake = await runAgainstDouble();
  const real = await runAgainstPostgres();

  // NON-VACUITY FIRST. A scenario that stopped calling the port would compare two
  // empty maps and pass, which is the failure mode a differential is most
  // exposed to; the key sets are asserted equal so a step recorded on one side
  // and not on the other is a failure rather than a silent narrowing.
  expect(Object.keys(fake).length).toBeGreaterThan(40);
  expect(Object.keys(real).sort()).toEqual(Object.keys(fake).sort());

  // Step by step, so a divergence names the call rather than dumping two maps.
  for (const step of Object.keys(fake)) {
    expect({ step, observed: real[step] }).toEqual({ step, observed: fake[step] });
  }
  expect(real).toEqual(fake);
}, 300_000);

test("the differential can SEE a divergence — the negative control", async () => {
  // Without this the case above would pass against a comparison that compared
  // nothing. One deliberately wrong answer, injected into a copy of the fake's
  // own map, must fail the same comparison the real run is held to.
  const fake = await runAgainstDouble();
  const tampered: SkillsObservation = { ...fake, "listVisibleSkills.beforeInstall": { ok: true, value: ["forged"] } };
  expect(tampered).not.toEqual(fake);
}, 300_000);
