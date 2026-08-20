import { afterEach, describe, expect, it, vi } from "vitest";
import type { RequestScope } from "../auth/scope.guard";
import { CostService } from "./cost.service";
import { GovernanceService } from "./governance.service";
import { TraceService } from "./trace.service";
import { UtilizationService } from "./utilization.service";

const scope: Pick<
  RequestScope,
  "organizationId" | "projectId" | "environmentId"
> = {
  organizationId: "org-a",
  projectId: "project-a",
  environmentId: "env-a",
};

const canonicalThreadScope = {
  environmentId: "env-a",
  environment: {
    project: { id: "project-a", organizationId: "org-a" },
  },
};

function emptyRedis() {
  return {
    scan: vi.fn().mockResolvedValue(["0", []]),
    get: vi.fn().mockResolvedValue(null),
    pipeline: vi.fn(),
  };
}

afterEach(() => {
  vi.useRealTimers();
});

describe("clean Turn/Step/ToolCall monitoring audit coverage", () => {
  it("lists trace summaries from clean Turns, Steps, and ToolCalls", async () => {
    const createdAt = new Date("2026-08-15T08:00:00.000Z");
    const updatedAt = new Date("2026-08-15T08:01:00.000Z");
    const findMany = vi.fn().mockResolvedValue([
      {
        id: "thread-a",
        agentId: "agent-a",
        title: "Weather",
        status: "SUCCEEDED",
        createdAt,
        updatedAt,
        turns: [
          {
            inputText: "Weather?",
            outputText: "Sunny",
            steps: [
              {
                inputTokens: 100,
                outputTokens: 25,
                toolCalls: [{ id: "tool-call-a" }],
              },
            ],
          },
          {
            inputText: null,
            outputText: null,
            steps: [
              {
                inputTokens: 10,
                outputTokens: 5,
                toolCalls: [],
              },
            ],
          },
        ],
      },
    ]);
    const cost = { getThreadCost: vi.fn().mockResolvedValue({ costCents: 1.75 }) };
    const service = new TraceService(
      { thread: { findMany } } as any,
      {} as any,
      cost as any,
    );

    const result = await service.listTraces(scope, {
      agentId: "agent-a",
      limit: 10,
      offset: 2,
    });

    expect(findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { ...canonicalThreadScope, agentId: "agent-a" },
        orderBy: { updatedAt: "desc" },
        take: 10,
        skip: 2,
      }),
    );
    expect(result).toEqual({
      count: 1,
      traces: [
        {
          threadId: "thread-a",
          agentId: "agent-a",
          title: "Weather",
          status: "SUCCEEDED",
          turnCount: 2,
          messageCount: 3,
          totalCostCents: 1.75,
          totalInputTokens: 110,
          totalOutputTokens: 30,
          toolCallCount: 1,
          createdAt: createdAt.toISOString(),
          updatedAt: updatedAt.toISOString(),
        },
      ],
    });
  });

  it("builds utilization users and day buckets from clean Turn projections", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-08-15T12:00:00.000Z"));
    const count = vi.fn().mockResolvedValueOnce(1).mockResolvedValueOnce(2);
    const turnFindMany = vi
      .fn()
      .mockResolvedValueOnce([
        { inputText: "one", outputText: "answer", steps: [] },
        { inputText: null, outputText: null, steps: [{ id: "step-a" }] },
      ])
      .mockResolvedValueOnce([
        {
          createdAt: new Date("2026-08-15T10:00:00.000Z"),
          inputText: "one",
          outputText: "answer",
          steps: [],
          thread: {
            endUserId: "end-user-a",
            id: "thread-a",
            updatedAt: new Date("2026-08-15T10:01:00.000Z"),
          },
        },
        {
          createdAt: new Date("2026-08-15T11:00:00.000Z"),
          inputText: null,
          outputText: null,
          steps: [{ id: "step-a" }],
          thread: {
            endUserId: "end-user-a",
            id: "thread-b",
            updatedAt: new Date("2026-08-15T11:01:00.000Z"),
          },
        },
      ]);
    const threadFindMany = vi.fn().mockResolvedValue([
      {
        endUserId: "end-user-a",
        createdAt: new Date("2026-08-15T09:00:00.000Z"),
      },
    ]);
    const cost = {
      getCostByUser: vi.fn().mockResolvedValue([
        { userId: "end-user-a", costCents: 2.345 },
      ]),
    };
    const service = new UtilizationService(
      {
        thread: { count, findMany: threadFindMany },
        turn: { findMany: turnFindMany },
      } as any,
      cost as any,
    );

    const result = await service.build(scope, { days: 1, topUserLimit: 5 });

    expect(result).toMatchObject({
      activeThreads: 1,
      totalThreads: 2,
      totalMessages: 3,
      messagesByDay: [{ date: "2026-08-15", messages: 3 }],
      newVsReturningUsers: { days: 1, newUsers: 1, returningUsers: 0 },
      topUsers: [
        {
          userId: "end-user-a",
          messages: 3,
          threads: 2,
          costCents: 2.35,
          lastActiveAt: "2026-08-15T11:00:00.000Z",
        },
      ],
    });
    expect(threadFindMany).toHaveBeenCalledWith({
      where: {
        ...canonicalThreadScope,
        endUserId: { in: ["end-user-a"] },
      },
      select: { endUserId: true, createdAt: true },
      orderBy: { createdAt: "asc" },
    });
  });

  it("computes governance risk with one denominator row per clean Turn", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-08-15T12:00:00.000Z"));
    const turnFindMany = vi.fn().mockResolvedValue([
      { thread: { agentId: "agent-a" } },
      { thread: { agentId: "agent-a" } },
    ]);
    const prisma = {
      turn: { findMany: turnFindMany },
      safetyEvent: {
        findMany: vi.fn().mockResolvedValue([
          { agentId: "agent-a", detector: "pii" },
          { agentId: "agent-a", detector: "tool_param" },
        ]),
      },
      toolCallAudit: {
        findMany: vi.fn().mockResolvedValue([
          { agentId: "agent-a", status: "FAILED" },
        ]),
      },
      agentApproval: {
        findMany: vi.fn().mockResolvedValue([{ agentId: "agent-a" }]),
      },
      agent: {
        findMany: vi.fn().mockResolvedValue([{ id: "agent-a", name: "Ada" }]),
      },
    };
    const safety = {
      summary: vi.fn().mockResolvedValue({ total: 2 }),
      list: vi.fn().mockResolvedValue({ rows: [{ id: "event-a" }] }),
    };
    const budgets = {
      list: vi.fn().mockResolvedValue([]),
      evaluate: vi.fn(),
    };
    const service = new GovernanceService(
      prisma as any,
      safety as any,
      budgets as any,
    );

    const result = await service.dashboard(scope, { sinceDays: 7 });

    expect(turnFindMany).toHaveBeenCalledWith({
      where: {
        createdAt: { gte: new Date("2026-08-08T12:00:00.000Z") },
        thread: canonicalThreadScope,
      },
      select: { thread: { select: { agentId: true } } },
    });
    expect(result.agentRisk).toEqual([
      {
        agentId: "agent-a",
        agentName: "Ada",
        turns: 2,
        piiEvents: 1,
        injectionEvents: 1,
        toolErrors: 1,
        approvalEvents: 1,
        risk: 50,
        band: "high",
      },
    ]);
  });

  it("projects model, agent, and user cost from clean Step ancestry when Redis is empty", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-08-15T12:00:00.000Z"));
    const step = {
      createdAt: new Date("2026-08-15T10:00:00.000Z"),
      model: "gpt-4o",
      inputTokens: 1_000_000,
      outputTokens: 1_000_000,
      // The Step's own priced cost, frozen against the WIN-125 four-rate card
      // at the time the turn ran. The fallback reads it; it does not re-derive
      // a price, because the rates that produced this figure may since have
      // changed and re-pricing history is how a bill stops reconciling.
      costCents: 1250,
      turnId: "turn-a",
      turn: {
        id: "turn-a",
        thread: {
          id: "thread-a",
          agentId: "agent-a",
          endUserId: "end-user-a",
        },
      },
    };
    const stepFindMany = vi.fn().mockResolvedValue([step]);
    const agentFindMany = vi.fn().mockResolvedValue([
      { id: "agent-a", name: "Ada" },
    ]);
    const service = new CostService(
      {
        step: { findMany: stepFindMany },
        agent: { findMany: agentFindMany },
      } as any,
      emptyRedis() as any,
    );

    const [byModel, byAgent, byUser] = await Promise.all([
      service.getCostByModel(scope, { days: 1 }),
      service.getCostByAgent(scope, { days: 1 }),
      service.getCostByUser(scope, { days: 1 }),
    ]);

    expect(byModel).toEqual([
      {
        model: "gpt-4o",
        costCents: 1250,
        costWithCacheCents: 1250,
        inputTokens: 1_000_000,
        outputTokens: 1_000_000,
        cacheCreationInputTokens: 0,
        cacheReadInputTokens: 0,
        // One Step, one Turn, one task. The fallback counts distinct turns.
        tasks: 1,
      },
    ]);
    expect(byAgent).toEqual([
      {
        agentId: "agent-a",
        agentName: "Ada",
        costCents: 1250,
        costWithCacheCents: 1250,
        inputTokens: 1_000_000,
        outputTokens: 1_000_000,
        cacheCreationInputTokens: 0,
        cacheReadInputTokens: 0,
        tasks: 1,
        threads: 1,
      },
    ]);
    expect(byUser).toEqual([
      {
        userId: "end-user-a",
        costCents: 1250,
        tasks: 1,
        threads: 1,
        inputTokens: 1_000_000,
        outputTokens: 1_000_000,
        cacheReadInputTokens: 0,
        cacheCreationInputTokens: 0,
        reasoningTokens: 0,
        noCacheInputTokens: 1_000_000,
      },
    ]);
    expect(stepFindMany).toHaveBeenCalledTimes(3);
    for (const [args] of stepFindMany.mock.calls) {
      expect(args.where.turn.thread).toEqual(canonicalThreadScope);
    }
    expect(agentFindMany).toHaveBeenCalledWith({
      where: {
        id: { in: ["agent-a"] },
        projectId: "project-a",
        project: { organizationId: "org-a" },
        bindings: { some: { environmentId: "env-a" } },
      },
      select: { id: true, name: true },
    });
  });
});
