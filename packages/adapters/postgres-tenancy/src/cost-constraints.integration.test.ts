// Every guard in `cost-guards.ts`, held against the constraint it restates.
//
// EACH CASE IS TWO HALVES. The first calls the port with a value the in-memory
// double accepts and watches the guard refuse it by NAME. The second sends the
// SAME value straight to the client, past the guard, and watches PostgreSQL
// refuse it too. A guard that drifted looser than its constraint fails the
// second half; one that drifted tighter fails the conformance run, which uses
// values both stores accept.
//
// THREE GUARDS HAVE NO CONSTRAINT BEHIND THEM AND SAY SO. The thresholds guard
// is stricter than `Budget_alertThresholds_json_root`, which constrains only the
// JSON ROOT; the representable-spend guard is not a constraint at all but a
// COLUMN TYPE that is narrower than the domain type it holds; and
// `Budget.period` has no CHECK, so an unrecognised period is refused on the way
// OUT rather than on the way in. Each of the three has a case below showing what
// the database actually does, so the asymmetry is evidence rather than a claim.

import { afterAll, beforeAll, describe, expect, test } from "vitest";

import type {
  Budget,
  EnvironmentScope,
  ThresholdEvent,
} from "@platos/context-cost-monitoring/application/ports/index.js";
import { asCostIdentifier } from "@platos/context-cost-monitoring/application/ports/index.js";
import { runResult } from "@platos/kernel";

import {
  BUDGET_LIMIT_OUT_OF_RANGE,
  BUDGET_THRESHOLDS_INVALID,
  CHANNEL_DEDUPE_SHAPE_INVALID,
  CHANNEL_NAME_INVALID,
  CHANNEL_TOPICS_EMPTY,
  CROSSING_SPEND_NOT_REPRESENTABLE,
  CROSSING_VALUES_INVALID,
  DELIVERY_KIND_SHAPE_INVALID,
  DELIVERY_STATE_INCOHERENT,
  IDENTIFIER_NOT_UUID,
  RETRY_RECORD_INVALID,
} from "./cost-guards.js";
import { AT, conformanceBudget, conformanceChannel } from "./cost-conformance.js";
import type { CostHarness } from "./cost-harness.js";
import { startCostHarness } from "./cost-harness.js";
import { UNKNOWN_BUDGET_PERIOD, UNREADABLE_ALERT_THRESHOLDS } from "./cost-rows.js";

let harness: CostHarness;
let scope: EnvironmentScope;

beforeAll(async () => {
  harness = await startCostHarness();
  scope = await harness.freshScope();
}, 300_000);

afterAll(async () => {
  await harness?.stop();
});

/** The refusal code an error carries, or a marker naming what arrived instead. */
function codeOf(error: unknown): string {
  if (typeof error === "object" && error !== null) {
    const code = (error as { readonly code?: unknown }).code;
    if (typeof code === "string") return code;
  }
  return `<uncoded:${String(error)}>`;
}

async function refusalOf(work: () => Promise<unknown>): Promise<string> {
  try {
    await work();
  } catch (error) {
    return codeOf(error);
  }
  return "<no refusal>";
}

/** A cap written straight to the client, past every guard. */
function rawBudget(overrides: Record<string, unknown>): Record<string, unknown> {
  return {
    id: "dd000000-0001-4000-8000-000000000001",
    environmentId: scope.environmentId,
    agentId: null,
    scope: '{"scopeType":"scope","targetId":"","tier":"llm"}',
    period: "day",
    limitCents: 1_000,
    turnsLimit: 0,
    alertThresholds: [50],
    enabled: true,
    createdAt: AT,
    updatedAt: AT,
    ...overrides,
  };
}

