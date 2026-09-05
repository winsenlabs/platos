// The `cost-monitoring` conformance differential: `InMemoryBudgetRepository` and
// this adapter, asked the SAME questions against a REAL PostgreSQL, compared
// verbatim.
//
// WHY THE COMPARISON IS THE TEST. A suite written against the adapter alone
// asserts what its author believed; a suite written against the fake alone
// asserts nothing about the database. Running one scenario twice and comparing
// the observation maps makes a divergence a named step with a value on each
// side.
//
// IT HAS ALREADY EARNED THAT ON THIS TRANCHE. The first run of this scenario
// against a real database is what established that a duplicate crossing raised
// through the unique index cannot be reported as `ok(null)` and left recoverable
// — PostgreSQL aborts the whole transaction — and the three inserts were rebuilt
// on `ON CONFLICT DO NOTHING` because of it. The double could not have shown
// that: a map has no transaction to poison.
//
// Excluded from `vitest run` by the package's `test` script and run by
// `pnpm test:postgres-tenancy:integration` in its own CI job. It FAILS when
// Docker is absent rather than skipping.

import { afterAll, beforeAll, describe, expect, test } from "vitest";

import {
  ImmediateUnitOfWork,
  InMemoryBudgetRepository,
} from "@platos/context-cost-monitoring/application/testing/index.js";
import type {
  BudgetRepository,
  EnvironmentScope,
  TransactionScope,
} from "@platos/context-cost-monitoring/application/ports/index.js";

import type { CostConformanceEnvironment, CostConformanceIds, CostObservation } from "./cost-conformance.js";
import { runCostConformance } from "./cost-conformance.js";
import type { CostHarness } from "./cost-harness.js";
import { startCostHarness } from "./cost-harness.js";

let harness: CostHarness;
let scope: EnvironmentScope;
let ids: CostConformanceIds;

/** A uuid per role, so no two rows in the scenario can collide on a key. */
function uuid(slot: string): string {
  return `cc000000-${slot}-4000-8000-000000000000`;
}

beforeAll(async () => {
  harness = await startCostHarness();
  scope = await harness.freshScope();
  ids = {
    scopeCapId: uuid("0001"),
    agentCapId: uuid("0002"),
    userCapId: uuid("0003"),
    missingCapId: uuid("0004"),
    firstCrossingId: uuid("0005"),
    duplicateCrossingId: uuid("0006"),
    secondCrossingId: uuid("0007"),
    missingCrossingId: uuid("0008"),
    emailChannelId: uuid("0009"),
    slackChannelId: uuid("000a"),
    clashingChannelId: uuid("000b"),
    missingChannelId: uuid("000c"),
    // The ONE identifier the scenario cannot invent: `AlertChannelConfiguration
    // .credentialId` is a foreign key into `Credential`, and a database rule
    // demands the row be a live `CHANNEL_SECRET` with an active secret version.
    credentialId: await harness.seedCredential(scope),
    firstDeliveryId: uuid("000d"),
    secondDeliveryId: uuid("000e"),
    thirdDeliveryId: uuid("000f"),
    probeDeliveryId: uuid("0010"),
    missingDeliveryId: uuid("0011"),
    claimToken: uuid("0012"),
    staleToken: uuid("0013"),
  };
}, 300_000);

afterAll(async () => {
  await harness?.stop();
});

function fakeEnvironment(): CostConformanceEnvironment {
  const repository = new InMemoryBudgetRepository();
  const unitOfWork = new ImmediateUnitOfWork([repository]);
  return {
    repository,
    scope,
    ids,
    run: <Value>(work: (transaction: TransactionScope) => Promise<Value>) => unitOfWork.run(work),
    knowScope: () => repository.knowScope(scope),
  };
}

function adapterEnvironment(): CostConformanceEnvironment {
  const repository = harness.repository as BudgetRepository;
  return {
    repository,
    scope,
    ids,
    run: <Value>(work: (transaction: TransactionScope) => Promise<Value>) =>
      harness.base.adapter.unitOfWork.run(work),
    // A NO-OP against the real store. `listPendingCrossings` re-derives the
    // organization and the project by joining the tenant chain, which is what
    // the port requires of it and what a map cannot do.
    knowScope: () => undefined,
  };
}

describe("the PostgreSQL cost-monitoring store against the in-memory double", () => {
  let fake: CostObservation;
  let real: CostObservation;

  beforeAll(async () => {
    fake = await runCostConformance(fakeEnvironment());
    real = await runCostConformance(adapterEnvironment());
  }, 300_000);

  test("both stores answered every step of the scenario", () => {
    expect(Object.keys(real)).toEqual(Object.keys(fake));
    expect(Object.keys(real).length).toBeGreaterThan(40);
  });

  test("the steps that could agree by being empty did not", () => {
    // NON-VACUITY, asserted rather than assumed. Two stores that both returned
    // nothing would match transcript for transcript and prove nothing at all,
    // and the four steps below are the ones where "nothing" is a legal answer:
    // a listing, a page, a fan-out count and the installation-wide sweep.
    expect(real.listBudgetsOrdered).toEqual({ ok: true, value: expect.any(Array) });
    expect((real.listBudgetsOrdered as { readonly value: readonly unknown[] }).value).toHaveLength(3);
    expect(real.firstPage).toMatchObject({ ok: true, value: { total: 3 } });
    expect(real.fanOut).toEqual({ ok: true, value: 2 });
    expect(real.refanOut).toEqual({ ok: true, value: 1 });
    const before = (real.pendingCrossingsBefore as { readonly value: readonly unknown[] }).value;
    const after = (real.pendingCrossingsAfter as { readonly value: readonly unknown[] }).value;
    // ONE row per CROSSING, not one per delivery: two crossings are outstanding
    // before anything is claimed, and four deliveries exist across them.
    expect(before).toHaveLength(2);
    expect(after).toHaveLength(1);
    expect(real.deliveriesForCrossing).toMatchObject({ ok: true });
    expect(
      (real.deliveriesForCrossing as { readonly value: readonly unknown[] }).value,
    ).toHaveLength(2);
  });

  test("the sweep RE-DERIVED the tenant chain rather than being told it", () => {
    // The port requires it: this sweep runs installation-wide and has no request
    // scope, so the organization and the project can only come from a join.
    const [outstanding] = (
      real.pendingCrossingsAfter as { readonly value: readonly { readonly scope: unknown }[] }
    ).value;
    expect(outstanding?.scope).toEqual(scope);
  });

  test("their transcripts match, observation for observation", () => {
    // ONE assertion over the whole map rather than one per step: a divergence
    // then names the step AND shows both values, and a step somebody forgot to
    // assert cannot exist.
    expect(real).toEqual(fake);
  });

  test("the claim was a real lease, not a flag", () => {
    // Read off the SHARED transcript, so this is a claim about both stores.
    const claimed = real.claimFirst as { readonly ok: boolean; readonly value: unknown };
    expect(claimed.ok).toBe(true);
    expect(claimed.value).toMatchObject({ status: "PROCESSING", claimGeneration: 1, retryCount: 1 });
    expect(real.claimFirstAgain).toEqual({ ok: true, value: null });
    expect(real.finaliseStale).toEqual({ ok: true, value: null });
    // And the row is still claimable once the lease has expired, with a SECOND
    // generation — the property that recovers a delivery whose dispatcher died.
    const recovered = real.claimSecondAfterLease as { readonly value: unknown };
    expect(recovered.value).toMatchObject({ claimGeneration: 2, retryCount: 2 });
  });
});
