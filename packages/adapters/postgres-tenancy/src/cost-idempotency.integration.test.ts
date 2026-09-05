// The four guards whose ONLY witness was a crashed hook.
//
// WIN-258 T5's mutation sweep ran all forty ledger entries against a real
// PostgreSQL and scored six of them with ZERO executed cases. Two of those six
// were caught by a named case in another suite once the sweep was widened to the
// whole set. The other four — M-C06, M-C13, M-C17 and M-C20 — were caught by
// nothing: removing the guard made `cost-conformance.integration.test.ts` fail
// while BUILDING its transcript, in a `beforeAll`, so every case in the file was
// reported SKIPPED and no named case went red. A suite set that turns red only
// through a setup crash cannot say WHICH promise broke, and a driver that scored
// it a kill would be scoring the same signal a missing `dist/` produces.
//
// All four are about a write that must NOT happen twice, and none of them is
// visible in a returned value on the conformance path, because that path never
// asks the same question a second time:
//
//   `insertBudget` uses the insert form that does NOT raise, so a taken
//   identifier comes back as a refusal a caller can branch on rather than as an
//   exception that aborts the transaction the fan-out is in.
//
//   `countChannelsUsingCredential` answers zero for a reference that is not a
//   uuid instead of sending it to a `@db.Uuid` comparison that raises 22P02.
//   The vault asks this before a revoke; a driver error there reads as "cannot
//   tell" and the revoke is what stops.
//
//   `claimDelivery` skips a SUCCEEDED row. Without that term a delivered alert
//   is claimable forever, and the second dispatcher sends it again.
//
//   `finaliseDelivery` writes NOTHING when the claim is stale — not the row and
//   not the send record. Without the count test the send record is appended for
//   a result that was discarded, and the delivery's history gains an entry for a
//   send nobody accepted.

import { afterAll, beforeAll, describe, expect, test } from "vitest";

import type {
  AlertDelivery,
  AlertDeliveryRetry,
  ClaimToken,
  EnvironmentScope,
} from "@platos/context-cost-monitoring/application/ports/index.js";
import { asCostIdentifier } from "@platos/context-cost-monitoring/application/ports/index.js";

import { AT, LATER, conformanceBudget, conformanceChannel } from "./cost-conformance.js";
import type { CostHarness } from "./cost-harness.js";
import { startCostHarness } from "./cost-harness.js";

let harness: CostHarness;
let scope: EnvironmentScope;

beforeAll(async () => {
  harness = await startCostHarness();
  scope = await harness.freshScope();
}, 300_000);

afterAll(async () => {
  await harness?.stop();
});

const CLAIM = asCostIdentifier<ClaimToken>("ff000000-0f01-4000-8000-000000000001");
const OTHER_CLAIM = asCostIdentifier<ClaimToken>("ff000000-0f02-4000-8000-000000000001");

/** A `TEST`-kind delivery, the one kind the domain lets `settleDelivery` reach. */
function delivery(channelId: string, deliveryId: string, overrides: Partial<AlertDelivery> = {}) {
  return {
    deliveryId: asCostIdentifier(deliveryId),
    environmentId: asCostIdentifier(scope.environmentId),
    channelId: asCostIdentifier(channelId),
    eventId: null,
    kind: "TEST",
    idempotencyKey: asCostIdentifier(`test:${deliveryId}`),
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
    ...overrides,
  } as AlertDelivery;
}

function sendRecord(deliveryId: string, retryNumber: number): AlertDeliveryRetry {
  return {
    deliveryId: asCostIdentifier(deliveryId),
    environmentId: asCostIdentifier(scope.environmentId),
    retryNumber,
    status: "FAILED",
    responseStatus: 500,
    errorCode: asCostIdentifier("upstream_500"),
    errorMessage: "the transport answered 500",
    startedAt: LATER,
    finishedAt: LATER,
  } as AlertDeliveryRetry;
}

