import { describe, expect, it, vi } from "vitest";
import { MemoryFeedbackService } from "./memory-feedback.service";

const scope = {
  organizationId: "org",
  projectId: "project",
  environmentId: "environment",
  userId: "external-user",
};

function setup() {
  const updates: any[] = [];
  const prisma = {
    environment: { findFirst: vi.fn(async () => ({ id: "environment" })) },
    endUser: { findFirst: vi.fn(async () => null) },
    endUserIdentity: {
      findFirst: vi.fn(async () => ({ endUserId: "end-user", subject: "external-user" })),
    },
    memory: {
      findMany: vi.fn(async () => [
        { id: "memory-1", confidence: 0.85, metadata: { source: "judge" } },
      ]),
      update: vi.fn(async (args: any) => {
        updates.push(args);
        return args;
      }),
    },
    $transaction: vi.fn(async (operations: Promise<any>[]) => Promise.all(operations)),
  };
  return { prisma, updates, service: new MemoryFeedbackService(prisma as any) };
}

describe("MemoryFeedbackService clean Turn provenance", () => {
  it("bumps confidence through Memory.sourceTurnIds", async () => {
    const { prisma, updates, service } = setup();
    await expect(service.applyRating(scope, {
      messageId: "turn-1",
      rating: 1,
    })).resolves.toEqual({ updated: 1 });

    expect(prisma.memory.findMany).toHaveBeenCalledWith(expect.objectContaining({
      where: expect.objectContaining({
        environmentId: "environment",
        endUserId: "end-user",
        sourceTurnIds: { has: "turn-1" },
      }),
    }));
    expect(updates[0]).toMatchObject({
      where: { id: "memory-1" },
      data: { confidence: 0.95 },
    });
  });

  it("persists negative feedback against the clean Turn id", async () => {
    const { updates, service } = setup();
    await service.applyRating(scope, {
      messageId: "turn-1",
      rating: -1,
      comment: "incorrect",
    });
    expect(updates[0].data.metadata).toMatchObject({
      source: "judge",
      flaggedByRating: {
        turnId: "turn-1",
        comment: "incorrect",
      },
    });
  });

  it("fails loudly when required persistence fails", async () => {
    const { prisma, service } = setup();
    prisma.memory.findMany.mockRejectedValueOnce(new Error("database unavailable"));
    await expect(service.applyRating(scope, {
      messageId: "turn-1",
      rating: 1,
    })).rejects.toThrow("database unavailable");
  });
});
