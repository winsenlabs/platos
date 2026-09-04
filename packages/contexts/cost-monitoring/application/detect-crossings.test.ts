// Recording a crossing — the durable "this already fired" half of alerting.
// Sending one, and the reconciliation backstop, is `deliver-crossing.test.ts`.
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
import { evaluateForScope } from "./evaluate-budgets.js";
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

describe("recording a crossing", () => {
  it("writes one crossing per threshold and one delivery per subscribed channel", async () => {
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
      status: statusFor(context, 900),
    });
    if (!recorded.ok) throw new Error("unreachable");
    expect(recorded.value.map((row) => row.event.threshold)).toEqual([50, 80]);
    expect(recorded.value[0]?.recipients).toBe(2);
    expect(context.repository.allDeliveries()).toHaveLength(4);
  });

  it("records NOTHING for a crossing that already fired", async () => {
    const context = buildCostTestContext();
    context.repository.seedBudget(testBudget(context.scope));
    context.repository.seedChannel(testChannel(context.scope));
    const status = statusFor(context, 900);

    const first = await detectCrossings(context.dependencies, { scope: context.scope, status });
    const second = await detectCrossings(context.dependencies, { scope: context.scope, status });
    if (!first.ok || !second.ok) throw new Error("unreachable");
    expect(first.value).toHaveLength(2);
    // The unique constraint is what makes "alert exactly once" true across a
    // restart, a redelivery and two evaluators racing.
    expect(second.value).toEqual([]);
    expect(context.repository.allDeliveries()).toHaveLength(2);
  });

  it("records the ADDITIONAL threshold when spend climbs further", async () => {
    const context = buildCostTestContext();
    context.repository.seedBudget(testBudget(context.scope));
    context.repository.seedChannel(testChannel(context.scope));
    await detectCrossings(context.dependencies, { scope: context.scope, status: statusFor(context, 900) });
    const climbed = await detectCrossings(context.dependencies, {
      scope: context.scope,
      status: statusFor(context, 1_000),
    });
    if (!climbed.ok) throw new Error("unreachable");
    expect(climbed.value.map((row) => row.event.threshold)).toEqual([100]);
  });

  it("fires again in a NEW window, because the key moved", async () => {
    const context = buildCostTestContext();
    context.repository.seedBudget(testBudget(context.scope));
    context.repository.seedChannel(testChannel(context.scope));
    await detectCrossings(context.dependencies, { scope: context.scope, status: statusFor(context, 900) });
    context.clock.advanceDays(1);
    const tomorrow = await detectCrossings(context.dependencies, {
      scope: context.scope,
      status: statusFor(context, 900),
    });
    if (!tomorrow.ok) throw new Error("unreachable");
    expect(tomorrow.value).toHaveLength(2);
  });

  it("records the crossing even when NO channel is subscribed", async () => {
    // The crossing is the durable fact; the delivery is a consequence. An
    // environment that adds a channel later must not re-fire the whole history.
    const context = buildCostTestContext();
    context.repository.seedBudget(testBudget(context.scope));
    const recorded = await detectCrossings(context.dependencies, {
      scope: context.scope,
      status: statusFor(context, 900),
    });
    if (!recorded.ok) throw new Error("unreachable");
    expect(recorded.value).toHaveLength(2);
    expect(context.repository.allDeliveries()).toEqual([]);
  });

  it("skips a channel that is not subscribed to budget alerts", async () => {
    const context = buildCostTestContext();
    context.repository.seedBudget(testBudget(context.scope));
    context.repository.seedChannel(testChannel(context.scope, { topics: ["OTHER_TOPIC"] }));
    const recorded = await detectCrossings(context.dependencies, {
      scope: context.scope,
      status: statusFor(context, 900),
    });
    if (!recorded.ok) throw new Error("unreachable");
    expect(recorded.value[0]?.recipients).toBe(0);
  });

  it("snapshots the spend at the crossing rather than recomputing it later", async () => {
    const context = buildCostTestContext();
    context.repository.seedBudget(testBudget(context.scope));
    const recorded = await detectCrossings(context.dependencies, {
      scope: context.scope,
      status: statusFor(context, 900),
    });
    if (!recorded.ok) throw new Error("unreachable");
    expect(recorded.value[0]?.event.spent.microCents).toBe(900_000_000n);
  });

  it("writes the crossing and its deliveries in ONE transaction", async () => {
    // A crossing committed alone leaves an alert permanently owed and
    // permanently unsent: the unique constraint refuses it forever after while
    // no delivery row exists to send it.
    const context = buildCostTestContext();
    context.repository.seedBudget(testBudget(context.scope));
    context.repository.seedChannel(testChannel(context.scope));
    await detectCrossings(context.dependencies, {
      scope: context.scope,
      status: statusFor(context, 500),
    });
    expect(context.unitOfWork.transactions).toHaveLength(1);
  });

  // COUNTING THE TRANSACTIONS IS NOT THE PROPERTY. The case above proves the two
  // writes were handed ONE scope; it says nothing about what happens when the
  // second write fails, which is the whole reason they share a transaction.
  //
  // That was not merely untested, it was UNTRUE. `UnitOfWork.run` "commits when
  // `work` resolves and rolls back when it rejects", and a fan-out failure
  // RETURNED an error `Result` from inside the callback — resolving it, and
  // therefore committing the crossing with no delivery rows beside it. That is
  // word for word the failure this module's header says it exists to prevent:
  // "silent, durable, and exactly the one this design exists to prevent". The
  // in-memory unit of work could not see it either, because it had no rollback
  // to model; it does now, and it models only what the port promises.
  it("commits NEITHER write when the fan-out fails", async () => {
    const context = buildCostTestContext();
    context.repository.seedBudget(testBudget(context.scope));
    context.repository.seedChannel(testChannel(context.scope));
    context.repository.failOn.add("insertDeliveries");

    const recorded = await detectCrossings(context.dependencies, {
      scope: context.scope,
      status: statusFor(context, 500),
    });

    // The failure crosses as a value, not as an exception.
    expect(recorded.ok).toBe(false);
    if (recorded.ok) throw new Error("unreachable");
    expect(recorded.error.code).toBe("COST_REPOSITORY_UNAVAILABLE");
    // And NOTHING committed. A crossing here would be owed forever and unsent
    // forever, because the unique constraint would refuse it on every retry.
    expect(context.repository.allCrossings()).toEqual([]);
    expect(context.repository.allDeliveries()).toEqual([]);
  });

  it("lets the retry succeed once the fan-out recovers, because nothing was stranded", async () => {
    // The consequence of the case above, and the reason it matters: the crossing
    // is retryable. Had the first call committed the crossing alone, this second
    // one would meet the unique constraint, receive `null`, record nothing, and
    // the alert would never be sent.
    const context = buildCostTestContext();
    context.repository.seedBudget(testBudget(context.scope));
    context.repository.seedChannel(testChannel(context.scope));
    const status = statusFor(context, 500);

    context.repository.failOn.add("insertDeliveries");
    await detectCrossings(context.dependencies, { scope: context.scope, status });
    context.repository.failOn.delete("insertDeliveries");

    const retried = await detectCrossings(context.dependencies, { scope: context.scope, status });
    if (!retried.ok) throw new Error("unreachable");
    expect(retried.value).toHaveLength(1);
    expect(context.repository.allDeliveries()).toHaveLength(1);
  });
});

describe("the evaluation the crossing path is fed from", () => {
  it("reports the blocked verdict and its one rendered reason", async () => {
    const context = buildCostTestContext();
    context.repository.seedBudget(testBudget(context.scope));
    context.ledger.seed(context.scope, { kind: "environment" }, dayStamp(context.clock.now()), {
      costWithCacheCents: 1_000,
    });
    const verdict = await evaluateForScope(context.dependencies, context.scope, {});
    expect(verdict.blocked).toBe(true);
    expect(verdict.reason).toBe("Budget cap exceeded: scope/day — 1000.000000 of 1000 cents");
  });

  it("DROPS a cap whose window cannot be read and keeps the rest", async () => {
    const context = buildCostTestContext();
    context.repository.seedBudget(testBudget(context.scope));
    context.ledger.unavailable = true;
    const verdict = await evaluateForScope(context.dependencies, context.scope, {});
    expect(verdict.caps).toEqual([]);
    expect(verdict.blocked).toBe(false);
  });
});
