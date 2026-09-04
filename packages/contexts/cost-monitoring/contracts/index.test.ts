// The published surface: what it offers, and what it withholds.
import { describe, expect, it } from "vitest";

import {
  ENVIRONMENT_WIDE,
  asCostIdentifier,
  dayStamp,
  type AlertChannelId,
  type BudgetId,
} from "../domain/index.js";
import {
  buildCostTestContext,
  cents,
  testBudget,
  testChannel,
} from "../application/testing/index.js";
import {
  COST_MONITORING_EVENT_NAMES,
  costMonitoringContract,
  type CostMonitoringContract,
} from "./index.js";

function build(): { contract: CostMonitoringContract; context: ReturnType<typeof buildCostTestContext> } {
  const context = buildCostTestContext();
  return { contract: costMonitoringContract(context.dependencies), context };
}

describe("the contract object", () => {
  it("names itself, and is frozen", () => {
    const { contract } = build();
    expect(contract.name).toBe("cost-monitoring");
    expect(Object.isFrozen(contract)).toBe(true);
  });

  it("binds every method to a use case and holds no state of its own", () => {
    const { contract } = build();
    const methods = Object.entries(contract)
      .filter(([, value]) => typeof value === "function")
      .map(([key]) => key);
    expect(methods).toHaveLength(24);
    expect(new Set(methods).size).toBe(methods.length);
  });

  it("declares an integration event for every state change worth publishing", () => {
    expect(new Set(COST_MONITORING_EVENT_NAMES).size).toBe(COST_MONITORING_EVENT_NAMES.length);
    expect(COST_MONITORING_EVENT_NAMES.every((name) => name.startsWith("cost."))).toBe(true);
  });
});

describe("what the views carry", () => {
  it("renders a cap without a branded identifier or a nested aggregate", async () => {
    const { contract, context } = build();
    context.repository.seedBudget(testBudget(context.scope));
    const listed = await contract.listBudgets({
      authorization: context.tenancy.grant("metadata"),
    });
    if (!listed.ok) throw new Error("unreachable");
    expect(Object.keys(listed.value[0] ?? {}).sort()).toEqual([
      "agentId",
      "alertThresholds",
      "budgetId",
      "createdAt",
      "enabled",
      "environmentId",
      "limitCents",
      "overrideBy",
      "overrideUntil",
      "period",
      "runsLimit",
      "skillSlug",
      "subject",
      "targetId",
      "tier",
      "updatedAt",
    ]);
  });

  it("renders an amount as a canonical decimal STRING, never a number", async () => {
    // A JSON number cannot carry a Decimal(18, 6); a caller summing a month of
    // these would accumulate the difference.
    const { contract, context } = build();
    context.repository.seedBudget(testBudget(context.scope));
    context.ledger.seed(context.scope, { kind: "environment" }, dayStamp(context.clock.now()), {
      costWithCacheCents: 412.5,
    });
    const verdict = await contract.evaluateBudgets({
      authorization: context.tenancy.grant("metadata"),
      context: {},
    });
    if (!verdict.ok) throw new Error("unreachable");
    expect(verdict.value.caps[0]?.spentCents).toBe("412.500000");
    expect(typeof verdict.value.caps[0]?.spentCents).toBe("string");
  });

  it("renders utilisation as integer BASIS POINTS, not a float percentage", async () => {
    // A float percentage at the boundary would reintroduce exactly the rounding
    // this context removed from the threshold comparison.
    const { contract, context } = build();
    context.repository.seedBudget(testBudget(context.scope));
    context.ledger.seed(context.scope, { kind: "environment" }, dayStamp(context.clock.now()), {
      costWithCacheCents: 499.96,
    });
    const verdict = await contract.evaluateBudgets({
      authorization: context.tenancy.grant("metadata"),
      context: {},
    });
    if (!verdict.ok) throw new Error("unreachable");
    expect(verdict.value.caps[0]?.percentBasisPoints).toBe(5_000);
    expect(Number.isInteger(verdict.value.caps[0]?.percentBasisPoints)).toBe(true);
  });

  it("NEVER hands out a credential reference on a channel view", async () => {
    // A reference is a handle into another context's vault; handing one out
    // invites a caller to try to use it.
    const { contract, context } = build();
    context.repository.seedChannel(
      testChannel(context.scope, {
        kind: "WEBHOOK",
        configuration: {
          kind: "WEBHOOK",
          url: "https://x.example.test",
          credential: asCostIdentifier("cred-secret-1"),
        },
      }),
    );
    const listed = await contract.listAlertChannels({
      authorization: context.tenancy.grant("metadata"),
    });
    if (!listed.ok) throw new Error("unreachable");
    const serialised = JSON.stringify(listed.value);
    expect(serialised).not.toContain("cred-secret-1");
    expect(listed.value[0]?.address).toEqual({
      kind: "WEBHOOK",
      url: "https://x.example.test",
      hasSecret: true,
    });
  });

  it("says whether a chat channel has a token without naming it", async () => {
    const { contract, context } = build();
    context.repository.seedChannel(
      testChannel(context.scope, {
        kind: "SLACK",
        configuration: {
          kind: "SLACK",
          channelId: "C1",
          channelName: "#ops",
          integrationId: null,
          credential: null,
        },
      }),
    );
    const listed = await contract.listAlertChannels({
      authorization: context.tenancy.grant("metadata"),
    });
    if (!listed.ok) throw new Error("unreachable");
    expect(listed.value[0]?.address).toEqual({
      kind: "SLACK",
      channelId: "C1",
      channelName: "#ops",
      integrationId: null,
      hasSecret: false,
    });
  });
});

