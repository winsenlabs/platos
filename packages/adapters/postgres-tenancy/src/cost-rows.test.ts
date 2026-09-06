// The mapping and the guards, with no database at all.
//
// EVERY CASE HERE IS PURE, and that is the division of labour this package uses
// throughout: what a row MEANS is decided by code that needs no container, and
// whether the database agrees is decided by `cost-constraints.integration.test.ts`.
// A refusal that only ever fired against PostgreSQL would be a refusal nobody
// could reason about; a refusal that only ever fired here would be a rule the
// store does not actually have. Both suites exist because both failures are
// real, and the constraints suite runs each of these guards against the CHECK it
// restates.

import { describe, expect, test } from "vitest";

import type {
  AgentId,
  AlertChannel,
  AlertDelivery,
  AlertDeliveryId,
  AlertDeliveryRetry,
  Budget,
  BudgetId,
  ClaimToken,
  EnvironmentScope,
  ThresholdEventId,
} from "@platos/context-cost-monitoring/application/ports/index.js";
import { asCostIdentifier, asIdentifier, environmentScope } from "@platos/context-cost-monitoring/application/ports/index.js";

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
  requireRetryRecord,
} from "./cost-guards.js";
import type { BudgetRow, ChannelRow, DeliveryRow } from "./cost-rows.js";
import {
  CHANNEL_CONFIGURATION_ABSENT,
  CHANNEL_CONFIGURATION_INCOHERENT,
  UNKNOWN_BUDGET_PERIOD,
  UNREADABLE_ALERT_THRESHOLDS,
  readBudget,
  readChannel,
  readCrossing,
  readDelivery,
  scopedWhere,
  writeBudget,
  writeChannel,
  writeConfiguration,
  writeCrossing,
  writeDelivery,
  writeRetry,
} from "./cost-rows.js";

const AT = new Date("2026-05-01T09:00:00.000Z");
const ENVIRONMENT = "11111111-1111-4111-8111-111111111111";
const CAP = "22222222-2222-4222-8222-222222222222";
const CHANNEL = "33333333-3333-4333-8333-333333333333";
const DELIVERY = "44444444-4444-4444-8444-444444444444";
const CREDENTIAL = "55555555-5555-4555-8555-555555555555";
const AGENT = "66666666-6666-4666-8666-666666666666";

const SCOPE: EnvironmentScope = environmentScope(
  asIdentifier("77777777-7777-4777-8777-777777777777"),
  asIdentifier("88888888-8888-4888-8888-888888888888"),
  asIdentifier(ENVIRONMENT),
);

function budgetRow(overrides: Partial<BudgetRow> = {}): BudgetRow {
  return {
    id: CAP,
    environmentId: ENVIRONMENT,
    agentId: null,
    scope: '{"scopeType":"user","targetId":"*","tier":"skill","skillSlug":"summarise"}',
    period: "week",
    limitCents: 5_000,
    turnsLimit: null,
    alertThresholds: [50, 80],
    enabled: true,
    overrideUntil: null,
    createdAt: AT,
    updatedAt: AT,
    ...overrides,
  };
}

function channelRow(overrides: Partial<ChannelRow> = {}): ChannelRow {
  return {
    id: CHANNEL,
    environmentId: ENVIRONMENT,
    type: "EMAIL",
    name: "ops",
    enabled: true,
    alertTypes: ["BUDGET"],
    deduplicationKey: null,
    userProvidedDeduplicationKey: false,
    createdAt: AT,
    updatedAt: AT,
    configuration: {
      email: "ops@example.test",
      webhookUrl: null,
      slackChannelId: null,
      slackChannelName: null,
      integrationId: null,
      credentialId: null,
    },
    ...overrides,
  };
}

function deliveryRow(overrides: Partial<DeliveryRow> = {}): DeliveryRow {
  return {
    id: DELIVERY,
    environmentId: ENVIRONMENT,
    channelId: CHANNEL,
    budgetThresholdEventId: null,
    kind: "TEST",
    idempotencyKey: "test:1",
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
  };
}

function budget(overrides: Partial<Budget> = {}): Budget {
  return {
    budgetId: asCostIdentifier(CAP),
    environmentId: asCostIdentifier(ENVIRONMENT),
    target: {
      subject: "scope",
      targetId: "",
      tier: "llm",
      skillSlug: null,
      agentId: null,
      legacyWebhookUrl: null,
      legacyEmails: null,
      overrideBy: null,
    },
    period: "day",
    limitCents: 1_000,
    runsLimit: 0,
    alertThresholds: [50],
    enabled: true,
    overrideUntil: null,
    createdAt: AT,
    updatedAt: AT,
    ...overrides,
  };
}

