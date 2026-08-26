import { beforeEach, describe, expect, it, vi } from "vitest";

const { getSignedUrl } = vi.hoisted(() => {
  process.env.MINIO_PUBLIC_ENDPOINT = "https://uploads.example.test";
  return { getSignedUrl: vi.fn() };
});

vi.mock("@aws-sdk/s3-request-presigner", () => ({ getSignedUrl }));

import { AttachmentUploadError, AttachmentsService } from "./attachments.service";

const scope = {
  organizationId: "organization",
  projectId: "project",
  environmentId: "environment",
};

function database() {
  const row = {
    id: "attachment-1",
    kind: "image",
    mimeType: "image/png",
    bytes: 12,
    originalName: "pixel.png",
    createdAt: new Date("2026-08-24T12:00:00.000Z"),
  };
  return {
    row,
    prisma: {
      messageAttachment: {
        aggregate: vi.fn(async () => ({ _sum: { bytes: 100 } })),
        create: vi.fn(async () => row),
        findFirst: vi.fn(async () => ({ id: row.id })),
        deleteMany: vi.fn(async () => ({ count: 1 })),
      },
    },
  };
}

describe("AttachmentsService presigned upload persistence", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    getSignedUrl.mockResolvedValue("https://uploads.example.test/bucket/object?signature=ephemeral");
  });

  it("persists a scoped row, verifies read-back, and omits storage credentials and keys", async () => {
    const { prisma } = database();
    const service = new AttachmentsService(prisma as any);

    const result = await service.createPresignedUpload({
      scope,
      endUserId: "end-user-1",
      agentId: "agent-1",
      threadId: "thread-1",
      filename: "pixel.png",
      mimeType: "image/png",
      bytes: 12,
    });

    expect(prisma.messageAttachment.aggregate).toHaveBeenCalledWith(expect.objectContaining({
      where: { environment: { project: { organizationId: scope.organizationId } } },
    }));
    expect(prisma.messageAttachment.create).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({
        environmentId: scope.environmentId,
        endUserId: "end-user-1",
        agentId: "agent-1",
        threadId: "thread-1",
      }),
    }));
    expect(prisma.messageAttachment.findFirst).toHaveBeenCalledWith(expect.objectContaining({
      where: expect.objectContaining({
        environmentId: scope.environmentId,
        endUserId: "end-user-1",
        agentId: "agent-1",
        threadId: "thread-1",
        environment: { project: { id: scope.projectId, organizationId: scope.organizationId } },
      }),
    }));
    const serialized = JSON.stringify(result);
    expect(serialized).not.toMatch(/storageKey|secretAccessKey|accessKeyId/);
    expect(prisma.messageAttachment.deleteMany).not.toHaveBeenCalled();
  });

  it("deletes the unbound row when signing fails and returns one stable unavailable error", async () => {
    const { prisma } = database();
    getSignedUrl.mockRejectedValueOnce(new Error("sensitive signer detail"));
    const service = new AttachmentsService(prisma as any);

    await expect(service.createPresignedUpload({
      scope,
      endUserId: "end-user-1",
      agentId: "agent-1",
      threadId: "thread-1",
      filename: "pixel.png",
      mimeType: "image/png",
      bytes: 12,
    })).rejects.toMatchObject({
      code: "ATTACHMENT_STORAGE_UNAVAILABLE",
      message: "Attachment upload is unavailable",
    } satisfies Partial<AttachmentUploadError>);
    expect(prisma.messageAttachment.deleteMany).toHaveBeenCalledWith({
      where: {
        id: "attachment-1",
        environmentId: scope.environmentId,
        endUserId: "end-user-1",
        agentId: "agent-1",
        threadId: "thread-1",
        turnId: null,
      },
    });
  });
});
