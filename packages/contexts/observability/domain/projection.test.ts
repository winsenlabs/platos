import { asIdentifier, environmentScope, type EnvironmentScope } from "@platos/kernel";
import { describe, expect, it } from "vitest";

import { NIL_UUID } from "./column-values.js";
import type {
  EndUserId,
  SpanId,
  StepId,
  SubjectKeyHash,
  ToolCallId,
  TraceId,
  TurnId,
  UsageEventId,
} from "./identifiers.js";
import {
  firstScopeDisagreement,
  type StepObserved,
  type ToolCallObserved,
  type TurnObserved,
  type TurnWork,
  type UsageObserved,
} from "./observed-work.js";
import {
  addressedEndUserId,
  projectTurnWork,
  stepRow,
  toolCallRow,
  turnRow,
  usageRow,
} from "./projection.js";
import { PROJECTION_TABLES, populatedTables, projectionRowCount } from "./projection-tables.js";

// Well-formed uuids, so `uuidOrNil` does not quietly substitute the nil one and
// hide the very substitution these tests are checking for.
const TURN_UUID = "11111111-1111-4111-8111-111111111111";
const STEP_UUID = "22222222-2222-4222-8222-222222222222";
const TOOL_CALL_UUID = "33333333-3333-4333-8333-333333333333";
const USAGE_UUID = "44444444-4444-4444-8444-444444444444";

function scope(environmentId = "env-1", organizationId = "org-1"): EnvironmentScope {
  return environmentScope(
    asIdentifier(organizationId),
    asIdentifier("proj-1"),
    asIdentifier(environmentId),
  );
}

function aTurn(overrides: Partial<TurnObserved> = {}): TurnObserved {
  return {
    scope: scope(),
    turnId: asIdentifier<TurnId>(TURN_UUID),
    threadId: asIdentifier("thread-1"),
    agentId: asIdentifier("agent-1"),
    status: "completed",
    acceptedAt: new Date("2026-01-01T00:00:00.000Z"),
    completedAt: new Date("2026-01-01T00:00:02.500Z"),
    stepCount: 1,
    tokens: { inputTokens: 1_000, outputTokens: 250, cacheReadInputTokens: 400 },
    costCents: 125,
    ...overrides,
  };
}

function aStep(overrides: Partial<StepObserved> = {}): StepObserved {
  return {
    scope: scope(),
    stepId: asIdentifier<StepId>(STEP_UUID),
    turnId: asIdentifier<TurnId>(TURN_UUID),
    threadId: asIdentifier("thread-1"),
    agentId: asIdentifier("agent-1"),
    sequence: 0,
    provider: "provider-a",
    model: "model-a",
    status: "completed",
    startedAt: new Date("2026-01-01T00:00:00.000Z"),
    completedAt: new Date("2026-01-01T00:00:02.000Z"),
    tokens: { inputTokens: 1_000, outputTokens: 250, cacheReadInputTokens: 400 },
    rates: {
      pricingSource: "catalogue",
      pricingVersion: "price-1",
      inputUsdPerToken: 0.000_003,
      outputUsdPerToken: 0.000_015,
    },
    costCents: 125,
    ...overrides,
  };
}

function aToolCall(overrides: Partial<ToolCallObserved> = {}): ToolCallObserved {
  return {
    scope: scope(),
    toolCallId: asIdentifier<ToolCallId>(TOOL_CALL_UUID),
    stepId: asIdentifier<StepId>(STEP_UUID),
    turnId: asIdentifier<TurnId>(TURN_UUID),
    threadId: asIdentifier("thread-1"),
    agentId: asIdentifier("agent-1"),
    sequence: 0,
    toolName: "search",
    status: "completed",
    startedAt: new Date("2026-01-01T00:00:00.500Z"),
    completedAt: new Date("2026-01-01T00:00:01.000Z"),
    ...overrides,
  };
}

function aUsage(overrides: Partial<UsageObserved> = {}): UsageObserved {
  return {
    scope: scope(),
    usageEventId: asIdentifier<UsageEventId>(USAGE_UUID),
    agentId: asIdentifier("agent-1"),
    usageKind: "inference",
    provider: "provider-a",
    occurredAt: new Date("2026-01-01T00:00:02.000Z"),
    tokens: { inputTokens: 1_000, outputTokens: 250 },
    costCents: 125,
    ...overrides,
  };
}