describe("the methods a caller actually reaches for", () => {
  it("guards a spend by scope, with no operator grant at all", async () => {
    // A turn is not an operator action; making it fabricate a grant is the shape
    // that eventually gets a fabricated grant accepted somewhere it should not be.
    const { contract, context } = build();
    context.repository.seedBudget(
      testBudget(context.scope, {
        limitCents: 100,
        target: { ...ENVIRONMENT_WIDE, tier: "skill" },
      }),
    );
    const verdict = await contract.guardSpend({
      scope: context.scope,
      intent: { tier: "skill", skillSlug: null, agentId: null },
      amount: cents(200),
    });
    if (!verdict.ok) throw new Error("unreachable");
    expect(verdict.value.allowed).toBe(false);
  });

  it("configures, overrides and removes a cap end to end", async () => {
    const { contract, context } = build();
    const grant = context.tenancy.grant("metadata");
    const written = await contract.configureBudget({
      authorization: grant,
      intake: { subject: "scope", period: "day", limitCents: 2_500 },
    });
    if (!written.ok) throw new Error("unreachable");

    const overridden = await contract.overrideBudget({
      authorization: grant,
      budgetId: asCostIdentifier<BudgetId>(written.value.budgetId),
      minutes: 15,
    });
    if (!overridden.ok) throw new Error("unreachable");
    expect(overridden.value.overrideBy).toBe("operator-1");

    const removed = await contract.removeBudget({
      authorization: grant,
      budgetId: asCostIdentifier<BudgetId>(written.value.budgetId),
    });
    if (!removed.ok) throw new Error("unreachable");
    expect(removed.value.enabled).toBe(false);
  });

  it("probes a channel and reports the outcome beside the durable row", async () => {
    const { contract, context } = build();
    const seeded = context.repository.seedChannel(testChannel(context.scope));
    const probed = await contract.probeAlertChannel({
      authorization: context.tenancy.grant("secret:mutate"),
      channelId: seeded.channelId,
    });
    if (!probed.ok) throw new Error("unreachable");
    expect(probed.value.ok).toBe(true);
    expect(probed.value.delivery.status).toBe("SUCCEEDED");
  });

  it("retires a channel and says whether its credential may be revoked", async () => {
    const { contract, context } = build();
    const seeded = context.repository.seedChannel(
      testChannel(context.scope, {
        channelId: asCostIdentifier<AlertChannelId>("channel-web"),
        kind: "WEBHOOK",
        configuration: {
          kind: "WEBHOOK",
          url: "https://x.example.test",
          credential: asCostIdentifier("cred-1"),
        },
      }),
    );
    const removed = await contract.removeAlertChannel({
      authorization: context.tenancy.grant("secret:mutate"),
      channelId: seeded.channelId,
    });
    if (!removed.ok) throw new Error("unreachable");
    expect(removed.value.releasableCredential).toBe("cred-1");
  });

  it("returns a `Result` rather than raising, on every failure path", async () => {
    const { contract } = build();
    for (const failing of [
      contract.listBudgets({ authorization: {} }),
      contract.describeBudget({ authorization: {}, budgetId: asCostIdentifier<BudgetId>("x") }),
      contract.configureBudget({
        authorization: {},
        intake: { subject: "scope", period: "day", limitCents: 1 },
      }),
      contract.listAlertChannels({ authorization: {} }),
      contract.summariseConsumption({ authorization: {}, userId: "u" }),
      contract.sweepBreaches({ authorization: {}, activeUserIds: [] }),
    ]) {
      const result = await failing;
      expect(result.ok).toBe(false);
    }
  });
});
