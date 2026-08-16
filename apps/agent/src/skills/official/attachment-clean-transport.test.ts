import { describe, expect, it, vi } from "vitest";
import { OfficialSkillHandlers } from "./skill-handlers";

const scope = {
  organizationId: "org-a",
  projectId: "project-a",
  environmentId: "env-a",
  userId: "user-a",
  agentId: "agent-a",
} as any;

describe("OfficialSkillHandlers clean attachment transport", () => {
  it("requires clean MessageAttachment ownership through EndUser and Turn/Thread AgentCluster", async () => {
    const findAttachment = vi.fn(async () => ({
      id: "attachment-a",
      storageKey: "objects/attachment-a",
      originalName: "notes.txt",
      bytes: 123,
    }));
    const prisma = {
      endUser: {
        findFirst: vi.fn(async () => ({
          id: "end-user-a",
          identities: [{ subject: "user-a" }],
        })),
      },
      agentBinding: {
        findFirst: vi.fn(async () => ({
          agentId: "agent-a",
          clusterId: "cluster-a",
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
        environmentId: "env-a",
        environment: {
          projectId: "project-a",
          project: { organizationId: "org-a" },
        },
        turn: {
          thread: {
            endUserId: "end-user-a",
            environmentId: "env-a",
            environment: {
              projectId: "project-a",
              project: { organizationId: "org-a" },
            },
            OR: [
              { agentId: "agent-a" },
              { clusterId: "cluster-a" },
            ],
          },
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
      endUser: {
        findFirst: vi.fn(async () => ({
          id: "end-user-a",
          identities: [{ subject: "user-a" }],
        })),
      },
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
});
