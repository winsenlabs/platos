import { describe, expect, it, vi } from "vitest";
import { ConversationService } from "./conversation.service";

const scope = {
  organizationId: "organization",
  projectId: "project",
  environmentId: "environment",
  userId: "operator",
  principal: "operator",
} as any;

const parent = {
  id: "thread-parent",
  agentId: "agent-1",
  organizationId: scope.organizationId,
  projectId: scope.projectId,
  environmentId: scope.environmentId,
  userId: "end-user-1",
  endUserId: "end-user-1",
  title: "Parent",
  status: "active",
  turnCount: 3,
  compactedSummary: null,
  compactedUpToTurnId: null,
  compactionState: "idle",
  tags: [],
  pinnedAt: null,
  archivedAt: null,
  parentThreadId: null,
  forkedUpToTurnId: null,
  forkedTurnIds: [],
  clusterId: null,
  createdAt: new Date("2026-08-24T00:00:00.000Z"),
  updatedAt: new Date("2026-08-24T00:00:00.000Z"),
};

describe("ConversationService non-billable fork ancestry", () => {
  it("persists ordered Turn references and never clones Turn, Step, or ToolCall rows", async () => {
    const turnCreate = vi.fn();
    const threadCreate = vi.fn(async ({ data }: any) => ({ id: "thread-child", ...data }));
    const childRow = { id: "thread-child", parentThreadId: parent.id, forkedUpToTurnId: "turn-2", forkedTurnIds: ["turn-1", "turn-2"] };
    const tx = {
      thread: {
        create: threadCreate,
        findUniqueOrThrow: vi.fn(async () => childRow),
      },
      turn: { create: turnCreate },
      step: { create: vi.fn() },
      toolCall: { create: vi.fn() },
    };
    const prisma = {
      turn: {
        findMany: vi.fn(async () => [
          { id: "turn-1", status: "SUCCEEDED" },
          { id: "turn-2", status: "SUCCEEDED" },
          { id: "turn-3", status: "SUCCEEDED" },
        ]),
      },
      thread: { count: vi.fn(async () => 0) },
      $transaction: vi.fn(async (callback: (client: typeof tx) => unknown) => callback(tx)),
    };
    const service = new ConversationService(prisma as any);
    (service as any).findScopedThread = vi.fn(async () => parent);
    (service as any).projectThread = vi.fn(async (row: unknown) => row);

    await expect(service.forkThread(parent.id, scope, { upToMessageId: "turn-2", allUsers: true }))
      .resolves.toEqual(childRow);

    expect(threadCreate).toHaveBeenCalledWith({ data: expect.objectContaining({
      parentThreadId: parent.id,
      forkedUpToTurnId: "turn-2",
      forkedTurnIds: ["turn-1", "turn-2"],
    }) });
    expect(turnCreate).not.toHaveBeenCalled();
    expect(tx.step.create).not.toHaveBeenCalled();
    expect(tx.toolCall.create).not.toHaveBeenCalled();
  });

  it("reads inherited ancestry before local child Turns without duplicating rows", async () => {
    const inherited = {
      id: "turn-parent",
      threadId: "thread-parent",
      sequence: 1,
      status: "SUCCEEDED",
      inputText: "parent input",
      outputText: "parent output",
      createdAt: new Date("2026-08-24T00:00:00.000Z"),
      completedAt: new Date("2026-08-24T00:00:01.000Z"),
      steps: [],
      agentVersionId: "version-1",
      versionBucket: "CURRENT",
    };
    const local = { ...inherited, id: "turn-child", threadId: "thread-child", inputText: "child input", outputText: "child output" };
    const findMany = vi.fn(async (args: any) => {
      if (args.select && args.where.id) return [{ id: inherited.id, status: inherited.status }];
      if (args.select) return [{ id: local.id, status: local.status }];
      return [inherited, local].filter((turn) => args.where.id.in.includes(turn.id));
    });
    const service = new ConversationService({ turn: { findMany } } as any);
    (service as any).getThread = vi.fn(async () => ({ ...parent, id: "thread-child", forkedTurnIds: [inherited.id] }));

    const result = await service.getMessages("thread-child", scope, { limit: 10, allUsers: true });

    expect(result.total).toBe(4);
    expect(result.messages.map((message) => message.content)).toEqual([
      "parent input",
      "parent output",
      "child input",
      "child output",
    ]);
  });
});

