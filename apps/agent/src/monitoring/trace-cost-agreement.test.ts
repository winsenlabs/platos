/**
 * A trace and a dashboard cannot disagree about the same thread.
 *
 * `getThreadTrace` accumulated the ledger's per-Step totals — including
 * `costCents` — and then threw the cost away, reading the `cost:thread:*` Redis
 * hash instead. That hash carries a 30-day TTL while the Step rows are queried
 * over 90 days, so for any thread in the gap the trace reported 0, or fell
 * through to a THIRD arithmetic that summed a span attribute, while
 * `getCostByModel` and `getCostByUser` reported the durable Step cost for the
 * same turns. The durable figure was computed one line earlier and discarded.
 *
 * The real TraceService is under test. Prisma and SpansService are faked
 * because they are its dependencies, not the thing being checked.
 */

import { describe, expect, it } from "vitest";
import { TraceService } from "./trace.service";
import { roundCents, usageFromStep } from "./usage-ledger";

const SCOPE = {
  organizationId: "org-1",
  projectId: "proj-1",
  environmentId: "env-1",
};
const THREAD_ID = "thread-1";
const AT = new Date("2026-08-01T09:00:00.000Z");

/** One turn, two Steps: the parent model call and a sub-agent's. */
function steps() {
  return [
    {
      id: "step-1",
      sequence: 1,
      model: "anthropic:sonnet-test",
      inputTokens: 4_000,
      outputTokens: 300,
      cacheReadInputTokens: 0,
      cacheCreationInputTokens: 0,
      reasoningTokens: 0,
      costCents: 2.2199,
      status: "SUCCEEDED",
      error: null,
      toolCalls: [],
    },
    {
      id: "step-2",
      sequence: 2,
      model: "anthropic:haiku-test",
      inputTokens: 900,
      outputTokens: 120,
      cacheReadInputTokens: 0,
      cacheCreationInputTokens: 0,
      reasoningTokens: 0,
      costCents: 0.0031,
      status: "SUCCEEDED",
      error: null,
      toolCalls: [],
    },
  ];
}

function traceService(options: { threadCostCents?: number; spanCostCents?: number } = {}) {
  const prisma = {
    thread: {
      findFirst: async () => ({
        id: THREAD_ID,
        agentId: "agent-1",
        title: "t",
        status: "ACTIVE",
        createdAt: AT,
        updatedAt: AT,
        _count: { turns: 1 },
      }),
    },
    turn: {
      findMany: async () => [
        {
          id: "turn-1",
          inputText: "hello",
          outputText: "hi",
          thinkingContent: null,
          createdAt: AT,
          completedAt: AT,
          steps: steps(),
          attachments: [],
        },
      ],
    },
  };
  const spansService = {
    isClickhouseEnabled: () => false,
    getThreadSpans: async () =>
      options.spanCostCents === undefined
        ? []
        : [
            {
              spanId: "span-1",
              parentSpanId: null,
              startTimeUnixNano: AT.getTime() * 1_000_000,
              attributes: { "platos.cost_cents": options.spanCostCents },
            },
          ],
  };
  const costService =
    options.threadCostCents === undefined
      ? undefined
      : {
          getThreadCost: async () => ({
            inputTokens: 0,
            outputTokens: 0,
            costCents: options.threadCostCents!,
            tasks: 1,
          }),
        };
  return new TraceService(prisma as any, spansService as any, costService as any);
}

/** What the by-model / by-user panels report for the same Steps. */
function durableCostCents(): number {
  return roundCents(steps().reduce((total, step) => total + usageFromStep(step).costCents, 0));
}

describe("the trace reports the durable figure the dashboards report", () => {
  it("uses the Step ledger even when the thread rollup has expired", async () => {
    // The 30-day thread-key TTL against the 90-day Step window. The trace used
    // to report zero here — or a span-derived number — for a thread the cost
    // panels priced from the same rows.
    const trace = await traceService({ threadCostCents: 0 }).buildThreadTrace(SCOPE, THREAD_ID);
    expect(trace!.rollup.totalCostCents).toBeCloseTo(durableCostCents(), 6);
    expect(trace!.rollup.totalCostCents).toBeGreaterThan(0);
  });

  it("prefers the durable ledger over a disagreeing thread rollup", async () => {
    // Redis is the live rollup, not the record. When the two differ, the Step
    // rows are the answer and the trace must not be the one surface that says
    // something else.
    const trace = await traceService({ threadCostCents: 999 }).buildThreadTrace(SCOPE, THREAD_ID);
    expect(trace!.rollup.totalCostCents).toBeCloseTo(durableCostCents(), 6);
  });

  it("never falls through to span arithmetic while the ledger has an answer", async () => {
    const trace = await traceService({
      threadCostCents: 0,
      spanCostCents: 42,
    }).buildThreadTrace(SCOPE, THREAD_ID);
    expect(trace!.rollup.totalCostCents).not.toBeCloseTo(42, 6);
    expect(trace!.rollup.totalCostCents).toBeCloseTo(durableCostCents(), 6);
  });

  it("keeps a sub-cent thread visible instead of rounding it to zero", async () => {
    // 0.0031c is a real charge. Rounded at 0.01c it is nothing.
    const service = traceService({ threadCostCents: 0 });
    (service as any).prisma.turn.findMany = async () => [
      {
        id: "turn-1",
        inputText: null,
        outputText: "hi",
        thinkingContent: null,
        createdAt: AT,
        completedAt: AT,
        steps: [steps()[1]],
        attachments: [],
      },
    ];
    const trace = await service.buildThreadTrace(SCOPE, THREAD_ID);
    expect(trace!.rollup.totalCostCents).toBeCloseTo(0.0031, 6);
  });

  it("still reads the Redis rollup for turns whose Steps carry no cost", async () => {
    // Rows written before Step carried a cost column: Redis holds the only
    // historical price breakdown for them, so it stays as a fallback — behind
    // the durable record rather than in front of it.
    const service = traceService({ threadCostCents: 7.5 });
    (service as any).prisma.turn.findMany = async () => [
      {
        id: "turn-1",
        inputText: null,
        outputText: "hi",
        thinkingContent: null,
        createdAt: AT,
        completedAt: AT,
        steps: [{ ...steps()[0], costCents: null }],
        attachments: [],
      },
    ];
    const trace = await service.buildThreadTrace(SCOPE, THREAD_ID);
    expect(trace!.rollup.totalCostCents).toBeCloseTo(7.5, 6);
  });
});
