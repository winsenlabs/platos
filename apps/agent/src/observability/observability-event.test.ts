import { describe, expect, test } from "vitest";
import {
  attributesJson,
  clickhouseDateTime,
  decimal12,
  decodeRows,
  durationMs,
  emptyRows,
  laneCosts,
  nullableDecimal12,
  projectTurn,
  resolveLanes,
  rowCount,
  stepRow,
  toolCallRow,
  turnRow,
  usageRow,
  usdFromCents,
  usdPerMillion,
  uuidOrNil,
  type StepObserved,
  type ToolCallObserved,
  type TurnObserved,
  type UsageObserved,
} from "./observability-event";

const scope = {
  organizationId: "org-1",
  projectId: "proj-1",
  environmentId: "env-1",
};

const TURN_ID = "11111111-1111-4111-8111-111111111111";
const STEP_ID = "22222222-2222-4222-8222-222222222222";
const TOOL_CALL_ID = "33333333-3333-4333-8333-333333333333";
const USAGE_ID = "44444444-4444-4444-8444-444444444444";

function turn(overrides: Partial<TurnObserved> = {}): TurnObserved {
  return {
    scope,
    turnId: TURN_ID,
    threadId: "thread-1",
    agentId: "agent-1",
    status: "completed",
    acceptedAt: new Date("2026-08-20T10:00:00.000Z"),
    completedAt: new Date("2026-08-20T10:00:02.500Z"),
    ...overrides,
  };
}

function step(overrides: Partial<StepObserved> = {}): StepObserved {
  return {
    scope,
    stepId: STEP_ID,
    turnId: TURN_ID,
    threadId: "thread-1",
    agentId: "agent-1",
    sequence: 1,
    provider: "anthropic",
    model: "claude-sonnet",
    status: "completed",
    startedAt: new Date("2026-08-20T10:00:00.000Z"),
    completedAt: new Date("2026-08-20T10:00:02.000Z"),
    ...overrides,
  };
}

describe("decimal formatting", () => {
  test("never emits exponent notation, which ClickHouse cannot parse", () => {
    // `String(0.0000001)` is "1e-7", and one unparseable column rejects the
    // whole batch.
    expect(decimal12(0.0000001)).toBe("0.000000100000");
    expect(decimal12(0.0000001)).not.toMatch(/e/i);
    expect(usdPerMillion(0.0000001)).toBe("0.100000000000");
    expect(usdPerMillion(0.000003)).toBe("3.000000000000");
  });

  test("carries twelve fractional digits, matching the column's scale", () => {
    expect(decimal12(1)).toBe("1.000000000000");
    expect(usdFromCents(25)).toBe("0.250000000000");
    expect(usdFromCents(0.000125)).toBe("0.000001250000");
  });

  test("absent money stays absent instead of becoming a confident zero", () => {
    expect(nullableDecimal12(undefined)).toBeNull();
    expect(nullableDecimal12(null)).toBeNull();
    expect(nullableDecimal12(0)).toBe("0.000000000000");
  });

  test("non-finite and absent inputs collapse to zero rather than NaN", () => {
    expect(decimal12(Number.NaN)).toBe("0.000000000000");
    expect(decimal12(Number.POSITIVE_INFINITY)).toBe("0.000000000000");
    expect(usdFromCents(undefined)).toBe("0.000000000000");
    expect(usdPerMillion(null)).toBe("0.000000000000");
  });

  test("clamps rather than rejecting a value the column could not hold", () => {
    // One absurd number in a delivered batch beats a batch of good rows
    // blocked behind it.
    expect(decimal12(1e30)).toBe("999999999999.999877929688");
    expect(decimal12(-1e30)).toBe("-999999999999.999877929688");
  });

  test("a clamped value fits the 12 integer digits Decimal(24, 12) holds", () => {
    // The clamp used to land ON 1e12, which renders thirteen integer digits —
    // unparseable by the very column it was clamped for, and ClickHouse rejects
    // the ENTIRE batch when one column fails to parse. The row is frozen in the
    // outbox and replayed, so that batch failed on every retry until it parked.
    for (const value of [1e30, -1e30, 1e12, -1e12, Number.MAX_VALUE, 1e14 / 100]) {
      const rendered = decimal12(value);
      const [integer, fraction] = rendered.replace("-", "").split(".");
      expect(integer.length, `${value} rendered as ${rendered}`).toBeLessThanOrEqual(12);
      expect(fraction).toHaveLength(12);
    }
  });

  test("costs and rates at the bound clamp into range too", () => {
    // The three reachable doors: costCents >= 1e14, providerReportedCostUsd
    // >= 1e12, usdPerToken >= 1e6.
    expect(usdFromCents(1e14).split(".")[0]).toHaveLength(12);
    expect(nullableDecimal12(1e13)!.split(".")[0]).toHaveLength(12);
    expect(usdPerMillion(1e9).split(".")[0]).toHaveLength(12);
  });
});

