import { describe, expect, it, vi } from "vitest";
import { AttachmentsService } from "./attachments.service";

const scope = {
  organizationId: "organization",
  projectId: "project",
  environmentId: "environment",
};
const boundary = {
  agentId: "agent-1",
  threadId: "thread-1",
  endUserId: "end-user-1",
};

describe("AttachmentsService pending boundary binding", () => {
  it("binds once and treats a repeated bind to the same Turn as idempotent", async () => {
    const tx = {
      turn: { findFirst: vi.fn(async () => ({ id: "turn-1" })) },
      messageAttachment: {
        findMany: vi.fn(async () => [{ id: "attachment-1" }]),
        updateMany: vi.fn(async () => ({ count: 0 })),
        count: vi.fn(async () => 1),
      },
    };
    const prisma = {
      $transaction: vi.fn(async (callback: (client: typeof tx) => unknown) => callback(tx)),
    };
    const service = new AttachmentsService(prisma as any);

    await expect(service.markAttachedToMessage(
      ["attachment-1", "attachment-1"],
      "turn-1",
      scope,
      boundary,
    )).resolves.toBeUndefined();

    expect(tx.turn.findFirst).toHaveBeenCalledWith(expect.objectContaining({
      where: expect.objectContaining({ id: "turn-1", threadId: "thread-1" }),
    }));
    expect(tx.messageAttachment.findMany).toHaveBeenCalledWith(expect.objectContaining({
      where: expect.objectContaining({
        id: { in: ["attachment-1"] },
        agentId: "agent-1",
        threadId: "thread-1",
        endUserId: "end-user-1",
        OR: [{ turnId: null }, { turnId: "turn-1" }],
      }),
    }));
    expect(tx.messageAttachment.updateMany).toHaveBeenCalledWith(expect.objectContaining({
      where: expect.objectContaining({ turnId: null, agentId: "agent-1", threadId: "thread-1" }),
      data: expect.objectContaining({ turnId: "turn-1" }),
    }));
    expect(tx.messageAttachment.count).toHaveBeenCalledWith(expect.objectContaining({
      where: expect.objectContaining({ turnId: "turn-1", agentId: "agent-1", threadId: "thread-1" }),
    }));
  });

  it("refuses to rebind an attachment already bound outside the requested Turn", async () => {
    const updateMany = vi.fn();
    const tx = {
      turn: { findFirst: vi.fn(async () => ({ id: "turn-2" })) },
      messageAttachment: {
        findMany: vi.fn(async () => []),
        updateMany,
        count: vi.fn(),
      },
    };
    const prisma = {
      $transaction: vi.fn(async (callback: (client: typeof tx) => unknown) => callback(tx)),
    };
    const service = new AttachmentsService(prisma as any);

    await expect(service.markAttachedToMessage(
      ["attachment-1"],
      "turn-2",
      scope,
      boundary,
    )).rejects.toThrow("Attachment binding does not match its pending Agent and Thread boundary");
    expect(updateMany).not.toHaveBeenCalled();
  });
});
