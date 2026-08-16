import { describe, expect, it, vi } from "vitest";
import {
  CONVERSATION_REVISION_NOT_SUPPORTED,
  ConversationRevisionNotSupportedError,
  ConversationService,
} from "./conversation.service";

const scope = {
  organizationId: "org",
  projectId: "project",
  environmentId: "environment",
  userId: "user",
  agentId: "agent",
} as any;

function makeService() {
  const createdTurns: any[] = [];
  const updatedTurns: any[] = [];
  const createdSteps: any[] = [];
  const openTurn = {
    id: "turn-1",
    threadId: "thread-1",
    agentVersionId: "version-1",
    versionBucket: "CANARY",
    sequence: 1,
    inputText: "hello",
    outputText: null,
    input: {},
    output: null,
    thinkingContent: null,
    status: "ACTIVE",
    externalRuntimeId: null,
    costCents: null,
    latencyMs: null,
    startedAt: new Date("2026-08-15T00:00:00.000Z"),
    completedAt: null,
    createdAt: new Date("2026-08-15T00:00:00.000Z"),
  };
  const tx = {
    $queryRaw: vi.fn(async () => [{ id: "thread-1" }]),
    turn: {
      findFirst: vi.fn(async ({ where }: any) => {
        if (where.status === "ACTIVE") return openTurn;
        return null;
      }),
      create: vi.fn(async ({ data }: any) => {
        createdTurns.push(data);
        return { ...openTurn, ...data, id: "turn-1", createdAt: openTurn.createdAt };
      }),
      update: vi.fn(async ({ data }: any) => {
        updatedTurns.push(data);
        return { ...openTurn, ...data };
      }),
    },
    step: {
      create: vi.fn(async ({ data }: any) => {
        createdSteps.push(data);
        return { id: "step-1", ...data };
      }),
      upsert: vi.fn(async ({ create }: any) => {
        createdSteps.push(create);
        return { id: "step-1", ...create };
      }),
    },
  };
  const prisma = {
    agentVersion: { findFirst: vi.fn(async () => ({ id: "version-1" })) },
    turn: {
      findFirst: vi.fn(async () => null),
    },
    $transaction: vi.fn(async (callback: any) => callback(tx)),
  };
  const service = new ConversationService(prisma as any);
  (service as any).findScopedThread = vi.fn(async () => ({
    id: "thread-1",
    agentId: "agent",
    environmentId: "environment",
  }));
  return { service, prisma, tx, createdTurns, updatedTurns, createdSteps };
}

