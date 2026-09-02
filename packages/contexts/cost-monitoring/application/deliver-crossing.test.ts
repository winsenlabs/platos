// Sending a crossing, and the reconciliation backstop that catches what the
// send path missed. Recording a crossing is `detect-crossings.test.ts`.
import { describe, expect, it } from "vitest";

import {
  asCostIdentifier,
  dayStamp,
  evaluateBudget,
  windowKeyFor,
  type AlertChannelId,
  type BudgetStatus,
  type SpendReading,
} from "../domain/index.js";
import { centsToMoney } from "../domain/index.js";
import { detectCrossings } from "./detect-crossings.js";
import { deliverCrossing } from "./deliver-crossing.js";
import { reconcileDeliveries } from "./reconcile-deliveries.js";
import { buildCostTestContext, testBudget, testChannel } from "./testing/index.js";

function reading(settledCents: number, tasks = 0): SpendReading {
  const settled = centsToMoney(settledCents);
  const zeroed = centsToMoney(0);
  if (!settled.ok || !zeroed.ok) throw new Error("unreachable");
  return { settled: settled.value, reserved: zeroed.value, tasks };
}

function statusFor(
  context: ReturnType<typeof buildCostTestContext>,
  settledCents: number,
): BudgetStatus {
  const budget = testBudget(context.scope);
  const now = context.clock.now();
  return evaluateBudget(budget, windowKeyFor(budget.period, now), reading(settledCents), now);
}

