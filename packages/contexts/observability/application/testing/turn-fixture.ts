// A well-formed Turn, and the envelope payloads that describe one.
//
// Builders, not constants. Every test that cares about one field needs the other
// twenty to be valid and uninteresting, and a shared constant that each test
// spreads and overrides drifts into twenty subtly different Turns nobody can
// compare.

import { asIdentifier, type EnvironmentScope } from "@platos/kernel";

import type {
  AgentId,
  StepObserved,
  StepId,
  ThreadId,
  ToolCallId,
  ToolCallObserved,
  TurnId,
  TurnObserved,
  TurnWork,
  UsageEventId,
  UsageObserved,
} from "../../domain/index.js";
import { testScope } from "./fixtures.js";

/** Well-formed uuids, so `uuidOrNil` does not quietly substitute the nil one. */
export const TEST_TURN_UUID = "11111111-1111-4111-8111-111111111111";
export const TEST_STEP_UUID = "22222222-2222-4222-8222-222222222222";
export const TEST_TOOL_CALL_UUID = "33333333-3333-4333-8333-333333333333";
export const TEST_USAGE_UUID = "44444444-4444-4444-8444-444444444444";

export function testTurn(overrides: Partial<TurnObserved> = {}): TurnObserved {
  const scope: EnvironmentScope = overrides.scope ?? testScope();
  return {
    scope,
    turnId: asIdentifier<TurnId>(TEST_TURN_UUID),
    threadId: asIdentifier<ThreadId>("thread-1"),
    agentId: asIdentifier<AgentId>("agent-1"),
    status: "completed",
    acceptedAt: new Date("2026-01-01T00:00:00.000Z"),
    completedAt: new Date("2026-01-01T00:00:02.500Z"),
    stepCount: 1,
    toolCallCount: 0,
    tokens: { inputTokens: 1_000, outputTokens: 250, cacheReadInputTokens: 400 },
    costCents: 125,
    ...overrides,
  };
}

export function testStep(overrides: Partial<StepObserved> = {}): StepObserved {
  const scope: EnvironmentScope = overrides.scope ?? testScope();
  return {
    scope,
    stepId: asIdentifier<StepId>(TEST_STEP_UUID),
    turnId: asIdentifier<TurnId>(TEST_TURN_UUID),
    threadId: asIdentifier<ThreadId>("thread-1"),
    agentId: asIdentifier<AgentId>("agent-1"),
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
      cacheReadUsdPerToken: 0.000_000_3,
      cacheWriteUsdPerToken: 0.000_003_75,
    },
    costCents: 125,
    ...overrides,
  };
}

export function testToolCall(overrides: Partial<ToolCallObserved> = {}): ToolCallObserved {
  const scope: EnvironmentScope = overrides.scope ?? testScope();
  return {
    scope,
    toolCallId: asIdentifier<ToolCallId>(TEST_TOOL_CALL_UUID),
    stepId: asIdentifier<StepId>(TEST_STEP_UUID),
    turnId: asIdentifier<TurnId>(TEST_TURN_UUID),
    threadId: asIdentifier<ThreadId>("thread-1"),
    agentId: asIdentifier<AgentId>("agent-1"),
    sequence: 0,
    toolName: "search",
    status: "completed",
    startedAt: new Date("2026-01-01T00:00:00.500Z"),
    completedAt: new Date("2026-01-01T00:00:01.000Z"),
    ...overrides,
  };
}

export function testUsage(overrides: Partial<UsageObserved> = {}): UsageObserved {
  const scope: EnvironmentScope = overrides.scope ?? testScope();
  return {
    scope,
    usageEventId: asIdentifier<UsageEventId>(TEST_USAGE_UUID),
    agentId: asIdentifier<AgentId>("agent-1"),
    usageKind: "inference",
    provider: "provider-a",
    occurredAt: new Date("2026-01-01T00:00:02.000Z"),
    tokens: { inputTokens: 1_000, outputTokens: 250 },
    costCents: 125,
    ...overrides,
  };
}