describe("ConversationService clean Turn persistence", () => {
  it("opens one authoritative Turn with immutable AgentVersion attribution", async () => {
    const { service, tx, createdTurns } = makeService();
    const stored = await service.storeMessage("thread-1", scope, {
      role: "user",
      content: "hello",
      agentVersionId: "version-1",
      versionBucket: "canary",
      systemPromptOverride: "temporary",
    });

    expect(stored.id).toBe("turn-1");
    expect(createdTurns).toHaveLength(1);
    expect(createdTurns[0]).toMatchObject({
      threadId: "thread-1",
      agentVersionId: "version-1",
      versionBucket: "CANARY",
      sequence: 1,
      inputText: "hello",
      status: "ACTIVE",
    });
    expect(tx.$queryRaw).toHaveBeenCalledTimes(1);
    expect(tx.$queryRaw.mock.invocationCallOrder[0]).toBeLessThan(
      tx.turn.findFirst.mock.invocationCallOrder[0],
    );
  });

  it("finalizes Turn, Step, usage, cost, latency, output, and ToolCalls in one transaction", async () => {
    const { service, prisma, updatedTurns, createdSteps } = makeService();
    await service.storeMessage("thread-1", scope, {
      role: "assistant",
      turnId: "turn-1",
      content: "done",
      thinkingContent: "reasoning",
      model: "anthropic:test",
      usage: {
        inputTokens: 100,
        outputTokens: 20,
        cacheCreationInputTokens: 30,
        cacheReadInputTokens: 40,
        reasoningTokens: 5,
      },
      costCents: 1.25,
      latencyMs: 321,
      structuredOutput: { ok: true },
      toolCalls: [
        { type: "call", name: "lookup", params: { id: 1 } },
        { type: "result", name: "lookup", result: "found" },
      ],
    });

    expect(prisma.$transaction).toHaveBeenCalledTimes(1);
    expect(updatedTurns[0]).toMatchObject({
      outputText: "done",
      thinkingContent: "reasoning",
      status: "SUCCEEDED",
      costCents: 1.25,
      latencyMs: 321,
      output: { structuredOutput: { ok: true } },
    });
    expect(createdSteps[0]).toMatchObject({
      turnId: "turn-1",
      sequence: 1,
      model: "anthropic:test",
      status: "SUCCEEDED",
      inputTokens: 100,
      outputTokens: 20,
      cacheCreationInputTokens: 30,
      cacheReadInputTokens: 40,
      reasoningTokens: 5,
      costCents: 1.25,
      latencyMs: 321,
    });
    expect(createdSteps[0].toolCalls.create).toEqual([
      expect.objectContaining({
        sequence: 1,
        toolName: "lookup",
        arguments: { id: 1 },
        result: { value: "found" },
        status: "SUCCEEDED",
      }),
    ]);
  });

  it("rejects assistant persistence without an active Turn before creating a Step", async () => {
    const { service, tx } = makeService();
    tx.turn.findFirst.mockResolvedValueOnce(null);
    await expect(service.storeMessage("thread-1", scope, {
      role: "assistant",
      turnId: "turn-1",
      content: "late",
    })).rejects.toThrow("Open turn not found or already finalized");
    expect(tx.step.create).not.toHaveBeenCalled();
  });

  it.each([
    ["edit and rerun", (service: ConversationService) => service.editAndRerun("thread-1", "turn-1", scope, "replacement")],
    ["assistant retry", (service: ConversationService) => service.retryAssistantTurn("thread-1", "turn-1", scope)],
  ])("fails closed for %s without mutating normalized evidence", async (_label, invoke) => {
    const turn = { id: "turn-1", inputText: "original", outputText: "answer" };
    const step = { id: "step-1", turnId: turn.id, model: "fixture" };
    const toolCall = { id: "call-1", stepId: step.id, toolName: "lookup" };
    const prisma = {
      turn: {
        findFirst: vi.fn(),
        update: vi.fn(),
        deleteMany: vi.fn(),
      },
      step: { update: vi.fn(), deleteMany: vi.fn() },
      toolCall: { update: vi.fn(), deleteMany: vi.fn() },
      $transaction: vi.fn(),
    };
    const service = new ConversationService(prisma as any);
    (service as any).findScopedThread = vi.fn(async () => ({ id: "thread-1" }));

    const error = await invoke(service).catch((value) => value);

    expect(error).toBeInstanceOf(ConversationRevisionNotSupportedError);
    expect(error).toMatchObject({
      ...CONVERSATION_REVISION_NOT_SUPPORTED,
    });
    expect(prisma.$transaction).not.toHaveBeenCalled();
    expect(prisma.turn.findFirst).not.toHaveBeenCalled();
    expect(prisma.turn.update).not.toHaveBeenCalled();
    expect(prisma.turn.deleteMany).not.toHaveBeenCalled();
    expect(prisma.step.update).not.toHaveBeenCalled();
    expect(prisma.step.deleteMany).not.toHaveBeenCalled();
    expect(prisma.toolCall.update).not.toHaveBeenCalled();
    expect(prisma.toolCall.deleteMany).not.toHaveBeenCalled();
    expect({ turn, step, toolCall }).toEqual({
      turn: { id: "turn-1", inputText: "original", outputText: "answer" },
      step: { id: "step-1", turnId: "turn-1", model: "fixture" },
      toolCall: { id: "call-1", stepId: "step-1", toolName: "lookup" },
    });
  });

  it("marks both the normalized Turn and Step failed with the stable runtime error", async () => {
    const { service, updatedTurns, createdSteps } = makeService();

    await service.failTurn(
      "thread-1",
      "turn-1",
      scope,
      new Error("Provider request failed."),
      "openai:fixture-model",
    );

    expect(updatedTurns[0]).toMatchObject({
      status: "FAILED",
      output: { error: "Provider request failed." },
    });
    expect(createdSteps[0]).toMatchObject({
      turnId: "turn-1",
      sequence: 1,
      model: "openai:fixture-model",
      status: "FAILED",
      error: "Provider request failed.",
    });
  });

  it("paginates projected message sides rather than doubling a Turn limit", async () => {
    const turns = [1, 2, 3].map((sequence) => ({
      id: `turn-${sequence}`,
      threadId: "thread-1",
      sequence,
      status: "SUCCEEDED",
      inputText: `user-${sequence}`,
      outputText: `assistant-${sequence}`,
      output: null,
      thinkingContent: null,
      agentVersionId: "version-1",
      versionBucket: "CURRENT",
      costCents: null,
      latencyMs: null,
      completedAt: new Date("2026-08-15T00:00:01.000Z"),
      createdAt: new Date("2026-08-15T00:00:00.000Z"),
      steps: [],
    }));
    const prisma = {
      turn: {
        findMany: vi.fn()
          .mockResolvedValueOnce(turns.map(({ id, status }) => ({ id, status })))
          .mockResolvedValueOnce(turns.slice(0, 2)),
      },
    };
    const service = new ConversationService(prisma as any);
    (service as any).getThread = vi.fn(async () => ({ id: "thread-1" }));

    const page = await service.getMessages("thread-1", scope, { limit: 3 });

    expect(page.total).toBe(6);
    expect(page.messages.map((message) => [message.role, message.content])).toEqual([
      ["user", "user-1"],
      ["assistant", "assistant-1"],
      ["user", "user-2"],
    ]);
  });
});