describe("timestamps and ids", () => {
  test("formats DateTime64(6) with microsecond places and no zone suffix", () => {
    expect(clickhouseDateTime(new Date("2026-08-20T10:00:02.500Z")))
      .toBe("2026-08-20 10:00:02.500000");
  });

  test("never returns a negative duration", () => {
    const later = new Date("2026-08-20T10:00:02.000Z");
    const earlier = new Date("2026-08-20T10:00:00.000Z");
    expect(durationMs(earlier, later)).toBe(2000);
    expect(durationMs(later, earlier)).toBe(0);
    expect(durationMs(undefined, later)).toBe(0);
  });

  test("substitutes the nil uuid rather than letting one bad id fail the batch", () => {
    expect(uuidOrNil(TURN_ID)).toBe(TURN_ID);
    expect(uuidOrNil("not-a-uuid")).toBe("00000000-0000-0000-0000-000000000000");
    expect(uuidOrNil(undefined)).toBe("00000000-0000-0000-0000-000000000000");
  });
});

describe("cache lane arithmetic", () => {
  test("treats cache counters as a subset of reported input, never an addition", () => {
    // The 39,795-vs-14,788 defect class: input is INCLUSIVE of the cache slice,
    // so fresh is the remainder and nothing adds the counters back.
    const lanes = resolveLanes({
      inputTokens: 40_000,
      cacheReadInputTokens: 39_795,
      cacheWriteInputTokens: 100,
      outputTokens: 500,
    });
    expect(lanes.totalInput).toBe(40_000);
    expect(lanes.freshInput).toBe(105);
    expect(lanes.cacheRead + lanes.cacheWrite + lanes.freshInput).toBe(lanes.totalInput);
  });

  test("clamps a provider reporting more cache than input, so fresh never goes negative", () => {
    const lanes = resolveLanes({ inputTokens: 100, cacheReadInputTokens: 500 });
    expect(lanes.cacheRead).toBe(100);
    expect(lanes.cacheWrite).toBe(0);
    expect(lanes.freshInput).toBe(0);
  });

  test("floors fractional and drops absent token counts", () => {
    const lanes = resolveLanes({ inputTokens: 10.9, outputTokens: undefined, reasoningTokens: -5 });
    expect(lanes.totalInput).toBe(10);
    expect(lanes.output).toBe(0);
    expect(lanes.reasoning).toBe(0);
  });

  test("prices each lane against its own rate", () => {
    const lanes = resolveLanes({
      inputTokens: 1_000,
      cacheReadInputTokens: 600,
      cacheWriteInputTokens: 200,
      outputTokens: 100,
    });
    const costs = laneCosts(lanes, {
      inputUsdPerToken: 0.000003,
      outputUsdPerToken: 0.000015,
      cacheReadUsdPerToken: 0.0000003,
      cacheWriteUsdPerToken: 0.00000375,
    });
    expect(costs.freshInput).toBe("0.000600000000"); // 200 fresh * 3e-6
    expect(costs.cacheRead).toBe("0.000180000000"); // 600 * 3e-7
    expect(costs.cacheWrite).toBe("0.000750000000"); // 200 * 3.75e-6
    expect(costs.output).toBe("0.001500000000"); // 100 * 1.5e-5
  });

  test("a missing rate prices its lane at zero rather than guessing", () => {
    const lanes = resolveLanes({ inputTokens: 1_000, outputTokens: 100 });
    expect(laneCosts(lanes, undefined)).toEqual({
      freshInput: "0.000000000000",
      cacheRead: "0.000000000000",
      cacheWrite: "0.000000000000",
      output: "0.000000000000",
    });
  });
});

