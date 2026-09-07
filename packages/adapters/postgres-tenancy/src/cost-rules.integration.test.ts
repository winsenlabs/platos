// The rules the DATABASE holds that no port method restates, and the two places
// this adapter is deliberately stricter than the double it is measured against.
//
// NOTHING HERE HAS A GUARD IN `cost-guards.ts`, and that is the point. A guard
// restates a constraint so a refusal has a name; these are constraints a caller
// cannot violate by supplying a bad VALUE — they are violated by supplying a
// value that is fine on its own and wrong against a row somewhere else, or by
// asking for a change the table simply will not make. They are recorded because
// an implementer who did not know about them would write a plausible method that
// fails only in production:
//
//   `Budget_ancestry` fires on INSERT **and ON UPDATE**, and it re-checks the
//   agent against the environment's project every time. A cap whose agent was
//   valid when it was written is re-judged whenever its ceiling is raised.
//
//   `BudgetThresholdEvent` and the send-record table are IMMUTABLE — three
//   rules apiece reject UPDATE, DELETE and TRUNCATE, and all three are revoked
//   from PUBLIC. There is no correction path for either.
//
//   `AlertChannel_owner_immutable` freezes `environmentId` and `type`. The
//   domain already refuses a kind change in its patch type; the table refuses
//   it whatever the type says.
//
//   `enforce_win124_credential_kind` demands a live `CHANNEL_SECRET` with an
//   ACTIVE secret version. A configuration naming a revoked credential, one of
//   the wrong kind, or one whose secret was never stored is refused — and the
//   column's own foreign key does not check any of that.
//
//   `AlertChannel.deletedAt` can be READ and cannot be WRITTEN through this
//   port, which is a gap in `BudgetRepository` rather than in this adapter.

import { afterAll, beforeAll, describe, expect, test } from "vitest";

import type {
  AgentId,
  AlertChannel,
  CredentialRef,
  EnvironmentScope,
  ThresholdEventId,
} from "@platos/context-cost-monitoring/application/ports/index.js";
import { asCostIdentifier } from "@platos/context-cost-monitoring/application/ports/index.js";
import { runResult } from "@platos/context-cost-monitoring/application/ports/index.js";

import { AT, LATER, conformanceBudget, conformanceChannel } from "./cost-conformance.js";
import type { CostHarness } from "./cost-harness.js";
import { startCostHarness } from "./cost-harness.js";

let harness: CostHarness;
let scope: EnvironmentScope;
let neighbour: EnvironmentScope;

beforeAll(async () => {
  harness = await startCostHarness();
  scope = await harness.freshScope();
  neighbour = await harness.freshScope();
}, 300_000);

afterAll(async () => {
  await harness?.stop();
});

function webhookChannel(channelId: string, credential: string): AlertChannel {
  return conformanceChannel(scope, channelId, {
    kind: "WEBHOOK",
    configuration: {
      kind: "WEBHOOK",
      url: "https://ops.example.test/hook",
      credential: asCostIdentifier<CredentialRef>(credential),
    },
  });
}