function channel(overrides: Partial<AlertChannel> = {}): AlertChannel {
  return {
    channelId: asCostIdentifier(CHANNEL),
    environmentId: asCostIdentifier(ENVIRONMENT),
    kind: "EMAIL",
    name: "ops",
    enabled: true,
    topics: ["BUDGET"],
    deduplicationKey: null,
    operatorSuppliedKey: false,
    configuration: { kind: "EMAIL", email: "ops@example.test" },
    createdAt: AT,
    updatedAt: AT,
    ...overrides,
  };
}

function delivery(overrides: Partial<AlertDelivery> = {}): AlertDelivery {
  return {
    deliveryId: asCostIdentifier(DELIVERY),
    environmentId: asCostIdentifier(ENVIRONMENT),
    channelId: asCostIdentifier(CHANNEL),
    eventId: null,
    kind: "TEST",
    idempotencyKey: asCostIdentifier("test:1"),
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
  };
}

function codeOf(work: () => unknown): string {
  try {
    work();
  } catch (error) {
    const code = (error as { readonly code?: unknown }).code;
    return typeof code === "string" ? code : `<uncoded:${String(error)}>`;
  }
  return "<no refusal>";
}

describe("a cap, read from its columns", () => {
  test("the encoded target is decoded and the agent id is joined to it", () => {
    const read = readBudget(budgetRow({ agentId: AGENT }));
    expect(read.target).toEqual({
      subject: "user",
      targetId: "*",
      tier: "skill",
      skillSlug: "summarise",
      // NOT in the encoded column — it is its own indexed foreign key, so the
      // decoder takes it as a separate parameter rather than inventing it.
      agentId: AGENT,
      legacyWebhookUrl: null,
      legacyEmails: null,
      overrideBy: null,
    });
  });

  test("a null turn ceiling reads as the domain's uncapped zero", () => {
    expect(readBudget(budgetRow({ turnsLimit: null })).runsLimit).toBe(0);
    expect(readBudget(budgetRow({ turnsLimit: 12 })).runsLimit).toBe(12);
  });

  test("a column that is not JSON governs the WHOLE environment, not nothing", () => {
    // The domain's own fallback, and the reason the decode is not this file's:
    // "the difference between 'caps everything' and 'caps nothing' is not a
    // serialisation detail".
    const read = readBudget(budgetRow({ scope: "not json at all" }));
    expect(read.target.subject).toBe("scope");
    expect(read.target.tier).toBe("llm");
  });

  test("a period this binary has no arithmetic for is refused, not defaulted", () => {
    expect(codeOf(() => readBudget(budgetRow({ period: "fortnight" })))).toBe(UNKNOWN_BUDGET_PERIOD);
  });

  test("thresholds that are not whole numbers are refused, not coerced", () => {
    expect(codeOf(() => readBudget(budgetRow({ alertThresholds: "50" })))).toBe(
      UNREADABLE_ALERT_THRESHOLDS,
    );
    expect(codeOf(() => readBudget(budgetRow({ alertThresholds: [50, "80"] })))).toBe(
      UNREADABLE_ALERT_THRESHOLDS,
    );
    expect(codeOf(() => readBudget(budgetRow({ alertThresholds: [50.5] })))).toBe(
      UNREADABLE_ALERT_THRESHOLDS,
    );
  });
});

