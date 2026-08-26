import { describe, expect, it, vi } from "vitest";
import { ConversationService, ThreadNotFoundError } from "./conversation.service";

const scope = {
  organizationId: "organization",
  projectId: "project",
  environmentId: "environment",
  userId: "end-user",
} as any;

const turns = Array.from({ length: 30 }, (_, index) => ({
  id: `turn-${index + 1}`,
  threadId: "thread-1",
  sequence: index + 1,
  status: "SUCCEEDED",
  inputText: `user-${index + 1}`,
  outputText: `assistant-${index + 1}`,
  output: null,
  thinkingContent: null,
  agentVersionId: "version-1",
  versionBucket: "CURRENT",
  costCents: null,
  latencyMs: null,
  completedAt: new Date("2026-08-24T00:00:01.000Z"),
  createdAt: new Date("2026-08-24T00:00:00.000Z"),
  steps: [],
}));

function serviceFor(thread: object | null = { id: "thread-1" }) {
  const findMany = vi.fn(async (args: any) => {
    if (args.select) return turns.map(({ id, status }) => ({ id, status }));
    const ids = new Set(args.where.id.in as string[]);
    return turns.filter((turn) => ids.has(turn.id));
  });
  const service = new ConversationService({ turn: { findMany } } as any);
  (service as any).getThread = vi.fn(async () => thread);
  return service;
}

describe("ConversationService truthful Message pagination", () => {
  it.each([
    ["first", 0, 25, 25, "user-1", "user-13"],
    ["middle", 25, 25, 25, "assistant-13", "assistant-25"],
    ["final partial", 50, 25, 10, "user-26", "assistant-30"],
    ["past end", 75, 25, 0, undefined, undefined],
  ])("returns the %s page with one stable total", async (_label, offset, limit, length, first, last) => {
    const page = await serviceFor().getMessages("thread-1", scope, { offset, limit });
    expect(page.total).toBe(60);
    expect(page.messages).toHaveLength(length);
    expect(page.messages[0]?.content).toBe(first);
    expect(page.messages.at(-1)?.content).toBe(last);
  });

  it("returns an empty first page with total zero for a genuinely empty Thread", async () => {
    const findMany = vi.fn(async () => []);
    const service = new ConversationService({ turn: { findMany } } as any);
    (service as any).getThread = vi.fn(async () => ({ id: "thread-1" }));
    await expect(service.getMessages("thread-1", scope, { limit: 25 })).resolves.toEqual({ messages: [], total: 0 });
  });

  it("uses a stable not-found error for missing and cross-scope Threads", async () => {
    await expect(serviceFor(null).getMessages("thread-other", scope)).rejects.toBeInstanceOf(ThreadNotFoundError);
  });

  it("filters a requested Agent Thread list through canonical Environment ancestry", async () => {
    const findMany = vi.fn().mockResolvedValue([]);
    const count = vi.fn().mockResolvedValue(0);
    const service = new ConversationService({ thread: { findMany, count } } as any);

    await expect(service.listThreads(
      { ...scope, principal: "operator" },
      { agentId: "agent-a", allUsers: true, limit: 25, offset: 0 },
    )).resolves.toEqual({ threads: [], total: 0 });

    const where = {
      environmentId: "environment",
      environment: {
        projectId: "project",
        project: { organizationId: "organization" },
      },
      agentId: "agent-a",
      archivedAt: null,
    };
    expect(findMany).toHaveBeenCalledWith(expect.objectContaining({ where, take: 25, skip: 0 }));
    expect(count).toHaveBeenCalledWith({ where });
  });
});
