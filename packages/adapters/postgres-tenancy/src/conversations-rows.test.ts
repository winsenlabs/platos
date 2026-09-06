// The pure half of the `conversations` store, without a database.
//
// EVERY CASE HERE IS ABOUT A DECISION THE ROW MAPPERS MAKE, not about SQL.
// `conversations-constraints.integration.test.ts` stands each write GUARD beside
// the migration CHECK it restates and needs a real PostgreSQL to do it; these
// need none, and running them without one is what keeps the fast suite honest
// about what it covers.
//
// THE TURN ROLLUP IS THE CENTREPIECE. `Turn.cost` carries four numbers and
// `Turn.usage` five, and the `Turn` row has a column for exactly one of the
// nine. The mapper answers all nine from the STEP rows, and the first case below
// is the one that proves it is not reading `costCents`: a row whose stored total
// says one thing and whose steps say another reads back as the steps say.

import { describe, expect, test } from "vitest";

import {
  readPostmanExecution,
  readStep,
  readThread,
  readTurn,
  UNKNOWN_COMPACTION_STATE,
  UNKNOWN_RATE_SOURCE,
  UNKNOWN_VERSION_BUCKET,
  UNKNOWN_WORK_STATUS,
  UNREADABLE_DECIMAL,
  UNREADABLE_JSON_ROOT,
  UNREADABLE_STEP_RATE,
  type PostmanExecutionRow,
  type StepRow,
  type ThreadRow,
  type TurnRow,
} from "./conversations-rows.js";
import { UnreadableRowError } from "./mapping.js";

const AT = new Date("2026-05-01T09:00:00.000Z");

function stepRow(overrides: Partial<StepRow> = {}): StepRow {
  return {
    id: "c0000003-0000-4000-8000-000000000001",
    turnId: "c0000002-0000-4000-8000-000000000001",
    sequence: 1,
    model: "anthropic:claude-test",
    status: "SUCCEEDED",
    retryCount: 0,
    inputTokens: 1_000,
    outputTokens: 200,
    cacheCreationInputTokens: null,
    cacheReadInputTokens: null,
    reasoningTokens: null,
    costCents: { toString: () => "4.500000" },
    modelPriceId: "c000000b-0000-4000-8000-000000000001",
    inputRate: { toString: () => "0.000003000000" },
    outputRate: { toString: () => "0.000015000000" },
    cacheReadRate: { toString: () => "0.000000300000" },
    cacheWriteRate: { toString: () => "0.000003750000" },
    inputRateSource: "LITELLM",
    outputRateSource: "LITELLM",
    cacheReadRateSource: "LITELLM",
    cacheWriteRateSource: "LITELLM",
    inputRateObservedAt: AT,
    outputRateObservedAt: AT,
    cacheReadRateObservedAt: AT,
    cacheWriteRateObservedAt: AT,
    inputRateSourceRef: null,
    outputRateSourceRef: null,
    cacheReadRateSourceRef: null,
    cacheWriteRateSourceRef: null,
    latencyMs: 1_000,
    error: null,
    startedAt: AT,
    completedAt: AT,
    createdAt: AT,
    ...overrides,
  };
}

function turnRow(overrides: Partial<TurnRow> = {}): TurnRow {
  return {
    id: "c0000002-0000-4000-8000-000000000001",
    threadId: "c0000001-0000-4000-8000-000000000001",
    parentTurnId: null,
    agentVersionId: "c0000007-0000-4000-8000-000000000001",
    versionBucket: "CURRENT",
    sequence: 1,
    inputText: "what is the refund window",
    outputText: "thirty days",
    input: null,
    output: null,
    thinkingContent: null,
    status: "SUCCEEDED",
    externalRuntimeId: null,
    idempotencyKey: null,
    latencyMs: 30_000,
    startedAt: AT,
    completedAt: AT,
    createdAt: AT,
    steps: [],
    ...overrides,
  };
}