const artifactRows = Array.from({ length: 60 }, (_, index) => {
  const number = index + 1;
  const base = {
    artifactKey: `artifact-${number.toString().padStart(2, "0")}`,
    kind: "document",
    title: `Artifact ${number}`,
    mimeType: "text/plain",
    metadata: {},
    producedByTurnId: null,
    createdAt: new Date(Date.UTC(2026, 7, 24, 0, 0, number)),
  };
  return [
    { ...base, id: `latest-${number.toString().padStart(2, "0")}`, revision: 2, content: `latest ${number}` },
    { ...base, id: `old-${number.toString().padStart(2, "0")}`, revision: 1, content: `old ${number}` },
  ];
}).flat();

describe("ConversationService stable Artifact pagination", () => {
  const serviceForArtifacts = () => {
    const artifact = {
      groupBy: vi.fn(async (args: any) => {
        const requestedKeys = args.where?.artifactKey?.in as string[] | undefined;
        if (args._count) {
          return (requestedKeys ?? []).map((artifactKey) => ({
            artifactKey,
            _count: { _all: 2 },
          }));
        }
        return artifactRows
          .filter((row) => row.revision === 2)
          .sort((left, right) => right.createdAt.getTime() - left.createdAt.getTime())
          .slice(args.skip, args.skip + args.take)
          .map((row) => ({ artifactKey: row.artifactKey, _max: { createdAt: row.createdAt } }));
      }),
      findMany: vi.fn(async (args: any) => {
        const requestedKeys = args.where.artifactKey.in as string[];
        return artifactRows
          .filter((row) => row.revision === 2 && requestedKeys.includes(row.artifactKey))
          .sort((left, right) => left.artifactKey.localeCompare(right.artifactKey));
      }),
    };
    const prisma = {
      artifact,
      $transaction: vi.fn(async (callback: (tx: any) => unknown) => callback({
        artifact,
        $queryRaw: vi.fn(async () => [{ total: 60n }]),
      })),
    };
    const service = new ConversationService(prisma as any);
    (service as any).findScopedThread = vi.fn(async () => parent);
    return { service, artifact };
  };

  it.each([
    ["first", 0, 25, 25, "Artifact 60", "Artifact 36"],
    ["middle", 25, 25, 25, "Artifact 35", "Artifact 11"],
    ["final", 50, 25, 10, "Artifact 10", "Artifact 1"],
    ["past end", 75, 25, 0, undefined, undefined],
  ])("returns the %s page after latest-revision grouping", async (_label, offset, limit, length, first, last) => {
    const { service, artifact } = serviceForArtifacts();
    const page = await service.listThreadArtifactsPage(parent.id, scope, { offset, limit, allUsers: true });
    expect(page.total).toBe(60);
    expect(page.artifacts).toHaveLength(length);
    expect(page.artifacts[0]?.title).toBe(first);
    expect(page.artifacts.at(-1)?.title).toBe(last);
    expect(page.artifacts.every((artifact: any) => artifact.revision === 2 && artifact.revisionCount === 2)).toBe(true);
  });

  it("returns an empty collection with total zero", async () => {
    const artifact = {
      groupBy: vi.fn(async () => []),
      findMany: vi.fn(async () => []),
    };
    const service = new ConversationService({
      artifact,
      $transaction: vi.fn(async (callback: (tx: any) => unknown) => callback({
        artifact,
        $queryRaw: vi.fn(async () => [{ total: 0n }]),
      })),
    } as any);
    (service as any).findScopedThread = vi.fn(async () => parent);
    await expect(service.listThreadArtifactsPage(parent.id, scope, { offset: 0, limit: 25 }))
      .resolves.toEqual({ artifacts: [], total: 0 });
  });
});