describe("sending a crossing", () => {
  async function crossing(context: ReturnType<typeof buildCostTestContext>) {
    context.repository.seedBudget(testBudget(context.scope));
    context.repository.seedChannel(testChannel(context.scope));
    const recorded = await detectCrossings(context.dependencies, {
      scope: context.scope,
      status: statusFor(context, 500),
    });
    if (!recorded.ok || recorded.value[0] === undefined) throw new Error("unreachable");
    return recorded.value[0].event;
  }

  it("delivers to every recipient and records the result", async () => {
    const context = buildCostTestContext();
    const event = await crossing(context);
    const sent = await deliverCrossing(context.dependencies, {
      scope: context.scope,
      eventId: event.eventId,
    });
    if (!sent.ok) throw new Error("unreachable");
    expect(sent.value.delivered).toBe(1);
    expect(context.email.sends).toHaveLength(1);
    expect(context.repository.allDeliveries()[0]?.status).toBe("SUCCEEDED");
    expect(context.repository.retries).toHaveLength(1);
  });

  it("SKIPS a delivery that already succeeded, without sending again", async () => {
    const context = buildCostTestContext();
    const event = await crossing(context);
    await deliverCrossing(context.dependencies, { scope: context.scope, eventId: event.eventId });
    const again = await deliverCrossing(context.dependencies, {
      scope: context.scope,
      eventId: event.eventId,
    });
    if (!again.ok) throw new Error("unreachable");
    expect(again.value.skipped).toBe(1);
    expect(context.email.sends).toHaveLength(1);
  });

  it("records a transport failure on the ledger and FAILS the batch", async () => {
    const context = buildCostTestContext();
    const event = await crossing(context);
    const delivery = context.repository.allDeliveries()[0];
    if (delivery === undefined) throw new Error("unreachable");
    context.email.failFor.add(delivery.deliveryId);

    const sent = await deliverCrossing(context.dependencies, {
      scope: context.scope,
      eventId: event.eventId,
    });
    expect(sent.ok).toBe(false);
    if (sent.ok) throw new Error("unreachable");
    expect(sent.error.code).toBe("COST_DELIVERY_FAILED");
    const row = context.repository.allDeliveries()[0];
    expect(row?.status).toBe("FAILED");
    expect(row?.lastErrorCode).toBe("transport_error");
    expect(row?.availableAt).toEqual(new Date("2026-01-15T12:00:30.000Z"));
  });

  it("attends to EVERY recipient even when one fails", async () => {
    // Aborting on the first failure leaves the rest unsent and makes the retry
    // re-send the ones that already worked.
    const context = buildCostTestContext();
    context.repository.seedBudget(testBudget(context.scope));
    context.repository.seedChannel(testChannel(context.scope));
    context.repository.seedChannel(
      testChannel(context.scope, {
        channelId: asCostIdentifier<AlertChannelId>("channel-2"),
        kind: "WEBHOOK",
        configuration: { kind: "WEBHOOK", url: "https://x.example.test", credential: asCostIdentifier("cred-1") },
      }),
    );
    const recorded = await detectCrossings(context.dependencies, {
      scope: context.scope,
      status: statusFor(context, 500),
    });
    if (!recorded.ok || recorded.value[0] === undefined) throw new Error("unreachable");
    const first = context.repository.allDeliveries()[0];
    if (first === undefined) throw new Error("unreachable");
    context.email.failFor.add(first.deliveryId);
    context.webhook.failFor.add(first.deliveryId);

    const sent = await deliverCrossing(context.dependencies, {
      scope: context.scope,
      eventId: recorded.value[0].event.eventId,
    });
    expect(sent.ok).toBe(false);
    expect(context.email.sends.length + context.webhook.sends.length).toBe(2);
    expect(context.repository.retries).toHaveLength(2);
  });

  it("records a channel with NO composed transport as misconfigured, before any call", async () => {
    const context = buildCostTestContext({ notifiers: [] });
    const event = await crossing(context);
    const sent = await deliverCrossing(context.dependencies, {
      scope: context.scope,
      eventId: event.eventId,
    });
    expect(sent.ok).toBe(false);
    expect(context.repository.allDeliveries()[0]?.lastErrorCode).toBe("missing_configuration");
  });

  it("records a disabled channel as such rather than sending to it", async () => {
    const context = buildCostTestContext();
    context.repository.seedBudget(testBudget(context.scope));
    const channel = context.repository.seedChannel(testChannel(context.scope));
    const recorded = await detectCrossings(context.dependencies, {
      scope: context.scope,
      status: statusFor(context, 500),
    });
    if (!recorded.ok || recorded.value[0] === undefined) throw new Error("unreachable");
    context.repository.seedChannel({ ...channel, enabled: false });

    await deliverCrossing(context.dependencies, {
      scope: context.scope,
      eventId: recorded.value[0].event.eventId,
    });
    expect(context.email.sends).toEqual([]);
    expect(context.repository.allDeliveries()[0]?.lastErrorCode).toBe("channel_disabled");
  });

  it("turns a notifier that RAISES into a recorded failure, not a thrown one", async () => {
    // The ledger is what the retry reads, and an exception writes nothing to it.
    const context = buildCostTestContext();
    const event = await crossing(context);
    const delivery = context.repository.allDeliveries()[0];
    if (delivery === undefined) throw new Error("unreachable");
    context.email.raiseFor.add(delivery.deliveryId);

    const sent = await deliverCrossing(context.dependencies, {
      scope: context.scope,
      eventId: event.eventId,
    });
    expect(sent.ok).toBe(false);
    expect(context.repository.allDeliveries()[0]?.status).toBe("FAILED");
  });

  it("refuses a crossing that is not in this scope", async () => {
    const context = buildCostTestContext();
    const denied = await deliverCrossing(context.dependencies, {
      scope: context.scope,
      eventId: asCostIdentifier("event-nope"),
    });
    expect(denied.ok).toBe(false);
    if (denied.ok) throw new Error("unreachable");
    expect(denied.error.code).toBe("COST_THRESHOLD_EVENT_UNAVAILABLE");
  });

  it("sends the SNAPSHOT, not a fresh reading of the counters", async () => {
    const context = buildCostTestContext();
    const event = await crossing(context);
    context.ledger.seed(
      context.scope,
      { kind: "environment" },
      dayStamp(context.clock.now()),
      { costWithCacheCents: 99_999 },
    );
    await deliverCrossing(context.dependencies, { scope: context.scope, eventId: event.eventId });
    expect(context.email.sends[0]?.threshold).toBe(50);
  });
});