describe("the writes that must not happen twice", () => {
  test("a cap whose identifier is taken is a REFUSAL, not a raise", async () => {
    const capId = "ff000000-0e01-4000-8000-000000000001";
    const first = await harness.base.adapter.unitOfWork.run((transaction) =>
      harness.repository.insertBudget(conformanceBudget(scope, capId, "scope"), transaction),
    );
    expect(first.ok).toBe(true);

    // THE WHOLE POINT IS THAT THIS RESOLVES. `insertBudget` writes through
    // `createMany` with the database's own skip, so a second insert of the same
    // identifier returns `ok: false` and leaves the caller's transaction usable.
    // An `INSERT` that raised would abort it, and a use case that inserts a cap
    // and then appends a crossing in one unit of work would lose the crossing to
    // a duplicate it was prepared to handle.
    const second = await harness.base.adapter.unitOfWork.run((transaction) =>
      harness.repository.insertBudget(
        conformanceBudget(scope, capId, "scope", { limitCents: 999_000 }),
        transaction,
      ),
    );
    expect(second.ok).toBe(false);

    // And the FIRST row is the one that survived, so the refusal wrote nothing.
    const held = await harness.repository.findBudget(scope, asCostIdentifier(capId));
    expect(held.ok && held.value?.limitCents).toBe(100_000);
  });

  test("a credential reference that is not a uuid is ANSWERED zero, not sent", async () => {
    // `AlertChannelConfiguration.credentialId` is `@db.Uuid`, so a comparison
    // against this value raises 22P02 in the driver rather than matching nothing.
    // The vault asks this question immediately before it revokes a secret; an
    // exception is not "no channel uses it", it is "the revoke cannot proceed".
    const answered = await harness.repository.countChannelsUsingCredential(scope, "not-a-uuid");
    expect(answered).toEqual({ ok: true, value: 0 });

    // A WELL-FORMED reference that names nothing answers zero too, which is what
    // makes the case above about the SHAPE rather than about the count.
    const absent = await harness.repository.countChannelsUsingCredential(
      scope,
      "ff000000-0e02-4000-8000-000000000001",
    );
    expect(absent).toEqual({ ok: true, value: 0 });
  });

  test("a delivered alert is never claimed again", async () => {
    const channelId = "ff000000-0e03-4000-8000-000000000001";
    const deliveryId = "ff000000-0e04-4000-8000-000000000001";
    await harness.base.adapter.unitOfWork.run(async (transaction) => {
      await harness.repository.insertAlertChannel(
        conformanceChannel(scope, channelId),
        transaction,
      );
      await harness.repository.insertDelivery(delivery(channelId, deliveryId), transaction);
    });

    // Claimable once, because `availableAt` has passed and the row is PENDING.
    const claimed = await harness.repository.claimDelivery(
      scope,
      asCostIdentifier(deliveryId),
      CLAIM,
      LATER,
      LATER,
    );
    expect(claimed.ok && claimed.value?.claimToken).toBe(CLAIM);
    // Consumed AT CLAIM TIME: a dispatcher that vanishes has still spent a retry.
    expect(claimed.ok && claimed.value?.retryCount).toBe(1);

    // Settled. `settleDelivery` is the synchronous path and names no claim, which
    // is why a `TEST` delivery can reach SUCCEEDED without a second claim.
    await harness.base.adapter.unitOfWork.run((transaction) =>
      harness.repository.settleDelivery(
        delivery(channelId, deliveryId, {
          status: "SUCCEEDED",
          retryCount: 1,
          claimToken: CLAIM,
          availableAt: AT,
          deliveredAt: LATER,
          lastStatusCode: 200,
          updatedAt: LATER,
        }),
        // `requireRetryRecord` refuses a SUCCEEDED record that still carries a
        // failure token, so the whole triple is cleared rather than the status
        // alone — the guard caught this fixture on its first run.
        {
          ...sendRecord(deliveryId, 1),
          status: "SUCCEEDED",
          responseStatus: 200,
          errorCode: null,
          errorMessage: null,
        },
        transaction,
      ),
    );

    // AND NOW IT IS OUT OF REACH. `availableAt` is in the past again, so the
    // lease term alone would let this through; SUCCEEDED being terminal is the
    // only thing standing between a delivered alert and a second send.
    const again = await harness.repository.claimDelivery(
      scope,
      asCostIdentifier(deliveryId),
      OTHER_CLAIM,
      LATER,
      LATER,
    );
    expect(again).toEqual({ ok: true, value: null });
    const row = await harness.base.client.alertDelivery.findUniqueOrThrow({
      where: { id: deliveryId },
    });
    expect(row.status).toBe("SUCCEEDED");
    expect(row.claimToken).toBe(CLAIM);
  });

  test("a stale claim writes NOTHING — not the row, and not the send record", async () => {
    const channelId = "ff000000-0e05-4000-8000-000000000001";
    const deliveryId = "ff000000-0e06-4000-8000-000000000001";
    await harness.base.adapter.unitOfWork.run(async (transaction) => {
      await harness.repository.insertAlertChannel(
        conformanceChannel(scope, channelId, { deduplicationKey: null }),
        transaction,
      );
      await harness.repository.insertDelivery(delivery(channelId, deliveryId), transaction);
    });
    const claimed = await harness.repository.claimDelivery(
      scope,
      asCostIdentifier(deliveryId),
      CLAIM,
      LATER,
      LATER,
    );
    expect(claimed.ok).toBe(true);

    // A dispatcher whose lease expired: the row was re-claimed, so the generation
    // it remembers is one behind. `finaliseDelivery`'s predicate names the token,
    // the generation AND the retry number, so this matches zero rows.
    const stale = await harness.base.adapter.unitOfWork.run((transaction) =>
      harness.repository.finaliseDelivery(
        delivery(channelId, deliveryId, {
          status: "FAILED",
          retryCount: 1,
          claimGeneration: 1,
          claimToken: CLAIM,
          lastStatusCode: 500,
          updatedAt: LATER,
        }),
        sendRecord(deliveryId, 1),
        { token: CLAIM, generation: 99, retryNumber: 1 },
        transaction,
      ),
    );
    expect(stale).toEqual({ ok: true, value: null });

    // NEITHER HALF LANDED. The delivery is still PROCESSING — claimable again
    // once its lease runs out, which is the recovery the port describes — and no
    // send record was appended for a result that was thrown away.
    const row = await harness.base.client.alertDelivery.findUniqueOrThrow({
      where: { id: deliveryId },
    });
    expect(row.status).toBe("PROCESSING");
    expect(
      await harness.base.client.alertDeliveryRetry.count({ where: { deliveryId } }),
    ).toBe(0);

    // And the SAME call with the generation it actually holds writes both.
    const fresh = await harness.base.adapter.unitOfWork.run((transaction) =>
      harness.repository.finaliseDelivery(
        delivery(channelId, deliveryId, {
          status: "FAILED",
          retryCount: 1,
          claimGeneration: 1,
          claimToken: CLAIM,
          lastStatusCode: 500,
          updatedAt: LATER,
        }),
        sendRecord(deliveryId, 1),
        { token: CLAIM, generation: 1, retryNumber: 1 },
        transaction,
      ),
    );
    expect(fresh.ok).toBe(true);
    expect(
      await harness.base.client.alertDeliveryRetry.count({ where: { deliveryId } }),
    ).toBe(1);
  });
});