function threadRow(overrides: Partial<ThreadRow> = {}): ThreadRow {
  return {
    id: "c0000001-0000-4000-8000-000000000001",
    agentId: "c0000008-0000-4000-8000-000000000001",
    endUserId: "c0000009-0000-4000-8000-000000000001",
    clusterId: null,
    parentThreadId: null,
    forkedUpToTurnId: null,
    forkedTurnIds: [],
    compactedUpToTurnId: null,
    title: "the conversation",
    status: "ACTIVE",
    summary: null,
    compactionState: "IDLE",
    compactedAt: null,
    sessionContext: { channel: "web" },
    tags: ["support"],
    pinnedAt: null,
    archivedAt: null,
    createdAt: AT,
    updatedAt: AT,
    ...overrides,
  };
}

function executionRow(overrides: Partial<PostmanExecutionRow> = {}): PostmanExecutionRow {
  return {
    id: "c0000004-0000-4000-8000-000000000001",
    agentId: "c0000008-0000-4000-8000-000000000001",
    templateId: null,
    requestId: "c0000006-0000-4000-8000-000000000001",
    requestFingerprint: "a".repeat(64),
    actorUserId: "11111111-1111-4111-8111-111111111111",
    simulatedEndUserId: null,
    contextHandle: "c0000005-0000-4000-8000-000000000001",
    contextExpiresAt: AT,
    status: "PENDING",
    threadId: null,
    turnId: null,
    completedAt: null,
    createdAt: AT,
    updatedAt: AT,
    ...overrides,
  };
}

function refusalOf(work: () => unknown): UnreadableRowError {
  try {
    work();
  } catch (error) {
    if (error instanceof UnreadableRowError) return error;
    throw error;
  }
  throw new Error("expected the mapper to refuse the row");
}

describe("a turn's money comes from its steps and from nowhere else", () => {
  test("the rollup is the sum of the step costs, exactly", () => {
    const turn = readTurn(
      turnRow({
        steps: [
          stepRow({ costCents: { toString: () => "4.500000" } }),
          stepRow({
            id: "c0000003-0000-4000-8000-000000000002",
            sequence: 2,
            costCents: { toString: () => "1.250000" },
          }),
        ],
      }),
    );
    expect(turn.cost.amount.microCents).toBe(5_750_000n);
    expect(turn.cost.stepCount).toBe(2);
    expect(turn.cost.unpricedSteps).toBe(0);
    expect(turn.cost.complete).toBe(true);
  });

  test("`Turn.costCents` is not consulted, so a legacy row reads as its steps say", () => {
    // THE EXPAND/CONTRACT CASE, and the one that proves the column is write-only
    // here. `TurnRow` has no `costCents` field AT ALL — the select does not ask
    // for it — so a row the extraction source wrote with a total that disagrees
    // with its own steps is read as the steps say. The three code paths that
    // gave three answers for one turn cannot produce a fourth here.
    expect(Object.keys(turnRow())).not.toContain("costCents");
    const turn = readTurn(turnRow({ steps: [stepRow({ costCents: { toString: () => "0.000001" } })] }));
    expect(turn.cost.amount.microCents).toBe(1n);
  });

  test("an unpriced step makes the total a FLOOR rather than a fact", () => {
    const turn = readTurn(
      turnRow({
        steps: [
          stepRow(),
          stepRow({
            id: "c0000003-0000-4000-8000-000000000002",
            sequence: 2,
            costCents: null,
            modelPriceId: null,
            inputRate: null,
            outputRate: null,
            cacheReadRate: null,
            cacheWriteRate: null,
            inputRateSource: null,
            outputRateSource: null,
            cacheReadRateSource: null,
            cacheWriteRateSource: null,
            inputRateObservedAt: null,
            outputRateObservedAt: null,
            cacheReadRateObservedAt: null,
            cacheWriteRateObservedAt: null,
          }),
        ],
      }),
    );
    expect(turn.cost.unpricedSteps).toBe(1);
    expect(turn.cost.complete).toBe(false);
  });

  test("a step priced against an UNAVAILABLE rate is priced and NOT complete", () => {
    // The distinction `domain/step-rates.ts` exists for: "no rate" and "no
    // tokens" both produce a zero cost, and a rate nobody could observe is a
    // third thing again. A mapper that dropped the source would report this
    // turn's total as a fact.
    const turn = readTurn(
      turnRow({ steps: [stepRow({ inputRateSource: "UNAVAILABLE" })] }),
    );
    expect(turn.cost.unpricedSteps).toBe(0);
    expect(turn.cost.complete).toBe(false);
  });

  test("usage is summed over the steps, cache figures kept apart", () => {
    const turn = readTurn(
      turnRow({
        steps: [
          stepRow({ cacheReadInputTokens: 400, cacheCreationInputTokens: 100 }),
          stepRow({ id: "c0000003-0000-4000-8000-000000000002", sequence: 2, reasoningTokens: 50 }),
        ],
      }),
    );
    expect(turn.usage).toEqual({
      inputTokens: 2_000,
      outputTokens: 400,
      cacheCreationInputTokens: 100,
      cacheReadInputTokens: 400,
      reasoningTokens: 50,
    });
  });

  test("a turn with no steps costs exactly zero and IS complete", () => {
    const turn = readTurn(turnRow());
    expect(turn.cost.amount.microCents).toBe(0n);
    expect(turn.cost.stepCount).toBe(0);
    expect(turn.cost.complete).toBe(true);
  });
});

