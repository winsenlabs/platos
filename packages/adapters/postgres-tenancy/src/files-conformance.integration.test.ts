// The conformance differential: ONE scenario, asked of `InMemoryFilesRepository`
// and of PostgreSQL, with the two observation maps compared VERBATIM.
//
// THE FAKE RUNS FIRST AND ITS MAP IS THE EXPECTATION, which is deliberate: a
// divergence then reads as "PostgreSQL answered X where the double answered Y",
// naming the step, and a suite that had built its expectation from the adapter
// would have made the adapter the specification.
//
// BOTH SIDES ARE HANDED THE SAME TENANT. The chain is seeded once, through the
// tenancy port and the ORM's own CLI, and the double is addressed with the same
// three ids the database resolved — so a divergence cannot be a fixture
// difference. The double never sees the database and the database never sees the
// double.

import { afterAll, beforeAll, expect, test } from "vitest";

import { InMemoryFilesRepository } from "@platos/context-files/application/testing/index.js";
import type {
  OrganizationScope,
  TransactionScope,
  TurnId,
} from "@platos/context-files/application/ports/index.js";
import { asIdentifier } from "@platos/context-files/application/ports/index.js";

import {
  runFilesConformance,
  type FilesConformanceChain,
  type FilesConformanceEnvironment,
  type FilesConformanceIds,
  type FilesObservation,
} from "./files-conformance.js";
import { startFilesHarness, type FilesChain, type FilesHarness } from "./files-harness.js";

let harness: FilesHarness;
let tenant: FilesChain;
let foreign: FilesChain;

const IDS: FilesConformanceIds = {
  missingAttachmentId: "cccccccc-0001-4000-8000-000000000001",
};

beforeAll(async () => {
  harness = await startFilesHarness();
  tenant = await harness.freshChain();
  foreign = await harness.freshChain();
}, 300_000);

afterAll(async () => {
  await harness?.stop();
});

function conformanceChain(chain: FilesChain): FilesConformanceChain {
  const organization: OrganizationScope = {
    level: "organization",
    organizationId: asIdentifier(chain.organizationId),
  };
  return {
    organization,
    environment: chain.environment,
    thread: chain.thread,
    attachment: chain.attachment,
    turnId: asIdentifier<TurnId>(chain.turnId),
    secondTurnId: asIdentifier<TurnId>(chain.secondTurnId),
  };
}

async function runAgainstDouble(): Promise<FilesObservation> {
  const repository = new InMemoryFilesRepository();
  let counter = 0;
  const environment: FilesConformanceEnvironment = {
    repository,
    chain: conformanceChain(tenant),
    foreign: conformanceChain(foreign),
    ids: IDS,
    async run<Value>(work: (transaction: TransactionScope) => Promise<Value>): Promise<Value> {
      counter += 1;
      // The double takes a scope and ignores it, which is right for a map — but
      // it must still be a DISTINCT scope per call, or a store that keyed
      // anything on the token would be measured against one that never varies.
      return work({ transactionId: asIdentifier(`fake-txn-${String(counter)}`) });
    },
  };
  return runFilesConformance(environment);
}

async function runAgainstPostgres(): Promise<FilesObservation> {
  const environment: FilesConformanceEnvironment = {
    repository: harness.repository,
    chain: conformanceChain(tenant),
    foreign: conformanceChain(foreign),
    ids: IDS,
    run: (work) => harness.run(work),
  };
  return runFilesConformance(environment);
}

test("the in-memory double and PostgreSQL answer the same scenario identically", async () => {
  const fake = await runAgainstDouble();
  const real = await runAgainstPostgres();

  // NON-VACUITY FIRST. A scenario that stopped calling the port would compare two
  // empty maps and pass, which is the failure mode a differential is most exposed
  // to; the key sets are asserted equal so a step recorded on one side and not on
  // the other is a failure rather than a silent narrowing.
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
  const tampered: FilesObservation = {
    ...fake,
    "sumAttachmentBytes.here": { ok: true, value: -1 },
  };
  expect(tampered).not.toEqual(fake);
}, 300_000);
