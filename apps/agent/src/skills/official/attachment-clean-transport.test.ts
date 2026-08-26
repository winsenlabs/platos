import { describe, expect, it, vi } from "vitest";
import { OfficialSkillHandlers } from "./skill-handlers";

const scope = {
  organizationId: "org-a",
  projectId: "project-a",
  environmentId: "env-a",
  userId: "user-a",
  agentId: "agent-a",
  threadId: "thread-a",
} as any;

describe("OfficialSkillHandlers clean attachment transport", () => {
  it("fails closed for RAG attachment sources that carry only Environment scope", async () => {
    const handler = new OfficialSkillHandlers(
      { get: vi.fn() } as any,
      undefined,
      undefined,
    );

    await expect((handler as any).ragResolveSource(
      {
        organizationId: scope.organizationId,
        projectId: scope.projectId,
        environmentId: scope.environmentId,
      },
      "attachmentId:attachment-a",
    )).rejects.toThrow("requires an authenticated Agent and Thread boundary");
  });

  it("requires the persisted EndUser, Agent, Thread, and final Turn binding", async () => {
    const findAttachment = vi.fn(async () => ({
      id: "attachment-a",
      storageKey: "objects/attachment-a",
      originalName: "notes.txt",
      bytes: 123,
    }));
    const prisma = {
      endUserIdentity: {
        findFirst: vi.fn(async () => ({
          endUserId: "end-user-a",
          subject: "user-a",
        })),
      },
      messageAttachment: { findFirst: findAttachment },
    };
    const handler = new OfficialSkillHandlers(
      { get: vi.fn() } as any,
      undefined,
      undefined,
    );

    await expect((handler as any).resolveSandboxAttachment(
      scope,
      "attachment-a",
      { prisma },
    )).resolves.toEqual({
      id: "attachment-a",
      storageKey: "objects/attachment-a",
      filename: "notes.txt",
      bytes: 123,
    });

    expect(findAttachment).toHaveBeenCalledWith({
      where: {
        id: "attachment-a",
        endUserId: "end-user-a",
        agentId: "agent-a",
        threadId: "thread-a",
        turnId: { not: null },
        environmentId: "env-a",
        environment: {
          projectId: "project-a",
          project: { organizationId: "org-a" },
        },
      },
      select: {
        id: true,
        storageKey: true,
        originalName: true,
        bytes: true,
      },
    });
  });

  it("fails closed when the runtime does not carry an acting Agent", async () => {
    const prisma = {
      messageAttachment: { findFirst: vi.fn() },
    };
    const handler = new OfficialSkillHandlers(
      { get: vi.fn() } as any,
      undefined,
      undefined,
    );

    await expect((handler as any).resolveSandboxAttachment(
      { ...scope, agentId: null },
      "attachment-a",
      { prisma },
    )).rejects.toThrow("acting Agent is required");
    expect(prisma.messageAttachment.findFirst).not.toHaveBeenCalled();
  });

  it("fails closed when the runtime does not carry an acting Thread", async () => {
    const prisma = { messageAttachment: { findFirst: vi.fn() } };
    const handler = new OfficialSkillHandlers(
      { get: vi.fn() } as any,
      undefined,
      undefined,
    );

    await expect((handler as any).resolveSandboxAttachment(
      { ...scope, threadId: null },
      "attachment-a",
      { prisma },
    )).rejects.toThrow("acting Thread is required");
    expect(prisma.messageAttachment.findFirst).not.toHaveBeenCalled();
  });
});
