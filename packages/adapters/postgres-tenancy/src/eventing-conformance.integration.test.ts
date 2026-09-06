// The conformance differential: ONE scenario, asked of
// `InMemoryNotificationRuleRepository` and of PostgreSQL, with the two
// observation maps compared VERBATIM.
//
// WHY A DIFFERENTIAL AND NOT TWO SUITES. Two independently written suites measure
// two things and agree by coincidence; this measures ONE thing twice. The
// double's own header claims "It is not a stub. It enforces the two invariants
// the real table enforces, and a use case that violates either fails here exactly
// as it would against Postgres" — and every use-case suite in
// `packages/contexts/eventing` is written against that claim. This is where it is
// checked rather than admired.
//
// THE FAKE RUNS FIRST AND ITS MAP IS THE EXPECTATION, which is deliberate: a
// divergence then reads as "PostgreSQL answered X where the double answered Y",
// naming the step, and a suite that had built its expectation from the adapter
// would have made the adapter the specification.
//
// THE IDENTIFIERS ARE REAL UUIDS ON BOTH SIDES. `SequenceIdGenerator` mints
// `id-0001` and `testEnvironmentScope()` mints `org-1`/`proj-1`/`env-1`; all four
// satisfy the double and all four are refused by `@db.Uuid`. Feeding the double
// the shapes the database accepts is what makes a divergence a BEHAVIOUR
// difference rather than a shape one — the shape refusals have their own named
// cases in `eventing-constraints.integration.test.ts`.
//
// EVERY RUN GETS A FRESH TENANT AND FRESH RULE IDS, because the scenario is not
// idempotent: it leaves a disabled rule, a scrubbed one and a foreign one
// standing, and a second run over the same environment would count them. The
// fake starts empty on every construction, so a suite that reused the tenant
// would have compared an empty double against a store carrying the previous
// run's rows — a divergence that says nothing about either.
//
// THE DOUBLE IS DRIVEN THROUGH A REAL UNIT OF WORK, not through a literal. The
// context ships `ImmediateUnitOfWork` beside the double for exactly this, and
// using it rather than inventing a `{ transactionId }` here is what keeps the
// fake half of the differential the fake the CONTEXT wrote rather than one this
// suite wrote to agree with itself.

import { afterAll, beforeAll, expect, test } from "vitest";

import {
  ImmediateUnitOfWork,
  InMemoryNotificationRuleRepository,
} from "@platos/context-eventing/application/testing/index.js";
import type { TransactionScope } from "@platos/context-eventing/application/ports/index.js";

import { runEventingConformance, type EventingConformanceIds } from "./eventing-conformance.js";
import { startEventingHarness, type EventingHarness } from "./eventing-harness.js";

let harness: EventingHarness;

/** Six uuids per run, distinguished by a prefix so a mix-up is legible. */
function idsFor(run: string): EventingConformanceIds {
  const mint = (slot: string): string => `eeeeeeee-${run}-4000-8000-00000000000${slot}`;
  return {
    alphaRuleId: mint("1"),
    betaRuleId: mint("2"),
    siblingRuleId: mint("3"),
    foreignRuleId: mint("4"),
    duplicateRuleId: mint("5"),
    missingRuleId: mint("6"),
  };
}

/** One run of the scenario against PostgreSQL, on a tenant nothing else used. */
async function runAgainstPostgres(run: string): Promise<Record<string, unknown>> {
  const tenant = await harness.freshTenant();
  const foreign = await harness.freshTenant();
  return runEventingConformance({
    repository: harness.repository,
    scope: tenant.scope,
    sibling: tenant.sibling,
    foreign: foreign.scope,
    ids: idsFor(run),
    run: (work) => harness.run(work),
  });
}

/** The same run against the context's own double, over the same tenant shape. */
async function runAgainstDouble(
  run: string,
  scope: Parameters<typeof runEventingConformance>[0]["scope"],
  sibling: Parameters<typeof runEventingConformance>[0]["sibling"],
  foreign: Parameters<typeof runEventingConformance>[0]["foreign"],
): Promise<Record<string, unknown>> {
  const unitOfWork = new ImmediateUnitOfWork();
  return runEventingConformance({
    repository: new InMemoryNotificationRuleRepository(),
    scope,
    sibling,
    foreign,
    ids: idsFor(run),
    run: <Value,>(work: (transaction: TransactionScope) => Promise<Value>) => unitOfWork.run(work),
  });
}