describe("identifiers, limits and thresholds on a cap", () => {
  test("a readable placeholder is refused by the guard and by the uuid column", async () => {
    // `testBudget` in the context's own fixtures mints exactly this, and every
    // use-case suite in the tree passes with it.
    const cap = conformanceBudget(scope, "budget-1", "scope");
    expect(
      await refusalOf(() =>
        runResult(harness.base.adapter.unitOfWork, (transaction) =>
          harness.repository.insertBudget(cap, transaction),
        ),
      ),
    ).toBe(IDENTIFIER_NOT_UUID);
    await expect(
      harness.base.client.budget.create({ data: rawBudget({ id: "budget-1" }) as never }),
    ).rejects.toThrow();
  });

  test("a cap larger than an INTEGER is refused by the guard and by the column", async () => {
    const huge: Budget = conformanceBudget(scope, "dd000000-0002-4000-8000-000000000001", "scope", {
      limitCents: 10_000_000_000,
    });
    expect(
      await refusalOf(() =>
        runResult(harness.base.adapter.unitOfWork, (transaction) =>
          harness.repository.insertBudget(huge, transaction),
        ),
      ),
    ).toBe(BUDGET_LIMIT_OUT_OF_RANGE);
    await expect(
      harness.base.client.budget.create({
        data: rawBudget({ limitCents: 10_000_000_000 }) as never,
      }),
    ).rejects.toThrow();
  });

  test("a zero threshold is refused HERE and accepted by the database", async () => {
    // The asymmetry is the finding. `Budget_alertThresholds_json_root` checks
    // `jsonb_typeof(...) = 'array'` and nothing about the elements, so a cap
    // that fires the instant every window opens is a row the table will hold.
    const zero = conformanceBudget(scope, "dd000000-0003-4000-8000-000000000001", "scope", {
      alertThresholds: [0],
    });
    expect(
      await refusalOf(() =>
        runResult(harness.base.adapter.unitOfWork, (transaction) =>
          harness.repository.insertBudget(zero, transaction),
        ),
      ),
    ).toBe(BUDGET_THRESHOLDS_INVALID);
    const written = await harness.base.client.budget.create({
      data: rawBudget({
        id: "dd000000-0003-4000-8000-000000000002",
        alertThresholds: [0],
      }) as never,
    });
    expect(written.alertThresholds).toEqual([0]);
    // The ROOT check does bite, though: a scalar is refused outright.
    await expect(
      harness.base.client.budget.create({
        data: rawBudget({ id: "dd000000-0003-4000-8000-000000000003", alertThresholds: "50" }) as never,
      }),
    ).rejects.toThrow();
  });

  test("a threshold that is not a whole number is refused on the way OUT", async () => {
    await harness.base.client.budget.create({
      data: rawBudget({
        id: "dd000000-0004-4000-8000-000000000001",
        alertThresholds: [{ percent: 50 }],
      }) as never,
    });
    expect(
      await refusalOf(() =>
        harness.repository.findBudget(scope, asCostIdentifier("dd000000-0004-4000-8000-000000000001")),
      ),
    ).toBe(UNREADABLE_ALERT_THRESHOLDS);
  });

  test("a period this binary has no arithmetic for is refused on the way OUT", async () => {
    // `Budget.period` carries no CHECK at all, so the table will hold anything.
    await harness.base.client.budget.create({
      data: rawBudget({ id: "dd000000-0005-4000-8000-000000000001", period: "fortnight" }) as never,
    });
    expect(
      await refusalOf(() =>
        harness.repository.findBudget(scope, asCostIdentifier("dd000000-0005-4000-8000-000000000001")),
      ),
    ).toBe(UNKNOWN_BUDGET_PERIOD);
  });
});