/**
 * A Turn that did all four kinds of work.
 *
 * IT IS POPULATED ON PURPOSE, AND IT DID NOT USED TO BE. `toolCalls` and `usage`
 * were hard-coded empty here, and `testToolCall`/`testUsage` below had no caller
 * anywhere in the package. The consequence was not a thin fixture, it was a
 * blind projection: every test that reached the tool-call and usage lanes
 * reached them with nothing in them, so dropping either lane from
 * `projection.ts` — the USAGE lane is the one the bill is computed from — left
 * the whole suite green.
 *
 * A test that genuinely wants an empty lane says so, e.g.
 * `testTurnWork({ usage: [] })`. That is one word and it announces itself; the
 * old default announced nothing.
 */
export function testTurnWork(overrides: Partial<TurnWork> = {}): TurnWork {
  return {
    turn: testTurn({ toolCallCount: 1 }),
    steps: [testStep()],
    toolCalls: [testToolCall()],
    usage: [testUsage()],
    ...overrides,
  };
}

/**
 * The `conversations.turn.finalized` payload for one Turn.
 *
 * Built by hand rather than by serializing a `TurnWork`, because a codec test
 * that feeds itself its own encoder's output proves the two agree and nothing
 * about whether either is right. Instants are ISO strings, which is the spelling
 * a JSON column actually holds.
 *
 * IT CARRIES `toolCalls` AND `usage`, AND IT DID NOT USED TO. Those two keys
 * were absent, and `readTurnWork` only reaches `readToolCall`/`readUsage`
 * through `readList` when the key is present — so 84 lines of
 * `domain/observed-work-codec.ts`, the reader for the two lanes that carry
 * provider cost, had ZERO coverage. Both could be deleted outright, with
 * `readTurnWork` hard-wired to empty lists, and the package compiled and
 * returned 14 files / 281 passed.
 *
 * A test that wants an absent lane overrides it — `testFinalizedPayload({ usage:
 * undefined })` — and "an absent list is not a producer defect" stays proved by
 * the cases in `domain/envelope.test.ts`, which build their own payload.
 */
export function testFinalizedPayload(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    turn: {
      turnId: TEST_TURN_UUID,
      threadId: "thread-1",
      agentId: "agent-1",
      status: "completed",
      acceptedAt: "2026-01-01T00:00:00.000Z",
      completedAt: "2026-01-01T00:00:02.500Z",
      stepCount: 1,
      toolCallCount: 1,
      tokens: { inputTokens: 1000, outputTokens: 250, cacheReadInputTokens: 400 },
      costCents: 125,
    },
    steps: [
      {
        stepId: TEST_STEP_UUID,
        turnId: TEST_TURN_UUID,
        threadId: "thread-1",
        agentId: "agent-1",
        sequence: 0,
        provider: "provider-a",
        model: "model-a",
        status: "completed",
        startedAt: "2026-01-01T00:00:00.000Z",
        completedAt: "2026-01-01T00:00:02.000Z",
        tokens: { inputTokens: 1000, outputTokens: 250, cacheReadInputTokens: 400 },
        costCents: 125,
      },
    ],
    toolCalls: [
      {
        toolCallId: TEST_TOOL_CALL_UUID,
        stepId: TEST_STEP_UUID,
        turnId: TEST_TURN_UUID,
        threadId: "thread-1",
        agentId: "agent-1",
        sequence: 0,
        toolName: "search",
        status: "completed",
        startedAt: "2026-01-01T00:00:00.500Z",
        completedAt: "2026-01-01T00:00:01.000Z",
      },
    ],
    usage: [
      {
        usageEventId: TEST_USAGE_UUID,
        turnId: TEST_TURN_UUID,
        stepId: TEST_STEP_UUID,
        agentId: "agent-1",
        usageKind: "inference",
        provider: "provider-a",
        model: "model-a",
        occurredAt: "2026-01-01T00:00:02.000Z",
        tokens: { inputTokens: 1000, outputTokens: 250 },
        costCents: 125,
      },
    ],
    ...overrides,
  };
}