describe("a NULL token column is a count of none, not an unknown", () => {
  test("the five counts default to zero", () => {
    const step = readStep(
      stepRow({
        inputTokens: null,
        outputTokens: null,
        cacheCreationInputTokens: null,
        cacheReadInputTokens: null,
        reasoningTokens: null,
        costCents: null,
      }),
    );
    expect(step.usage).toEqual({
      inputTokens: 0,
      outputTokens: 0,
      cacheCreationInputTokens: 0,
      cacheReadInputTokens: 0,
      reasoningTokens: 0,
    });
  });
});

describe("a rate is read from three columns or from none", () => {
  test("all three present is a rate, with the exact decimal STRING", () => {
    const step = readStep(stepRow());
    expect(step.rates.input?.usdPerToken).toBe("0.000003000000");
    expect(step.rates.cacheWrite?.usdPerToken).toBe("0.000003750000");
    expect(step.rates.input?.source).toBe("LITELLM");
  });

  test("the twelfth decimal survives, because the string is never a float", () => {
    // `Decimal(24, 12)` exceeds what a binary float holds exactly. A mapper that
    // went through `Number` would answer 0.000000000001 as 1e-12 and re-render
    // it in exponential form, which the column would then refuse on the way back.
    const step = readStep(stepRow({ inputRate: { toString: () => "0.000000000001" } }));
    expect(step.rates.input?.usdPerToken).toBe("0.000000000001");
  });

  test("all three absent is `null`, which a zero token count admits", () => {
    const step = readStep(
      stepRow({
        costCents: null,
        modelPriceId: null,
        inputRate: null,
        inputRateSource: null,
        inputRateObservedAt: null,
      }),
    );
    expect(step.rates.input).toBeNull();
    expect(step.rates.output).not.toBeNull();
  });

  test("present in SOME of the three is refused, with its own code", () => {
    const refusal = refusalOf(() => readStep(stepRow({ inputRateObservedAt: null })));
    expect(refusal.code).toBe(UNREADABLE_STEP_RATE);
    expect(refusal.column).toBe("Step.inputRate");
  });

  test("a rate source this binary does not know is refused, naming the column", () => {
    const refusal = refusalOf(() => readStep(stepRow({ outputRateSource: "ORACLE" })));
    expect(refusal.code).toBe(UNKNOWN_RATE_SOURCE);
    expect(refusal.column).toBe("Step.outputRateSource");
    expect(refusal.value).toBe("ORACLE");
  });
});

