// The differential: `observability`'s in-memory double and this adapter, asked
// the SAME questions, with their answers compared VERBATIM.
//
// The fake runs first and the real store second, and the two observation maps
// are compared key by key so a divergence names the step. Nothing is normalised
// on either side — no date coercion, no id masking, no sorting the comparison
// itself — because every id and every instant in this scenario is the CALLER's:
// `recordAdminAudit` takes a whole record, so neither store mints anything.
//
// THE FAKE IS THE CONTEXT'S OWN, imported from the package that declares the
// port. A double this suite wrote would be a double that agrees with this
// adapter because the same person wrote both, which measures nothing.

import { afterAll, beforeAll, expect, test } from "vitest";

import type { TransactionScope } from "@platos/context-observability/application/ports/index.js";
import {
  ImmediateUnitOfWork,
  InMemoryObservabilityRepository,
} from "@platos/context-observability/application/testing/index.js";
import { runResult } from "@platos/kernel";
import type { NotResult } from "@platos/kernel";

import type { AuditScope, ObservabilityHarness } from "./observability-harness.js";
import { startObservabilityHarness } from "./observability-harness.js";
import type {
  ObservabilityConformanceIds,
  ObservabilityObservation,
} from "./observability-conformance.js";
import { runObservabilityConformance } from "./observability-conformance.js";

let harness: ObservabilityHarness;
let home: AuditScope;
let foreign: AuditScope;
let ids: ObservabilityConformanceIds;

beforeAll(async () => {
  harness = await startObservabilityHarness();
  home = await harness.freshScope();
  // A WHOLE SECOND TENANT. `AdminAudit` carries no ancestry rule, so the
  // containment every read depends on is this adapter's WHERE clause; a scenario
  // with one organization could not tell a correct predicate from a missing one.
  foreign = await harness.freshScope();
  ids = {
    first: harness.base.freshId("0031"),
    second: harness.base.freshId("0032"),
    third: harness.base.freshId("0033"),
    foreign: harness.base.freshId("0034"),
  };
}, 300_000);

afterAll(async () => {
  await harness?.stop();
});

test("the fake and the real store answer the same scenario identically", async () => {
  const fake = new InMemoryObservabilityRepository();
  const fakeUnitOfWork = new ImmediateUnitOfWork();
  const fromFake: ObservabilityObservation = await runObservabilityConformance({
    repository: fake,
    scope: home.scope,
    foreignScope: foreign.scope,
    ids,
    run: <Value>(work: (transaction: TransactionScope) => Promise<Value>) =>
      fakeUnitOfWork.run(work),
  });

  const fromReal: ObservabilityObservation = await runObservabilityConformance({
    repository: harness.stores.observability,
    scope: home.scope,
    foreignScope: foreign.scope,
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
  expect(Object.keys(fromFake).length).toBeGreaterThan(15);
}, 300_000);
