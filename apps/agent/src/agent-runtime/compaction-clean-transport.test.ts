import { beforeEach, describe, expect, it, vi } from "vitest";

const { generateTextMock } = vi.hoisted(() => ({ generateTextMock: vi.fn() }));
vi.mock("ai", async () => {
  const actual = await vi.importActual<any>("ai");
  return { ...actual, generateText: generateTextMock };
});

import { AgentTaskService } from "./agent-task.service";

const scope = {
  organizationId: "org",
  projectId: "project",
  environmentId: "environment",
  userId: "user",
} as any;

const config = {
  contextLimit: 1,
  compactThreshold: 5,
} as any;

function setup() {
  const updates: any[] = [];
  const turns = Array.from({ length: 6 }, (_, index) => ({
    id: `turn-${index + 1}`,
    sequence: index + 1,
    inputText: `user-${index + 1}`,
    outputText: `assistant-${index + 1}`,
  }));
  const tx = {
    thread: {
      updateMany: vi.fn(async (args: any) => {
        updates.push(args);
        return { count: 1 };
      }),
    },
  };
  const prisma = {
    thread: {
      updateMany: vi.fn(async (args: any) => {
        updates.push(args);
        return { count: 1 };
      }),
      findFirstOrThrow: vi.fn(async () => ({
        summary: "prior summary",
        compactedUpToTurn: null,
        _count: { turns: 6 },
      })),
      findFirst: vi.fn(async () => ({ compactionState: "IN_PROGRESS" })),
    },
    turn: {
      findMany: vi.fn(async () => turns),
    },
    $transaction: vi.fn(async (callback: any) => callback(tx)),
  };
  const agentService = {
    resolveCompactionModel: vi.fn(async () => ({
      model: { provider: "test" },
      modelString: "anthropic:compaction",
      source: "compaction",
    })),
  };
  const conversationService = { prisma };
  const service = new AgentTaskService(
    agentService as any,
    conversationService as any,
    {} as any,
    {} as any,
    {} as any,
    {} as any,
    {} as any,
    {} as any,
    {} as any,
    {} as any,
    {} as any,
    {} as any,
  );
  return { service, prisma, tx, updates, agentService };
}

describe("clean cursor compaction", () => {
  beforeEach(() => generateTextMock.mockReset());

  it("advances summary and compactedUpToTurnId atomically through the reserved route", async () => {
    generateTextMock.mockResolvedValueOnce({ text: "new summary" });
    const { service, prisma, tx, agentService } = setup();

    await (service as any).compactIfNeeded("thread-1", scope, config);

    expect(agentService.resolveCompactionModel).toHaveBeenCalledWith(config, scope);
    expect(prisma.$transaction).toHaveBeenCalledTimes(1);
    expect(tx.thread.updateMany).toHaveBeenCalledWith(expect.objectContaining({
      where: expect.objectContaining({
        id: "thread-1",
        compactionState: "IN_PROGRESS",
      }),
      data: expect.objectContaining({
        summary: "prior summary\n\n---\n\nnew summary",
        compactedUpToTurnId: "turn-5",
        compactionState: "IDLE",
      }),
    }));
  });

  it("leaves summary/cursor untouched and releases IN_PROGRESS when generation fails", async () => {
    generateTextMock.mockRejectedValueOnce(new Error("provider failed"));
    const { service, prisma, tx } = setup();

    await expect((service as any).compactIfNeeded("thread-1", scope, config))
      .rejects.toThrow("provider failed");

    expect(tx.thread.updateMany).not.toHaveBeenCalled();
    expect(prisma.thread.updateMany).toHaveBeenLastCalledWith(expect.objectContaining({
      where: expect.objectContaining({ compactionState: "IN_PROGRESS" }),
      data: { compactionState: "IDLE" },
    }));
  });
});