beforeAll(async () => {
  harness = await startEventingHarness();
}, 300_000);

afterAll(async () => {
  await harness?.stop();
});

test("the in-memory double and PostgreSQL answer the SAME scenario identically", async () => {
  const tenant = await harness.freshTenant();
  const foreign = await harness.freshTenant();
  const expected = await runAgainstDouble("0001", tenant.scope, tenant.sibling, foreign.scope);
  const actual = await runEventingConformance({
    repository: harness.repository,
    scope: tenant.scope,
    sibling: tenant.sibling,
    foreign: foreign.scope,
    ids: idsFor("0001"),
    run: (work) => harness.run(work),
  });

  // Step by step first, so a failure names the step rather than printing two
  // maps of thirty entries and leaving a reader to diff them.
  for (const step of Object.keys(expected)) {
    expect({ step, observed: actual[step] }).toEqual({ step, observed: expected[step] });
  }
  // And then whole, which is what catches a step one side produced and the other
  // did not — a per-key loop over the fake's keys cannot see an extra key on the
  // adapter's side.
  expect(actual).toEqual(expected);
}, 600_000);

test("the scenario is not vacuous: every method of the port changed an answer", async () => {
  // A differential that agreed because neither side did anything would pass the
  // case above. This is the control for it, and it is asserted against the REAL
  // store rather than the double so that a scenario which silently stopped
  // reaching PostgreSQL could not satisfy it.
  const observed = await runAgainstPostgres("0002");

  expect(observed.emptyBefore).toEqual([]);
  expect(observed.insertDuplicateName).toEqual({ error: "EVENTING_RULE_NAME_TAKEN" });
  expect(observed.updateOntoTakenName).toEqual({ error: "EVENTING_RULE_NAME_TAKEN" });
  expect(observed.findAlphaInSibling).toBeNull();
  expect(observed.findAlphaInForeign).toBeNull();
  expect(observed.findMissing).toBeNull();
  expect(observed.deleteInWrongScope).toBe(false);
  expect(observed.deleteAlpha).toBe(true);
  expect(observed.deleteAlphaAgain).toBe(false);
  expect(observed.countAtEnvironment).toBe(2);
  expect(observed.countAtProject).toBe(3);
  expect(observed.countAtOrganization).toBe(3);
  expect(observed.countBystander).toBe(0);
  expect(observed.countVacuousSubject).toBe(0);
  expect(observed.anonymizeVacuousSubject).toBe(0);
  expect(observed.anonymizeAtOrganization).toBe(2);
  expect(observed.countAfterErasure).toBe(0);
  expect((observed.listNewestFirst as readonly unknown[]).length).toBe(2);
  expect((observed.listEnabled as readonly unknown[]).length).toBe(1);
}, 600_000);

test("the erasure does NOT move `updatedAt`, and the scrub stops at the organization", async () => {
  // The claim `eventing-erasure.ts` is written in raw SQL for. It is asserted
  // HERE as well as inside the differential because the differential would go
  // green if BOTH stores moved the column — the map would still match. The
  // instants below are the fixture's own literals, which no `@updatedAt` stamp
  // can have produced.
  const observed = await runAgainstPostgres("0003");

  const scrubbed = observed.listAfterErasure as readonly Record<string, unknown>[];
  expect(scrubbed).toHaveLength(1);
  expect(scrubbed[0]?.createdBy).toBe("erased:subject-removed");
  // `beta` was edited at EPOCH + 120s and never again.
  expect(scrubbed[0]?.updatedAt).toBe("2026-06-01T09:02:00.000Z");
  expect(scrubbed[0]?.createdAt).toBe("2026-06-01T09:01:00.000Z");

  // The sibling environment is INSIDE the erased organization and is scrubbed.
  const sibling = observed.listSiblingAfterErasure as readonly Record<string, unknown>[];
  expect(sibling).toHaveLength(1);
  expect(sibling[0]?.createdBy).toBe("erased:subject-removed");
  expect(sibling[0]?.updatedAt).toBe("2026-06-01T09:00:30.000Z");

  // The foreign organization is OUTSIDE it and is untouched. Without this the
  // organization clause of the containment join is unfalsifiable: a statement
  // with no organization predicate at all would scrub every row in the table and
  // every other assertion here would still pass.
  const foreign = observed.listForeignAfterErasure as readonly Record<string, unknown>[];
  expect(foreign).toHaveLength(1);
  expect(foreign[0]?.createdBy).toBe("operator-a");
}, 600_000);