describe("turn rows", () => {
  test("never writes billable_unit, because the server derives it from status", () => {
    // This is what makes "one completed Turn is one billable unit regardless of
    // Step count" true by construction rather than by convention.
    expect(Object.keys(turnRow(turn()))).not.toContain("billable_unit");
    expect(turnRow(turn({ status: "failed" })).status).toBe("failed");
  });

  test("reports the same input total the provider billed, cache included", () => {
    const row = turnRow(turn({
      tokens: { inputTokens: 40_000, cacheReadInputTokens: 39_795, outputTokens: 500 },
    }));
    expect(row.total_input_tokens).toBe(40_000);
    expect(row.cache_read_input_tokens).toBe(39_795);
    expect(row.total_output_tokens).toBe(500);
  });

  test("converts the stored cents into the column's dollars", () => {
    expect(turnRow(turn({ costCents: 12.5 })).calculated_cost_usd).toBe("0.125000000000");
  });

  test("counts Steps and Tool Calls without letting either change the billable unit", () => {
    const row = turnRow(turn({ stepCount: 4, toolCallCount: 9 }));
    expect(row.step_count).toBe(4);
    expect(row.tool_call_count).toBe(9);
  });
});

describe("identity", () => {
  test("carries the hash as the join key and the canonical id separately", () => {
    const row = turnRow(turn({
      subject: {
        endUserId: "enduser-1",
        subjectKeyHash: "a".repeat(64),
        userDisplayName: "Ada Lovelace",
        userEmail: "ada@example.test",
      },
    }));
    expect(row.subject_key_hash).toBe("a".repeat(64));
    expect(row.end_user_id).toBe("enduser-1");
    expect(row.user_display_name).toBe("Ada Lovelace");
    expect(row.user_email).toBe("ada@example.test");
  });

  test("omits plaintext identity entirely when no entity signed for it", () => {
    const row = turnRow(turn({ subject: { endUserId: "enduser-1", subjectKeyHash: "abc" } }));
    expect(row.user_display_name).toBeNull();
    expect(row.user_email).toBeNull();
  });

  test("collapses blank plaintext to null so erasure verification stays meaningful", () => {
    // Verification counts rows where `coalesce(col, '') != ''`. A whitespace
    // display name would answer a question about whitespace, not identity.
    const row = turnRow(turn({
      subject: { endUserId: "", subjectKeyHash: "abc", userDisplayName: "   ", userEmail: "" },
    }));
    expect(row.user_display_name).toBeNull();
    expect(row.user_email).toBeNull();
  });

  test("never puts plaintext identity on a Step, Tool Call or usage row", () => {
    // Only turns_v1 carries plaintext, which is what the erasure plan asserts:
    // the other three tables clear end_user_id and nothing else.
    const subject = {
      endUserId: "enduser-1",
      subjectKeyHash: "abc",
      userDisplayName: "Ada",
      userEmail: "ada@example.test",
    };
    for (const row of [
      stepRow(step({ subject })),
      toolCallRow({
        scope,
        toolCallId: TOOL_CALL_ID,
        stepId: STEP_ID,
        turnId: TURN_ID,
        threadId: "thread-1",
        agentId: "agent-1",
        subject,
        sequence: 1,
        toolName: "remember",
        status: "completed",
        startedAt: new Date(0),
        completedAt: new Date(0),
      } satisfies ToolCallObserved),
      usageRow({
        scope,
        usageEventId: USAGE_ID,
        agentId: "agent-1",
        subject,
        usageKind: "inference",
        provider: "anthropic",
        occurredAt: new Date(0),
      } satisfies UsageObserved),
    ]) {
      const serialized = JSON.stringify(row);
      expect(serialized).not.toContain("Ada");
      expect(serialized).not.toContain("ada@example.test");
      expect(row.subject_key_hash).toBe("abc");
      expect(row.end_user_id).toBe("enduser-1");
    }
  });
});