describe("a cap's ancestry is re-checked on every UPDATE, not only on INSERT", () => {
  test("an agent from another project is refused, and refused again on a later edit", async () => {
    const ours = await harness.seedAgent(scope);
    const theirs = await harness.seedAgent(neighbour);
    const capId = "ff000000-0001-4000-8000-000000000001";

    // The valid cap first, so the refusal below is about the AGENT and not
    // about anything else on the row.
    await runResult(harness.base.adapter.unitOfWork, (transaction) =>
      harness.repository.insertBudget(
        {
          ...conformanceBudget(scope, capId, "agent"),
          target: {
            ...conformanceBudget(scope, capId, "agent").target,
            agentId: asCostIdentifier<AgentId>(ours),
          },
        },
        transaction,
      ),
    );
    expect(
      (await harness.repository.findBudget(scope, asCostIdentifier(capId))).ok,
    ).toBe(true);

    // An agent in the NEIGHBOUR's project. `Budget_ancestry` joins `Agent` to
    // `Environment` on `projectId`, so this is refused even though the agent
    // exists and the environment exists.
    await expect(
      runResult(harness.base.adapter.unitOfWork, (transaction) =>
        harness.repository.insertBudget(
          {
            ...conformanceBudget(scope, "ff000000-0002-4000-8000-000000000001", "agent"),
            target: {
              ...conformanceBudget(scope, capId, "agent").target,
              agentId: asCostIdentifier<AgentId>(theirs),
            },
          },
          transaction,
        ),
      ),
    ).rejects.toThrow();

    // AND ON UPDATE. The rule is `BEFORE INSERT OR UPDATE`, so raising the
    // ceiling of an existing cap re-runs the whole ancestry check — which means
    // a cap can become unwritable because an agent moved, long after it was
    // created.
    await expect(
      harness.base.client.budget.update({
        where: { id: capId },
        data: { agentId: theirs, limitCents: 200_000 },
      }),
    ).rejects.toThrow();
  });
});

describe("two of the six rows cannot be corrected at all", () => {
  const capId = "ff000000-0003-4000-8000-000000000001";
  const crossingId = "ff000000-0004-4000-8000-000000000001";

  beforeAll(async () => {
    await harness.base.adapter.unitOfWork.run(async (transaction) => {
      await harness.repository.insertBudget(conformanceBudget(scope, capId, "scope"), transaction);
      await harness.repository.insertThresholdEvent(
        {
          eventId: asCostIdentifier<ThresholdEventId>(crossingId),
          environmentId: asCostIdentifier(scope.environmentId),
          budgetId: asCostIdentifier(capId),
          windowKey: asCostIdentifier("2026-10-01"),
          threshold: 50,
          spent: { microCents: 100_000_000n, currency: asCostIdentifier("USD") },
          tasks: 1,
          createdAt: AT,
        },
        transaction,
      );
    });
  }, 120_000);

  test("a crossing cannot be updated or deleted", async () => {
    await expect(
      harness.base.client.budgetThresholdEvent.update({
        where: { id: crossingId },
        data: { threshold: 80 },
      }),
    ).rejects.toThrow();
    await expect(
      harness.base.client.budgetThresholdEvent.delete({ where: { id: crossingId } }),
    ).rejects.toThrow();
    // Still exactly where it was. A crossing that could be edited could be
    // re-used, and the alert would go out twice.
    const row = await harness.base.client.budgetThresholdEvent.findUniqueOrThrow({
      where: { id: crossingId },
    });
    expect(row.threshold).toBe(50);
  });

  test("a send record cannot be updated or deleted", async () => {
    const channelId = "ff000000-0005-4000-8000-000000000001";
    const deliveryId = "ff000000-0006-4000-8000-000000000001";
    await harness.base.adapter.unitOfWork.run(async (transaction) => {
      await harness.repository.insertAlertChannel(
        conformanceChannel(scope, channelId),
        transaction,
      );
      await harness.repository.insertDelivery(
        {
          deliveryId: asCostIdentifier(deliveryId),
          environmentId: asCostIdentifier(scope.environmentId),
          channelId: asCostIdentifier(channelId),
          eventId: null,
          kind: "TEST",
          idempotencyKey: asCostIdentifier(`test:${channelId}:probe`),
          status: "PENDING",
          retryCount: 0,
          claimGeneration: 0,
          claimToken: null,
          availableAt: AT,
          lastRetryAt: null,
          deliveredAt: null,
          lastStatusCode: null,
          lastErrorCode: null,
          lastErrorMessage: null,
          createdAt: AT,
          updatedAt: AT,
        },
        transaction,
      );
      await harness.repository.settleDelivery(
        {
          deliveryId: asCostIdentifier(deliveryId),
          environmentId: asCostIdentifier(scope.environmentId),
          channelId: asCostIdentifier(channelId),
          eventId: null,
          kind: "TEST",
          idempotencyKey: asCostIdentifier(`test:${channelId}:probe`),
          status: "SUCCEEDED",
          retryCount: 1,
          claimGeneration: 0,
          claimToken: null,
          availableAt: LATER,
          lastRetryAt: LATER,
          deliveredAt: LATER,
          lastStatusCode: 200,
          lastErrorCode: null,
          lastErrorMessage: null,
          createdAt: AT,
          updatedAt: LATER,
        },
        {
          deliveryId: asCostIdentifier(deliveryId),
          environmentId: asCostIdentifier(scope.environmentId),
          retryNumber: 1,
          status: "SUCCEEDED",
          responseStatus: 200,
          errorCode: null,
          errorMessage: null,
          startedAt: LATER,
          finishedAt: LATER,
        },
        transaction,
      );
    });
    const record = await harness.base.client.alertDeliveryRetry.findFirstOrThrow({
      where: { deliveryId },
    });
    await expect(
      harness.base.client.alertDeliveryRetry.update({
        where: { id: record.id },
        data: { responseStatus: 500 },
      }),
    ).rejects.toThrow();
    await expect(
      harness.base.client.alertDeliveryRetry.delete({ where: { id: record.id } }),
    ).rejects.toThrow();
  });
});