describe("a cap, written to its columns", () => {
  test("the target is encoded and the agent id is lifted out of it", () => {
    const written = writeBudget(
      budget({
        target: {
          subject: "agent",
          targetId: "a-1",
          tier: "llm",
          skillSlug: null,
          agentId: asCostIdentifier<AgentId>(AGENT),
          legacyWebhookUrl: null,
          legacyEmails: null,
          overrideBy: null,
        },
      }),
    );
    expect(written.agentId).toBe(AGENT);
    expect(JSON.parse(written.scope)).toMatchObject({ scopeType: "agent", targetId: "a-1" });
  });

  test("a readable placeholder identifier is refused", () => {
    expect(codeOf(() => writeBudget(budget({ budgetId: asCostIdentifier<BudgetId>("budget-1") })))).toBe(
      IDENTIFIER_NOT_UUID,
    );
  });

  test("a ceiling outside the INTEGER column is refused", () => {
    expect(codeOf(() => writeBudget(budget({ limitCents: 10_000_000_000 })))).toBe(
      BUDGET_LIMIT_OUT_OF_RANGE,
    );
    expect(codeOf(() => writeBudget(budget({ runsLimit: -1 })))).toBe(BUDGET_LIMIT_OUT_OF_RANGE);
  });

  test("a threshold outside (0, 200] is refused", () => {
    expect(codeOf(() => writeBudget(budget({ alertThresholds: [0] })))).toBe(
      BUDGET_THRESHOLDS_INVALID,
    );
    expect(codeOf(() => writeBudget(budget({ alertThresholds: [201] })))).toBe(
      BUDGET_THRESHOLDS_INVALID,
    );
    // 200 is the ceiling and it is INCLUSIVE: an operator running a cap at 150%
    // under an override asked to hear about it.
    expect(writeBudget(budget({ alertThresholds: [200] })).alertThresholds).toEqual([200]);
  });
});

describe("a crossing, and the column that cannot hold every amount", () => {
  test("an exact cent figure survives the round trip", () => {
    const read = readCrossing({
      id: CAP,
      environmentId: ENVIRONMENT,
      budgetId: CAP,
      windowKey: "2026-05-01",
      threshold: 50,
      spentCents: 1234.5,
      runs: 7,
      createdAt: AT,
    });
    expect(read.spent.microCents).toBe(1_234_500_000n);
  });

  test("an amount the DOUBLE PRECISION column cannot carry is refused, not rounded", () => {
    expect(
      codeOf(() =>
        writeCrossingOf({ microCents: 123_456_789_012_345_678n }),
      ),
    ).toBe(CROSSING_SPEND_NOT_REPRESENTABLE);
  });

  test("a non-positive threshold and an empty window key are refused", () => {
    expect(codeOf(() => writeCrossingOf({ threshold: 0 }))).toBe(CROSSING_VALUES_INVALID);
    expect(codeOf(() => writeCrossingOf({ windowKey: "" }))).toBe(CROSSING_VALUES_INVALID);
  });
});

describe("a channel, both ways", () => {
  test("a channel with no configuration row cannot deliver and is not read", () => {
    expect(codeOf(() => readChannel(channelRow({ configuration: null })))).toBe(
      CHANNEL_CONFIGURATION_ABSENT,
    );
  });

  test("a configuration that does not address its kind is refused per kind", () => {
    expect(
      codeOf(() =>
        readChannel(channelRow({ configuration: { ...channelRow().configuration!, email: null } })),
      ),
    ).toBe(CHANNEL_CONFIGURATION_INCOHERENT);
    expect(
      codeOf(() =>
        readChannel(
          channelRow({
            type: "SLACK",
            configuration: { ...channelRow().configuration!, email: null },
          }),
        ),
      ),
    ).toBe(CHANNEL_CONFIGURATION_INCOHERENT);
    // A webhook with no credential is a webhook this adapter would hand to a
    // transport UNSIGNED, so it is unreadable rather than partially readable.
    expect(
      codeOf(() =>
        readChannel(
          channelRow({
            type: "WEBHOOK",
            configuration: {
              ...channelRow().configuration!,
              email: null,
              webhookUrl: "https://ops.example.test/hook",
              credentialId: null,
            },
          }),
        ),
      ),
    ).toBe(CHANNEL_CONFIGURATION_INCOHERENT);
  });

  test("each kind writes its own columns and nulls every other", () => {
    expect(writeConfiguration({ kind: "EMAIL", email: "a@b.test" })).toEqual({
      email: "a@b.test",
      webhookUrl: null,
      slackChannelId: null,
      slackChannelName: null,
      integrationId: null,
      credentialId: null,
    });
    expect(
      writeConfiguration({
        kind: "WEBHOOK",
        url: "https://ops.example.test/hook",
        credential: asCostIdentifier(CREDENTIAL),
      }),
    ).toMatchObject({ webhookUrl: "https://ops.example.test/hook", credentialId: CREDENTIAL });
  });

  test("a blank name, an empty topic list and a contradictory key are refused", () => {
    expect(codeOf(() => writeChannel(channel({ name: "  " })))).toBe(CHANNEL_NAME_INVALID);
    expect(codeOf(() => writeChannel(channel({ topics: [] })))).toBe(CHANNEL_TOPICS_EMPTY);
    expect(
      codeOf(() => writeChannel(channel({ deduplicationKey: null, operatorSuppliedKey: true }))),
    ).toBe(CHANNEL_DEDUPE_SHAPE_INVALID);
  });
});

