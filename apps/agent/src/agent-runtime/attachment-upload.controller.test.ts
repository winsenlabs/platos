import { BadRequestException, NotFoundException } from "@nestjs/common";
import { describe, expect, it, vi } from "vitest";
import { AttachmentUploadController } from "./attachment-upload.controller";

const scope = {
  organizationId: "organization",
  projectId: "project",
  environmentId: "environment",
  userId: "end-user",
  principal: "end-user",
} as const;

function request() {
  return { scope } as any;
}

describe("AttachmentUploadController", () => {
  it("authorizes the Thread, persists through the service, and returns only safe upload metadata", async () => {
    const conversations = {
      getThread: vi.fn(async () => ({ id: "thread-1", agentId: "agent-1", endUserId: "end-user-1" })),
    };
    const attachments = {
      createPresignedUpload: vi.fn(async () => ({
        attachmentId: "attachment-1",
        uploadUrl: "https://storage.example/upload?signature=ephemeral",
        method: "PUT",
        headers: { "Content-Type": "image/png" },
        expiresAt: "2026-08-24T12:15:00.000Z",
        maxBytes: 20_000_000,
        attachment: {
          id: "attachment-1",
          kind: "image",
          mimeType: "image/png",
          bytes: 12,
          originalName: "pixel.png",
          createdAt: "2026-08-24T12:00:00.000Z",
        },
      })),
    };
    const controller = new AttachmentUploadController(conversations as any, attachments as any);

    const result = await controller.presign(request(), {
      agentId: "agent-1",
      threadId: "thread-1",
      filename: "pixel.png",
      mimeType: "image/png",
      bytes: 12,
    });

    expect(conversations.getThread).toHaveBeenCalledWith("thread-1", scope);
    expect(attachments.createPresignedUpload).toHaveBeenCalledWith(expect.objectContaining({
      scope,
      endUserId: "end-user-1",
      agentId: "agent-1",
      threadId: "thread-1",
    }));
    const serialized = JSON.stringify(result);
    expect(serialized).not.toContain("storageKey");
    expect(serialized).not.toContain("secretAccessKey");
    expect(serialized).not.toContain("accessKeyId");
  });

  it("rejects malformed metadata before any scoped read", async () => {
    const conversations = { getThread: vi.fn() };
    const controller = new AttachmentUploadController(conversations as any, {} as any);

    await expect(controller.presign(request(), {
      agentId: "agent-1",
      threadId: "thread-1",
      mimeType: "image/png",
      bytes: 0,
    })).rejects.toBeInstanceOf(BadRequestException);
    expect(conversations.getThread).not.toHaveBeenCalled();
  });

  it("allows an operator to select a Thread owner only inside the scoped Environment", async () => {
    const operatorScope = { ...scope, userId: "operator-1", principal: "operator" } as const;
    const conversations = {
      getThread: vi.fn(async () => ({ id: "thread-1", agentId: "agent-1", endUserId: "end-user-1" })),
    };
    const attachments = {
      createPresignedUpload: vi.fn(async () => ({ attachmentId: "attachment-1" })),
    };
    const controller = new AttachmentUploadController(conversations as any, attachments as any);

    await controller.presign({ scope: operatorScope } as any, {
      agentId: "agent-1",
      threadId: "thread-1",
      mimeType: "text/plain",
      bytes: 12,
    });

    expect(conversations.getThread).toHaveBeenCalledWith("thread-1", operatorScope, {
      allUsers: true,
    });
    expect(attachments.createPresignedUpload).toHaveBeenCalledWith(expect.objectContaining({
      scope: operatorScope,
      endUserId: "end-user-1",
      agentId: "agent-1",
      threadId: "thread-1",
    }));
  });

  it("returns the same not-found shape for a cross-scope or wrong-Agent Thread", async () => {
    const conversations = { getThread: vi.fn(async () => null) };
    const controller = new AttachmentUploadController(conversations as any, {} as any);
    const body = { agentId: "agent-1", threadId: "thread-other", mimeType: "image/png", bytes: 12 };

    await expect(controller.presign(request(), body)).rejects.toMatchObject({
      response: { code: "THREAD_NOT_FOUND", message: "Thread not found" },
    });

    conversations.getThread.mockResolvedValueOnce({ id: "thread-1", agentId: "agent-other", endUserId: "end-user-1" } as any);
    await expect(controller.presign(request(), body)).rejects.toBeInstanceOf(NotFoundException);
  });
});