describe("a channel's owner columns, its credential, and its tombstone", () => {
  test("a channel's kind cannot be changed once it is written", async () => {
    const channelId = "ff000000-0007-4000-8000-000000000001";
    await runResult(harness.base.adapter.unitOfWork, (transaction) =>
      harness.repository.insertAlertChannel(conformanceChannel(scope, channelId), transaction),
    );
    // `AlertChannel_owner_immutable` freezes `environmentId` and `type`. The
    // domain refuses a kind change in its PATCH type — "the store keys the
    // configuration on `[channelId, environmentId, type]`, so a kind change
    // would orphan the configuration row rather than convert it" — and the
    // table refuses it whatever a caller's type says.
    await expect(
      harness.base.client.alertChannel.update({
        where: { id: channelId },
        data: { type: "SLACK" },
      }),
    ).rejects.toThrow();
  });

  test("a configuration naming a credential that is not live is refused three ways", async () => {
    const revoked = await harness.seedCredential(scope, { revoked: true });
    const unstored = await harness.seedCredential(scope, { withoutSecretVersion: true });
    const wrongKind = await harness.seedCredential(scope, { kind: "ENTITY_SECRET" });
    for (const [index, credential] of [revoked, unstored, wrongKind].entries()) {
      await expect(
        runResult(harness.base.adapter.unitOfWork, (transaction) =>
          harness.repository.insertAlertChannel(
            webhookChannel(`ff000000-0008-4000-800${index}-000000000001`, credential),
            transaction,
          ),
        ),
      ).rejects.toThrow();
    }
    // And a live one is accepted, so the three refusals above are about the
    // credential's STATE rather than about the webhook shape.
    const live = await harness.seedCredential(scope);
    const written = await runResult(harness.base.adapter.unitOfWork, (transaction) =>
      harness.repository.insertAlertChannel(
        webhookChannel("ff000000-0009-4000-8000-000000000001", live),
        transaction,
      ),
    );
    expect(written.ok).toBe(true);
  });

  test("a tombstoned channel is invisible, and this port cannot tombstone one", async () => {
    const channelId = "ff000000-000a-4000-8000-000000000001";
    const live = await harness.seedCredential(scope);
    await runResult(harness.base.adapter.unitOfWork, (transaction) =>
      harness.repository.insertAlertChannel(webhookChannel(channelId, live), transaction),
    );
    expect(await harness.repository.countChannelsUsingCredential(scope, live)).toEqual({
      ok: true,
      value: 1,
    });

    // `deletedAt` is set HERE, by hand, because `BudgetRepository` publishes no
    // method that can set it — there is `insertAlertChannel` and
    // `updateAlertChannel` and nothing else, and `retireChannel` in the domain
    // clears `enabled` and the deduplication key without a tombstone. So this
    // is the state an OLDER surface leaves behind, and the reason every channel
    // read filters on the column.
    await harness.base.client.alertChannel.update({
      where: { id: channelId },
      data: { deletedAt: LATER },
    });
    expect(await harness.repository.findAlertChannel(scope, asCostIdentifier(channelId))).toEqual({
      ok: true,
      value: null,
    });
    expect(await harness.repository.countChannelsUsingCredential(scope, live)).toEqual({
      ok: true,
      value: 0,
    });

    // AND IT CANNOT BE EDITED BACK INTO SERVICE. `updateAlertChannel` carries
    // the same `deletedAt: null` term the reads carry, so no method this port
    // publishes can reach a row an older surface deleted — which is what makes
    // "this port cannot tombstone one" a statement about the whole surface
    // rather than about the reads alone. WIN-258 T5's mutation sweep added this
    // half: removing that term from the predicate left every assertion above
    // green, because until now nothing here wrote to a tombstoned channel.
    const edited = await runResult(harness.base.adapter.unitOfWork, (transaction) =>
      harness.repository.updateAlertChannel(
        { ...webhookChannel(channelId, live), name: "edited back into service" },
        transaction,
      ),
    );
    expect(edited.ok).toBe(false);
    expect(
      (await harness.base.client.alertChannel.findFirst({ where: { id: channelId } }))?.name,
    ).not.toBe("edited back into service");
  });
});