describe("every stored enum is validated rather than cast", () => {
  test("a WorkStatus this binary has never heard of is refused, per table", () => {
    for (const [read, column] of [
      [() => readThread(threadRow({ status: "SUPERSEDED" })), "Thread.status"],
      [() => readTurn(turnRow({ status: "SUPERSEDED" })), "Turn.status"],
      [() => readStep(stepRow({ status: "SUPERSEDED" })), "Step.status"],
      [
        () => readPostmanExecution(executionRow({ status: "SUPERSEDED" })),
        "PostmanExecution.status",
      ],
    ] as const) {
      const refusal = refusalOf(read);
      expect(refusal.code).toBe(UNKNOWN_WORK_STATUS);
      expect(refusal.column).toBe(column);
      expect(refusal.value).toBe("SUPERSEDED");
    }
  });

  test("an unknown compaction state and an unknown version bucket have separate codes", () => {
    expect(refusalOf(() => readThread(threadRow({ compactionState: "PAUSED" }))).code).toBe(
      UNKNOWN_COMPACTION_STATE,
    );
    expect(refusalOf(() => readTurn(turnRow({ versionBucket: "SHADOW" }))).code).toBe(
      UNKNOWN_VERSION_BUCKET,
    );
  });
});

describe("a JSON column is an object root or it is refused", () => {
  test("an array in `Thread.sessionContext` is refused rather than indexed", () => {
    const refusal = refusalOf(() => readThread(threadRow({ sessionContext: [1, 2] })));
    expect(refusal.code).toBe(UNREADABLE_JSON_ROOT);
    expect(refusal.column).toBe("Thread.sessionContext");
  });

  test("`Turn.input` and `Turn.output` are refused separately", () => {
    expect(refusalOf(() => readTurn(turnRow({ input: "a string" }))).column).toBe("Turn.input");
    expect(refusalOf(() => readTurn(turnRow({ output: [] }))).column).toBe("Turn.output");
  });

  test("SQL NULL is a null session context and not a refusal", () => {
    expect(readThread(threadRow({ sessionContext: null })).sessionContext).toBeNull();
  });
});

describe("a Decimal is read as a string or refused", () => {
  test("a driver value that is not a decimal at all is refused", () => {
    const refusal = refusalOf(() =>
      readStep(stepRow({ costCents: { toString: () => "NaN" } })),
    );
    expect(refusal.code).toBe(UNREADABLE_DECIMAL);
    expect(refusal.column).toBe("Step.costCents");
  });

  test("a cost finer than Decimal(18, 6) is refused rather than rounded", () => {
    // Seven fractional digits cannot be held by the column and must not be
    // silently truncated: a store that rounded here would report a cost the
    // database never held.
    const refusal = refusalOf(() =>
      readStep(stepRow({ costCents: { toString: () => "4.5000001" } })),
    );
    expect(refusal.code).toBe(UNREADABLE_DECIMAL);
  });
});

describe("the plain transcriptions", () => {
  test("a thread's identifiers, tags and instants survive verbatim", () => {
    const thread = readThread(
      threadRow({
        clusterId: "c000000a-0000-4000-8000-000000000001",
        forkedTurnIds: ["c0000002-0000-4000-8000-000000000001"],
        forkedUpToTurnId: "c0000002-0000-4000-8000-000000000001",
        tags: ["support", "billing"],
      }),
    );
    expect(thread.clusterId).toBe("c000000a-0000-4000-8000-000000000001");
    expect(thread.forkedTurnIds).toEqual(["c0000002-0000-4000-8000-000000000001"]);
    expect(thread.tags).toEqual(["support", "billing"]);
    expect(thread.createdAt).toBe(AT);
  });

  test("an execution's handle and fingerprint are carried, not reformatted", () => {
    const execution = readPostmanExecution(
      executionRow({ simulatedEndUserId: "c0000009-0000-4000-8000-000000000001" }),
    );
    expect(execution.contextHandle).toBe("c0000005-0000-4000-8000-000000000001");
    expect(execution.requestFingerprint).toBe("a".repeat(64));
    expect(execution.simulatedEndUserId).toBe("c0000009-0000-4000-8000-000000000001");
  });
});