describe("the reconciliation backstop", () => {
  it("finds a crossing whose delivery is still owed and sends it", async () => {
    // Independent of the crossing path and of the durable runner, which is what
    // makes it a genuine backstop rather than a second copy of one failure.
    const context = buildCostTestContext();
    context.repository.seedBudget(testBudget(context.scope));
    context.repository.seedChannel(testChannel(context.scope));
    await detectCrossings(context.dependencies, {
      scope: context.scope,
      status: statusFor(context, 500),
    });

    const swept = await reconcileDeliveries(context.dependencies);
    if (!swept.ok) throw new Error("unreachable");
    expect(swept.value).toEqual({ processed: 1, failed: 0 });
    expect(context.email.sends).toHaveLength(1);
  });

  it("does not re-send a crossing whose deliveries all succeeded", async () => {
    const context = buildCostTestContext();
    context.repository.seedBudget(testBudget(context.scope));
    context.repository.seedChannel(testChannel(context.scope));
    await detectCrossings(context.dependencies, {
      scope: context.scope,
      status: statusFor(context, 500),
    });
    await reconcileDeliveries(context.dependencies);
    const second = await reconcileDeliveries(context.dependencies);
    if (!second.ok) throw new Error("unreachable");
    expect(second.value.processed).toBe(0);
    expect(context.email.sends).toHaveLength(1);
  });

  it("waits out a failed delivery's backoff before offering it again", async () => {
    const context = buildCostTestContext();
    context.repository.seedBudget(testBudget(context.scope));
    context.repository.seedChannel(testChannel(context.scope));
    await detectCrossings(context.dependencies, {
      scope: context.scope,
      status: statusFor(context, 500),
    });
    const delivery = context.repository.allDeliveries()[0];
    if (delivery === undefined) throw new Error("unreachable");
    context.email.failFor.add(delivery.deliveryId);
    await reconcileDeliveries(context.dependencies);

    const tooSoon = await reconcileDeliveries(context.dependencies);
    if (!tooSoon.ok) throw new Error("unreachable");
    expect(tooSoon.value.processed).toBe(0);
    expect(context.email.sends).toHaveLength(1);

    context.clock.advanceSeconds(31);
    context.email.failFor.clear();
    const later = await reconcileDeliveries(context.dependencies);
    if (!later.ok) throw new Error("unreachable");
    expect(later.value.processed).toBe(1);
    expect(context.email.sends).toHaveLength(2);
  });

  it("RECOVERS a delivery whose dispatcher died mid-send", async () => {
    // The lease is what makes the claim a lease rather than a lock: a process
    // that vanished holds nothing once its lease expires.
    const context = buildCostTestContext();
    context.repository.seedBudget(testBudget(context.scope));
    context.repository.seedChannel(testChannel(context.scope));
    await detectCrossings(context.dependencies, {
      scope: context.scope,
      status: statusFor(context, 500),
    });
    const delivery = context.repository.allDeliveries()[0];
    if (delivery === undefined) throw new Error("unreachable");
    // Claim it and never finalise — a dispatcher that died.
    await context.repository.claimDelivery(
      context.scope,
      delivery.deliveryId,
      asCostIdentifier("orphan"),
      new Date(context.clock.now().getTime() + 120_000),
      context.clock.now(),
    );
    const stuck = await reconcileDeliveries(context.dependencies);
    if (!stuck.ok) throw new Error("unreachable");
    expect(stuck.value.processed).toBe(0);

    context.clock.advanceSeconds(121);
    const recovered = await reconcileDeliveries(context.dependencies);
    if (!recovered.ok) throw new Error("unreachable");
    expect(recovered.value.processed).toBe(1);
    expect(context.email.sends).toHaveLength(1);
  });

  it("counts a failed crossing and CONTINUES the pass", async () => {
    // One permanently unreachable channel must not block every other crossing
    // behind it forever.
    const context = buildCostTestContext();
    context.repository.seedBudget(testBudget(context.scope));
    context.repository.seedChannel(testChannel(context.scope));
    await detectCrossings(context.dependencies, {
      scope: context.scope,
      status: statusFor(context, 900),
    });
    for (const delivery of context.repository.allDeliveries()) {
      context.email.failFor.add(delivery.deliveryId);
    }
    const swept = await reconcileDeliveries(context.dependencies);
    if (!swept.ok) throw new Error("unreachable");
    expect(swept.value).toEqual({ processed: 0, failed: 2 });
  });

  it("reports an empty pass rather than raising when its queue cannot be read", async () => {
    // A scheduled task that raises tends to be a scheduled task somebody
    // switches off; the rows it did not see are still owed and still visible.
    const context = buildCostTestContext();
    context.repository.failOn.add("listPendingCrossings");
    const swept = await reconcileDeliveries(context.dependencies);
    if (!swept.ok) throw new Error("unreachable");
    expect(swept.value).toEqual({ processed: 0, failed: 0 });
  });
});