describe("a crossing's values, and the amount its column cannot carry", () => {
  const crossingBase = {
    environmentId: "",
    budgetId: "",
    windowKey: "2026-06-01",
    threshold: 50,
    spentCents: 10,
    runs: 1,
    createdAt: AT,
  };

  let capId: string;

  beforeAll(async () => {
    capId = "dd000000-0006-4000-8000-000000000001";
    await runResult(harness.base.adapter.unitOfWork, (transaction) =>
      harness.repository.insertBudget(conformanceBudget(scope, capId, "scope"), transaction),
    );
  });

  test("a non-positive threshold is refused by the guard and by the check", async () => {
    const crossing: ThresholdEvent = {
      eventId: asCostIdentifier("dd000000-0007-4000-8000-000000000001"),
      environmentId: asCostIdentifier(scope.environmentId),
      budgetId: asCostIdentifier(capId),
      windowKey: asCostIdentifier("2026-06-01"),
      threshold: 0,
      spent: { microCents: 10_000_000n, currency: asCostIdentifier("USD") },
      tasks: 1,
      createdAt: AT,
    };
    expect(
      await refusalOf(() =>
        runResult(harness.base.adapter.unitOfWork, (transaction) =>
          harness.repository.insertThresholdEvent(crossing, transaction),
        ),
      ),
    ).toBe(CROSSING_VALUES_INVALID);
    await expect(
      harness.base.client.budgetThresholdEvent.create({
        data: {
          ...crossingBase,
          id: "dd000000-0007-4000-8000-000000000002",
          environmentId: scope.environmentId,
          budgetId: capId,
          threshold: 0,
        } as never,
      }),
    ).rejects.toThrow();
  });

  test("an exact amount the DOUBLE PRECISION column cannot hold is refused", async () => {
    // `ThresholdEvent.spent` is `Decimal(18, 6)` in a bigint; `spentCents` is a
    // binary float with about fifteen significant digits. The row is immutable,
    // so a spend recorded inexactly stays inexact forever.
    const unrepresentable: ThresholdEvent = {
      eventId: asCostIdentifier("dd000000-0008-4000-8000-000000000001"),
      environmentId: asCostIdentifier(scope.environmentId),
      budgetId: asCostIdentifier(capId),
      windowKey: asCostIdentifier("2026-06-02"),
      threshold: 50,
      spent: { microCents: 123_456_789_012_345_678n, currency: asCostIdentifier("USD") },
      tasks: 1,
      createdAt: AT,
    };
    expect(
      await refusalOf(() =>
        runResult(harness.base.adapter.unitOfWork, (transaction) =>
          harness.repository.insertThresholdEvent(unrepresentable, transaction),
        ),
      ),
    ).toBe(CROSSING_SPEND_NOT_REPRESENTABLE);
    // And this is what the column does when nothing refuses: the figure written
    // and the figure read back are different numbers.
    const spentCents = 123_456_789_012.345_678;
    const row = await harness.base.client.budgetThresholdEvent.create({
      data: {
        ...crossingBase,
        id: "dd000000-0008-4000-8000-000000000002",
        environmentId: scope.environmentId,
        budgetId: capId,
        windowKey: "2026-06-03",
        spentCents,
      } as never,
    });
    expect(BigInt(Math.round(row.spentCents * 1_000_000))).not.toBe(123_456_789_012_345_678n);
  });
});

describe("a channel's name, topics and deduplication shape", () => {
  const channelBase = {
    type: "EMAIL" as const,
    name: "ops",
    enabled: true,
    alertTypes: ["BUDGET"],
    deduplicationKey: null,
    userProvidedDeduplicationKey: false,
    createdAt: AT,
    updatedAt: AT,
  };

  test("a blank name is refused by the guard and by AlertChannel_name_check", async () => {
    expect(
      await refusalOf(() =>
        runResult(harness.base.adapter.unitOfWork, (transaction) =>
          harness.repository.insertAlertChannel(
            conformanceChannel(scope, "dd000000-0009-4000-8000-000000000001", { name: "   " }),
            transaction,
          ),
        ),
      ),
    ).toBe(CHANNEL_NAME_INVALID);
    await expect(
      harness.base.client.alertChannel.create({
        data: {
          ...channelBase,
          id: "dd000000-0009-4000-8000-000000000002",
          environmentId: scope.environmentId,
          name: "   ",
        } as never,
      }),
    ).rejects.toThrow();
  });

  test("the topics column's own DEFAULT violates the check that guards it", async () => {
    expect(
      await refusalOf(() =>
        runResult(harness.base.adapter.unitOfWork, (transaction) =>
          harness.repository.insertAlertChannel(
            conformanceChannel(scope, "dd000000-000a-4000-8000-000000000001", { topics: [] }),
            transaction,
          ),
        ),
      ),
    ).toBe(CHANNEL_TOPICS_EMPTY);
    // `alertTypes TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[]` with
    // `CHECK (cardinality("alertTypes") > 0)`: an INSERT that leaves the column
    // to its default is refused by the row it just defaulted.
    const { alertTypes: _omitted, ...withoutTopics } = channelBase;
    await expect(
      harness.base.client.alertChannel.create({
        data: {
          ...withoutTopics,
          id: "dd000000-000a-4000-8000-000000000002",
          environmentId: scope.environmentId,
        } as never,
      }),
    ).rejects.toThrow();
  });

  test("a channel with no key may not claim an operator supplied one", async () => {
    expect(
      await refusalOf(() =>
        runResult(harness.base.adapter.unitOfWork, (transaction) =>
          harness.repository.insertAlertChannel(
            conformanceChannel(scope, "dd000000-000b-4000-8000-000000000001", {
              deduplicationKey: null,
              operatorSuppliedKey: true,
            }),
            transaction,
          ),
        ),
      ),
    ).toBe(CHANNEL_DEDUPE_SHAPE_INVALID);
    await expect(
      harness.base.client.alertChannel.create({
        data: {
          ...channelBase,
          id: "dd000000-000b-4000-8000-000000000002",
          environmentId: scope.environmentId,
          userProvidedDeduplicationKey: true,
        } as never,
      }),
    ).rejects.toThrow();
  });
});