describe("cross-scope denial is decided by the tenant chain, not by an id", () => {
  test("a cap is invisible to a scope whose organization does not own it", async () => {
    const capId = "ff000000-000b-4000-8000-000000000001";
    await runResult(harness.base.adapter.unitOfWork, (transaction) =>
      harness.repository.insertBudget(conformanceBudget(scope, capId, "scope"), transaction),
    );
    // The environment id is RIGHT and the organization and project are another
    // tenant's — the shape a caller holding a grant for one tenant and an id
    // from another produces. `InMemoryBudgetRepository` compares `environmentId`
    // and stops, so it would return the row; this adapter is deliberately
    // stricter, and the divergence is named here rather than left for a
    // conformance run that never supplies a mismatched scope.
    const forged: EnvironmentScope = { ...neighbour, environmentId: scope.environmentId };
    expect(await harness.repository.findBudget(forged, asCostIdentifier(capId))).toEqual({
      ok: true,
      value: null,
    });
    expect(await harness.repository.listBudgets(forged)).toEqual({ ok: true, value: [] });
  });

  test("a cap cannot be moved between environments by updating it", async () => {
    const capId = "ff000000-000c-4000-8000-000000000001";
    await runResult(harness.base.adapter.unitOfWork, (transaction) =>
      harness.repository.insertBudget(conformanceBudget(scope, capId, "scope"), transaction),
    );
    // `Budget` is the ONE row of the six with no `reject_canonical_owner_change`
    // rule, so nothing in the database stops an `update` keyed on `id` alone
    // from moving it. The predicate is what stops it, and a caller presenting
    // another environment gets the same answer an unknown identifier gets.
    const moved = await runResult(harness.base.adapter.unitOfWork, (transaction) =>
      harness.repository.updateBudget(
        { ...conformanceBudget(neighbour, capId, "scope"), limitCents: 900_000 },
        transaction,
      ),
    );
    expect(moved.ok).toBe(false);
    const held = await harness.repository.findBudget(scope, asCostIdentifier(capId));
    expect(held.ok && held.value?.environmentId).toBe(scope.environmentId);
    expect(held.ok && held.value?.limitCents).toBe(100_000);
  });
});