function work(overrides: Partial<TurnWork> = {}): TurnWork {
  return { turn: aTurn(), steps: [aStep()], toolCalls: [], usage: [], ...overrides };
}

describe("turnRow", () => {
  it("carries the tenancy triple every aggregate is keyed by", () => {
    const row = turnRow(aTurn());
    expect(row.organization_id).toBe("org-1");
    expect(row.project_id).toBe("proj-1");
    expect(row.environment_id).toBe("env-1");
  });

  it("omits billable_unit, which the server derives from status", () => {
    expect(Object.keys(turnRow(aTurn()))).not.toContain("billable_unit");
  });

  it("stores the reported input total, not the sum of the lanes", () => {
    const row = turnRow(aTurn());
    expect(row.total_input_tokens).toBe(1_000);
    expect(row.cache_read_input_tokens).toBe(400);
  });

  it("measures duration from accepted to completed", () => {
    expect(turnRow(aTurn()).duration_ms).toBe(2_500);
  });

  it("renders the billed cost from integer cents", () => {
    expect(turnRow(aTurn({ costCents: 125 })).calculated_cost_usd).toBe("1.250000000000");
  });

  it("leaves a provider-reported cost NULL when the provider reported none", () => {
    expect(turnRow(aTurn()).provider_reported_cost_usd).toBeNull();
  });

  it("carries the pseudonymous key and the canonical id in separate columns", () => {
    const row = turnRow(
      aTurn({
        subject: {
          endUserId: asIdentifier<EndUserId>("end-user-1"),
          subjectKeyHash: asIdentifier<SubjectKeyHash>("hash-1"),
        },
      }),
    );
    expect(row.end_user_id).toBe("end-user-1");
    expect(row.subject_key_hash).toBe("hash-1");
  });

  it("collapses a blank display name to NULL so residue means identity", () => {
    const row = turnRow(aTurn({ subject: { userDisplayName: "   ", userEmail: null } }));
    expect(row.user_display_name).toBeNull();
    expect(row.user_email).toBeNull();
  });

  it("puts the Turn's own span in root_span_id, never a parent span", () => {
    const row = turnRow(
      aTurn({ trace: { traceId: asIdentifier<TraceId>("trace-1"), spanId: asIdentifier<SpanId>("span-1") } }),
    );
    expect(row.root_span_id).toBe("span-1");
    expect(row.trace_id).toBe("trace-1");
  });

  it("substitutes the nil uuid for a malformed turn id rather than failing the batch", () => {
    expect(turnRow(aTurn({ turnId: asIdentifier<TurnId>("not-a-uuid") })).turn_id).toBe(NIL_UUID);
  });
});

describe("stepRow", () => {
  it("stores fresh input rather than leaving a reader to derive it", () => {
    const row = stepRow(aStep());
    expect(row.total_input_tokens).toBe(1_000);
    expect(row.fresh_input_tokens).toBe(600);
    expect(row.cache_read_input_tokens).toBe(400);
  });

  it("freezes the rates that were in force, as per-million figures", () => {
    const row = stepRow(aStep());
    expect(row.pricing_version).toBe("price-1");
    expect(row.fresh_input_usd_per_million).toBe("3.000000000000");
    expect(row.output_usd_per_million).toBe("15.000000000000");
  });

  it("keeps the billed cost authoritative and the lanes explanatory", () => {
    const row = stepRow(aStep());
    expect(row.calculated_cost_usd).toBe("1.250000000000");
    expect(row.fresh_input_cost_usd).toBe("0.001800000000");
  });

  it("truncates a redacted error message and carries no payload column", () => {
    const row = stepRow(aStep({ errorMessageRedacted: "x".repeat(900) }));
    expect(String(row.error_message_redacted)).toHaveLength(500);
    expect(Object.keys(row)).not.toContain("prompt");
  });

  it("renders attributes from the allow-list only", () => {
    const row = stepRow(aStep({ attributes: { finish_reason: "stop" } }));
    expect(row.attributes_json).toBe(JSON.stringify({ finish_reason: "stop" }));
  });
});

