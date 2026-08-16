import { describe, expect, it, vi } from "vitest";
import type { RequestScope } from "../auth/scope.guard";
import { TraceService } from "./trace.service";
import { UtilizationService } from "./utilization.service";

const scope: Pick<RequestScope, "organizationId" | "projectId" | "environmentId"> = {
  organizationId: "org-a",
  projectId: "project-a",
  environmentId: "env-a",
};

describe("clean Turn/Step/ToolCall monitoring projections", () => {
  it("projects one Turn into user/assistant trace messages and Step/ToolCall rollups", async () => {
    const createdAt = new Date("2026-08-15T10:00:00.000Z");
    const completedAt = new Date("2026-08-15T10:00:02.000Z");
    const threadFindFirst = vi.fn().mockResolvedValue({
      id: "thread-a",
      agentId: "agent-a",
      title: "Trace",
      status: "ACTIVE",
      createdAt,
      updatedAt: completedAt,
      _count: { turns: 1 },
    });
    const turnFindMany = vi.fn().mockResolvedValue([
      {
        id: "turn-a",
        inputText: "What is the weather?",
        outputText: "It is sunny.",
        thinkingContent: "Use the weather tool.",
        createdAt,
        completedAt,
        attachments: [],
        steps: [
          {
            id: "step-a",
            sequence: 0,
            model: "anthropic:claude-sonnet-4-6",
            inputTokens: 120,
            outputTokens: 30,
            status: "COMPLETED",
            error: null,
            toolCalls: [
              {
                id: "tool-call-a",
                sequence: 0,
                toolName: "weather.lookup",
                arguments: { city: "London" },
                result: { temperature: 22 },
                status: "COMPLETED",
                error: null,
                latencyMs: 75,
              },
            ],
          },
        ],
      },
    ]);
    const spans = {
      isClickhouseEnabled: vi.fn(() => false),
      getThreadSpans: vi.fn().mockResolvedValue([]),
    };
    const service = new TraceService(
      { thread: { findFirst: threadFindFirst }, turn: { findMany: turnFindMany } } as any,
      spans as any,
      { getThreadCost: vi.fn().mockResolvedValue({ costCents: 1.25 }) } as any,
    );

    const result = await service.buildThreadTrace(scope, "thread-a");

    expect(threadFindFirst).toHaveBeenCalledWith(
      expect.objectContaining({
        where: {
          id: "thread-a",
          environmentId: "env-a",
          environment: {
            project: { id: "project-a", organizationId: "org-a" },
          },
        },
      }),
    );
    expect(turnFindMany).toHaveBeenCalledWith({
      where: { threadId: "thread-a" },
      orderBy: { sequence: "asc" },
      include: {
        steps: {
          orderBy: { sequence: "asc" },
          include: { toolCalls: { orderBy: { sequence: "asc" } } },
        },
        attachments: {
          select: { id: true, kind: true, mimeType: true, bytes: true },
        },
      },
    });
    expect(result?.messages).toEqual([
      expect.objectContaining({
        id: "turn-a:input",
        turnId: "turn-a",
        role: "user",
        content: "What is the weather?",
      }),
      expect.objectContaining({
        id: "turn-a",
        turnId: "turn-a",
        role: "assistant",
        content: "It is sunny.",
        toolCalls: [
          {
            type: "call",
            toolCallId: "tool-call-a",
            toolName: "weather.lookup",
            args: { city: "London" },
            result: { temperature: 22 },
            status: "COMPLETED",
            error: null,
            latencyMs: 75,
          },
        ],
        responseJson: {
          model: "anthropic:claude-sonnet-4-6",
          usage: { inputTokens: 120, outputTokens: 30 },
          stepCount: 1,
        },
      }),
    ]);
    expect(result?.rollup).toMatchObject({
      totalMessages: 2,
      totalInputTokens: 120,
      totalOutputTokens: 30,
      toolCallCount: 1,
      totalCostCents: 1.25,
    });
  });

  it("counts a Step-only assistant side as a message in utilization", async () => {
    const count = vi.fn().mockResolvedValueOnce(1).mockResolvedValueOnce(1);
    const turnFindMany = vi
      .fn()
      .mockResolvedValueOnce([
        { inputText: null, outputText: null, steps: [{ id: "step-a" }] },
      ])
      .mockResolvedValueOnce([]);
    const service = new UtilizationService({
      thread: { count, findMany: vi.fn() },
      turn: { findMany: turnFindMany },
    } as any);

    const result = await service.build(scope, { days: 1 });

    expect(result.totalMessages).toBe(1);
    expect(turnFindMany).toHaveBeenNthCalledWith(1, {
      where: {
        thread: {
          environmentId: "env-a",
          environment: {
            project: { id: "project-a", organizationId: "org-a" },
          },
        },
      },
      select: {
        inputText: true,
        outputText: true,
        steps: { select: { id: true } },
      },
    });
  });
});