describe("a delivery and its send record", () => {
  test("a row round-trips through both directions unchanged", () => {
    expect(readDelivery(deliveryRow())).toEqual(delivery());
  });

  test("a BUDGET row belonging to no crossing, and a TEST row claiming one, are refused", () => {
    expect(codeOf(() => writeDelivery(delivery({ kind: "BUDGET" })))).toBe(
      DELIVERY_KIND_SHAPE_INVALID,
    );
    expect(
      codeOf(() => writeDelivery(delivery({ kind: "TEST", eventId: asCostIdentifier<ThresholdEventId>(CAP) }))),
    ).toBe(DELIVERY_KIND_SHAPE_INVALID);
  });

  test("a SUCCEEDED row with no delivery instant, or with a failure token, is refused", () => {
    expect(codeOf(() => writeDelivery(delivery({ status: "SUCCEEDED" })))).toBe(
      DELIVERY_STATE_INCOHERENT,
    );
    expect(
      codeOf(() =>
        writeDelivery(delivery({ status: "SUCCEEDED", deliveredAt: AT, lastErrorCode: "refused" })),
      ),
    ).toBe(DELIVERY_STATE_INCOHERENT);
    expect(codeOf(() => writeDelivery(delivery({ status: "FAILED", deliveredAt: AT })))).toBe(
      DELIVERY_STATE_INCOHERENT,
    );
  });

  test("a claim token that is not a uuid is refused", () => {
    expect(codeOf(() => writeDelivery(delivery({ claimToken: asCostIdentifier<ClaimToken>("mine") })))).toBe(
      IDENTIFIER_NOT_UUID,
    );
  });

  test("the finish instant comes back FROM the guard that proved it present", () => {
    const record: AlertDeliveryRetry = {
      deliveryId: asCostIdentifier<AlertDeliveryId>(DELIVERY),
      environmentId: asCostIdentifier(ENVIRONMENT),
      retryNumber: 1,
      status: "SUCCEEDED" as const,
      responseStatus: 200,
      errorCode: null,
      errorMessage: null,
      startedAt: AT,
      finishedAt: new Date("2026-05-01T09:00:05.000Z"),
    };
    expect(requireRetryRecord(record)).toBe(record.finishedAt);
    expect(writeRetry(record).finishedAt).toBe(record.finishedAt);
    expect(codeOf(() => writeRetry({ ...record, finishedAt: null }))).toBe(RETRY_RECORD_INVALID);
    expect(codeOf(() => writeRetry({ ...record, retryNumber: 0 }))).toBe(RETRY_RECORD_INVALID);
    expect(codeOf(() => writeRetry({ ...record, errorCode: "refused" }))).toBe(
      RETRY_RECORD_INVALID,
    );
  });
});

describe("the scope predicate every read carries", () => {
  test("it names the whole tenant chain, not the environment alone", () => {
    // `environmentId` on its own would let a caller holding a grant for one
    // tenant read another's rows by supplying that tenant's environment id.
    expect(scopedWhere(SCOPE)).toEqual({
      environmentId: ENVIRONMENT,
      environment: {
        projectId: "88888888-8888-4888-8888-888888888888",
        project: { organizationId: "77777777-7777-4777-8777-777777777777" },
      },
    });
  });
});

/** A crossing written with one field replaced, so a case reads as one line. */
function writeCrossingOf(overrides: {
  readonly microCents?: bigint;
  readonly threshold?: number;
  readonly windowKey?: string;
}): unknown {
  return writeCrossing({
    eventId: asCostIdentifier(CAP),
    environmentId: asCostIdentifier(ENVIRONMENT),
    budgetId: asCostIdentifier(CAP),
    windowKey: asCostIdentifier(overrides.windowKey ?? "2026-05-01"),
    threshold: overrides.threshold ?? 50,
    spent: {
      microCents: overrides.microCents ?? 1_000_000n,
      currency: asCostIdentifier("USD"),
    },
    tasks: 1,
    createdAt: AT,
  });
}