describe("toolCallRow", () => {
  it("keeps denied as a first-class outcome, not a kind of failure", () => {
    expect(toolCallRow(aToolCall({ status: "denied" })).status).toBe("denied");
  });

  it("records sizes, never payloads", () => {
    const row = toolCallRow(aToolCall({ requestBytes: 12, responseBytes: 3_400 }));
    expect(row.request_bytes).toBe(12);
    expect(row.response_bytes).toBe(3_400);
    expect(Object.keys(row)).not.toContain("arguments");
    expect(Object.keys(row)).not.toContain("result");
  });

  it("carries the parent span so a call can be placed inside its step", () => {
    const row = toolCallRow(
      aToolCall({ trace: { spanId: asIdentifier<SpanId>("span-2"), parentSpanId: asIdentifier<SpanId>("span-1") } }),
    );
    expect(row.parent_span_id).toBe("span-1");
  });
});

describe("usageRow", () => {
  it("leaves the parent ids NULL for auxiliary work that belongs to no Turn", () => {
    const row = usageRow(aUsage({ usageKind: "embedding" }));
    expect(row.turn_id).toBeNull();
    expect(row.step_id).toBeNull();
    expect(row.tool_call_id).toBeNull();
  });

  it("does not invent a nil-uuid parent, which would fabricate a relationship", () => {
    expect(usageRow(aUsage()).turn_id).not.toBe(NIL_UUID);
  });

  it("carries a parent when the work really had one", () => {
    const row = usageRow(aUsage({ turnId: asIdentifier<TurnId>(TURN_UUID), stepId: asIdentifier<StepId>(STEP_UUID) }));
    expect(row.turn_id).toBe(TURN_UUID);
    expect(row.step_id).toBe(STEP_UUID);
  });

  it("carries the non-token lanes for work priced per request or per run", () => {
    const row = usageRow(
      aUsage({ usageKind: "skill", inputUnits: 3, unitType: "run", inputUnitPriceUsd: 0.25 }),
    );
    expect(row.input_units).toBe("3.000000000000");
    expect(row.unit_type).toBe("run");
    expect(row.input_unit_price_usd).toBe("0.250000000000");
  });
});

describe("projectTurnWork", () => {
  it("produces one row per observed part, in the four canonical tables", () => {
    const rows = projectTurnWork(work({ toolCalls: [aToolCall()], usage: [aUsage()] }));
    expect(rows.turns_v1).toHaveLength(1);
    expect(rows.steps_v1).toHaveLength(1);
    expect(rows.tool_calls_v1).toHaveLength(1);
    expect(rows.usage_events_v1).toHaveLength(1);
    expect(projectionRowCount(rows)).toBe(4);
    expect(populatedTables(rows)).toEqual([...PROJECTION_TABLES]);
  });

  it("produces only a Turn row for a Turn that called nothing", () => {
    const rows = projectTurnWork({ turn: aTurn() });
    expect(projectionRowCount(rows)).toBe(1);
    expect(populatedTables(rows)).toEqual(["turns_v1"]);
  });
});

describe("addressedEndUserId", () => {
  it("reads the subject off the Turn row, the only table with plaintext identity", () => {
    const rows = projectTurnWork({
      turn: aTurn({ subject: { endUserId: asIdentifier<EndUserId>("end-user-9") } }),
    });
    expect(addressedEndUserId(rows)).toBe("end-user-9");
  });

  it("returns null rather than a blank, which would address every row in the tenant", () => {
    expect(addressedEndUserId(projectTurnWork({ turn: aTurn() }))).toBeNull();
  });
});

describe("firstScopeDisagreement", () => {
  it("accepts a Turn whose every part names the same environment", () => {
    expect(firstScopeDisagreement(work())).toBeNull();
  });

  it("names the first part that claims a different environment", () => {
    expect(firstScopeDisagreement(work({ steps: [aStep({ scope: scope("env-2") })] }))?.part).toBe(
      "steps[0]",
    );
  });

  it("catches a different organization even when the environment id matches", () => {
    expect(
      firstScopeDisagreement(work({ steps: [aStep({ scope: scope("env-1", "org-2") })] }))?.part,
    ).toBe("steps[0]");
  });

  it("checks tool calls and usage too, not only steps", () => {
    expect(
      firstScopeDisagreement(work({ steps: [], toolCalls: [aToolCall({ scope: scope("env-2") })] }))?.part,
    ).toBe("toolCalls[0]");
    expect(
      firstScopeDisagreement(work({ steps: [], usage: [aUsage({ scope: scope("env-2") })] }))?.part,
    ).toBe("usage[0]");
  });
});