describe("attributes", () => {
  test("keeps allow-listed scalars and drops everything else", () => {
    const json = attributesJson({
      finish_reason: "stop",
      retry_count: 2,
      truncated: false,
      // @ts-expect-error a key nobody reviewed must not survive the boundary
      prompt: "the actual user prompt",
    });
    expect(JSON.parse(json)).toEqual({ finish_reason: "stop", retry_count: 2, truncated: false });
    expect(json).not.toContain("prompt");
  });

  test("drops nested values, which is where an unreviewed payload would hide", () => {
    const json = attributesJson({
      // @ts-expect-error nested values are not a shape any allow-listed key has
      finish_reason: { nested: "tool result" },
    });
    expect(JSON.parse(json)).toEqual({});
  });

  test("defaults to an empty object rather than null", () => {
    expect(attributesJson(undefined)).toBe("{}");
    expect(stepRow(step()).attributes_json).toBe("{}");
  });
});

describe("usage rows", () => {
  test("leaves the parent ids null for work that belongs to no Turn", () => {
    const row = usageRow({
      scope,
      usageEventId: USAGE_ID,
      agentId: "agent-1",
      usageKind: "extraction",
      provider: "openai",
      occurredAt: new Date("2026-08-20T10:00:00.000Z"),
    });
    expect(row.turn_id).toBeNull();
    expect(row.step_id).toBeNull();
    expect(row.tool_call_id).toBeNull();
    expect(row.usage_kind).toBe("extraction");
  });
});

describe("payload round trip", () => {
  test("projects a Turn into one row per table level", () => {
    const rows = projectTurn({
      turn: turn(),
      steps: [step()],
      toolCalls: [{
        scope,
        toolCallId: TOOL_CALL_ID,
        stepId: STEP_ID,
        turnId: TURN_ID,
        threadId: "thread-1",
        agentId: "agent-1",
        sequence: 1,
        toolName: "remember",
        status: "completed",
        startedAt: new Date(0),
        completedAt: new Date(0),
      }],
      usage: [{
        scope,
        usageEventId: USAGE_ID,
        agentId: "agent-1",
        usageKind: "inference",
        provider: "anthropic",
        occurredAt: new Date(0),
      }],
    });
    expect(rowCount(rows)).toBe(4);
    expect(rows.turns_v1).toHaveLength(1);
    expect(rows.steps_v1).toHaveLength(1);
    expect(rows.tool_calls_v1).toHaveLength(1);
    expect(rows.usage_events_v1).toHaveLength(1);
  });

  test("survives a JSON round trip unchanged, because the outbox stores it as one", () => {
    const rows = projectTurn({ turn: turn(), steps: [step()] });
    expect(decodeRows(JSON.parse(JSON.stringify(rows)))).toEqual(rows);
  });

  test("refuses a payload that is not the shape this writer wrote", () => {
    // The Json column in this schema has repeatedly been found holding a string
    // scalar; a drain that trusts it crashes the whole pass on one bad row.
    expect(decodeRows("{}")).toBeNull();
    expect(decodeRows(null)).toBeNull();
    expect(decodeRows([])).toBeNull();
    expect(decodeRows({ turns_v1: "not-an-array" })).toBeNull();
    expect(decodeRows({ turns_v1: ["not-an-object"] })).toBeNull();
  });

  test("tolerates a payload missing a table, treating it as no rows", () => {
    expect(decodeRows({ turns_v1: [] })).toEqual(emptyRows());
    expect(decodeRows({})).toEqual(emptyRows());
  });
});
