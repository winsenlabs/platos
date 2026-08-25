import { describe, expect, it, vi } from "vitest";
import type { RequestScope } from "../auth/scope.guard";
import {
  ConversationService,
  ThreadNotFoundError,
  type Thread,
} from "./conversation.service";

const operatorScope: RequestScope = {
  organizationId: "organization",
  projectId: "project",
  environmentId: "environment",
  userId: "operator-user",
  principal: "operator",
};

function thread(overrides: Partial<Thread> = {}): Thread {
  return {
    id: "reserved-thread",
    agentId: "agent-a",
    organizationId: "organization",
    projectId: "project",
    environmentId: "environment",
    userId: "seeded-end-user",
    endUserId: "end-user-id",
    title: null,
    status: "SUCCEEDED",
    turnCount: 0,
    compactedSummary: null,
    compactedUpToTurnId: null,
    compactionState: "IDLE",
    tags: [],
    pinnedAt: null,
    archivedAt: null,
    parentThreadId: null,
    forkedUpToTurnId: null,
    forkedTurnIds: [],
    clusterId: null,
    createdAt: new Date("2026-08-24T00:00:00.000Z"),
    updatedAt: new Date("2026-08-24T00:00:00.000Z"),
    ...overrides,
  };
}

function harness(resolved: Thread | null) {
  const service = new ConversationService({
    agentBinding: { findFirst: vi.fn().mockResolvedValue({ clusterId: null }) },
  } as any);
  const getThread = vi.spyOn(service, "getThread").mockResolvedValue(resolved);
  const createThread = vi.spyOn(service, "createThread").mockResolvedValue(thread({ id: "replacement" }));
  return { service, getThread, createThread };
}

describe("ConversationService reserved Thread resolution", () => {
  it("lets an operator retain an in-scope EndUser Thread for the requested Agent", async () => {
    const reserved = thread();
    const { service, getThread, createThread } = harness(reserved);

    await expect(service.getOrCreateThread(
      operatorScope,
      "agent-a",
      reserved.id,
    )).resolves.toBe(reserved);

    expect(getThread).toHaveBeenCalledWith(
      reserved.id,
      { ...operatorScope, agentId: "agent-a" },
      { allUsers: true },
    );
    expect(createThread).not.toHaveBeenCalled();
  });

  it("fails closed instead of replacing an inaccessible supplied Thread", async () => {
    const { service, createThread } = harness(null);

    await expect(service.getOrCreateThread(
      operatorScope,
      "agent-a",
      "inaccessible-thread",
    )).rejects.toBeInstanceOf(ThreadNotFoundError);
    expect(createThread).not.toHaveBeenCalled();
  });

  it("fails closed instead of replacing a supplied Thread owned by another Agent", async () => {
    const { service, createThread } = harness(thread({ agentId: "agent-b" }));

    await expect(service.getOrCreateThread(
      operatorScope,
      "agent-a",
      "wrong-agent-thread",
    )).rejects.toBeInstanceOf(ThreadNotFoundError);
    expect(createThread).not.toHaveBeenCalled();
  });

  it("retains a sibling-Agent Thread only inside the authorized Agent cluster", async () => {
    const sibling = thread({ agentId: "agent-b", clusterId: "cluster-a" });
    const { service, createThread } = harness(sibling);

    await expect(service.getOrCreateThread(
      { ...operatorScope, clusteringId: "cluster-a" },
      "agent-a",
      sibling.id,
    )).resolves.toBe(sibling);
    expect(createThread).not.toHaveBeenCalled();
  });

  it("derives the persisted Agent cluster before resolving a sibling Thread", async () => {
    const sibling = thread({ agentId: "agent-b", clusterId: "cluster-a" });
    const service = new ConversationService({
      agentBinding: { findFirst: vi.fn().mockResolvedValue({ clusterId: "cluster-a" }) },
    } as any);
    const getThread = vi.spyOn(service, "getThread").mockResolvedValue(sibling);

    await expect(service.getOrCreateThread(
      operatorScope,
      "agent-a",
      sibling.id,
    )).resolves.toBe(sibling);
    expect(getThread).toHaveBeenCalledWith(
      sibling.id,
      { ...operatorScope, agentId: "agent-a", clusteringId: "cluster-a" },
      { allUsers: true },
    );
  });

  it("uses the same operator ownership policy for history and Turn persistence", async () => {
    const service = new ConversationService({ turn: { findMany: vi.fn().mockResolvedValue([]) } } as any);
    const getThread = vi.spyOn(service, "getThread").mockResolvedValue(thread());
    await expect(service.loadHistory("reserved-thread", operatorScope)).resolves.toEqual([]);
    expect(getThread).toHaveBeenCalledWith(
      "reserved-thread",
      operatorScope,
      { allUsers: true },
    );

    const findScopedThread = vi
      .spyOn(service as any, "findScopedThread")
      .mockRejectedValue(new Error("stop after authorization"));
    await expect(service.storeMessage("reserved-thread", operatorScope, {
      role: "user",
      content: "marker",
      agentVersionId: "version-a",
      versionBucket: "CURRENT",
    })).rejects.toThrow("stop after authorization");
    expect(findScopedThread).toHaveBeenCalledWith(
      "reserved-thread",
      operatorScope,
      { allUsers: true },
    );
  });
});