describe("a delivery's kind, its state, and its send record", () => {
  let channelId: string;

  beforeAll(async () => {
    channelId = "dd000000-000c-4000-8000-000000000001";
    await runResult(harness.base.adapter.unitOfWork, (transaction) =>
      harness.repository.insertAlertChannel(conformanceChannel(scope, channelId), transaction),
    );
  });

  const deliveryBase = {
    kind: "BUDGET" as const,
    idempotencyKey: "raw",
    status: "PENDING" as const,
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
  };

  function domainDelivery(id: string, overrides: Record<string, unknown>): never {
    return {
      deliveryId: asCostIdentifier(id),
      environmentId: asCostIdentifier(scope.environmentId),
      channelId: asCostIdentifier(channelId),
      eventId: null,
      kind: "BUDGET",
      idempotencyKey: asCostIdentifier(`raw:${id}`),
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
    } as never;
  }

  test("a BUDGET delivery belonging to no crossing is refused both ways", async () => {
    expect(
      await refusalOf(() =>
        runResult(harness.base.adapter.unitOfWork, (transaction) =>
          harness.repository.insertDelivery(
            domainDelivery("dd000000-000d-4000-8000-000000000001", {}),
            transaction,
          ),
        ),
      ),
    ).toBe(DELIVERY_KIND_SHAPE_INVALID);
    await expect(
      harness.base.client.alertDelivery.create({
        data: {
          ...deliveryBase,
          id: "dd000000-000d-4000-8000-000000000002",
          environmentId: scope.environmentId,
          channelId,
          budgetThresholdEventId: null,
          idempotencyKey: "raw-kind",
        } as never,
      }),
    ).rejects.toThrow();
  });

  test("a SUCCEEDED delivery still carrying a failure token is refused both ways", async () => {
    // `domain/alert-delivery.ts`'s `settle` copies `outcome.errorCode` whatever
    // the outcome says about success, so an outcome assembled with `ok: true`
    // and a token produces exactly this row. The double writes it.
    expect(
      await refusalOf(() =>
        runResult(harness.base.adapter.unitOfWork, (transaction) =>
          harness.repository.insertDelivery(
            domainDelivery("dd000000-000e-4000-8000-000000000001", {
              kind: "TEST",
              status: "SUCCEEDED",
              deliveredAt: AT,
              lastErrorCode: "transport_refused",
            }),
            transaction,
          ),
        ),
      ),
    ).toBe(DELIVERY_STATE_INCOHERENT);
    await expect(
      harness.base.client.alertDelivery.create({
        data: {
          ...deliveryBase,
          id: "dd000000-000e-4000-8000-000000000002",
          environmentId: scope.environmentId,
          channelId,
          budgetThresholdEventId: null,
          kind: "TEST",
          status: "SUCCEEDED",
          deliveredAt: AT,
          lastErrorCode: "transport_refused",
          idempotencyKey: "raw-state",
        } as never,
      }),
    ).rejects.toThrow();
  });

  test("a send record numbered from zero is refused both ways", async () => {
    const settled = domainDelivery("dd000000-000f-4000-8000-000000000001", {
      kind: "TEST",
      status: "SUCCEEDED",
      deliveredAt: AT,
      retryCount: 1,
    });
    expect(
      await refusalOf(() =>
        runResult(harness.base.adapter.unitOfWork, (transaction) =>
          harness.repository.settleDelivery(
            settled,
            {
              deliveryId: asCostIdentifier("dd000000-000f-4000-8000-000000000001"),
              environmentId: asCostIdentifier(scope.environmentId),
              retryNumber: 0,
              status: "SUCCEEDED",
              responseStatus: 200,
              errorCode: null,
              errorMessage: null,
              startedAt: AT,
              finishedAt: AT,
            },
            transaction,
          ),
        ),
      ),
    ).toBe(RETRY_RECORD_INVALID);
    await expect(
      harness.base.client.alertDeliveryRetry.create({
        data: {
          id: "dd000000-000f-4000-8000-000000000002",
          environmentId: scope.environmentId,
          deliveryId: "dd000000-000f-4000-8000-000000000001",
          retryNumber: 0,
          status: "SUCCEEDED",
          responseStatus: 200,
          errorCode: null,
          errorMessage: null,
          startedAt: AT,
          finishedAt: AT,
        } as never,
      }),
    ).rejects.toThrow();
  });
});
