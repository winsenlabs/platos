import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  prisma: {
    environment: { findFirst: vi.fn() },
    organizationMembership: { findUnique: vi.fn() },
    projectMembership: { findUnique: vi.fn() },
    attachmentUploadReservation: { findFirst: vi.fn(), deleteMany: vi.fn() },
    messageAttachment: { findFirst: vi.fn(), deleteMany: vi.fn() },
  },
  reserveAttachmentUpload: vi.fn(),
  reconcileAttachmentUploadBytes: vi.fn(),
}));

vi.mock("~/db.server", () => ({ prisma: mocks.prisma }));
vi.mock("~/env.server", () => ({
  env: {
    MINIO_REGION: "us-east-1",
    MINIO_ENDPOINT: "http://minio:9000",
    MINIO_PUBLIC_ENDPOINT: "http://localhost:9000",
    MINIO_ACCESS_KEY: "test",
    MINIO_SECRET_KEY: "test",
    MINIO_BUCKET: "test",
    PLATOS_ATTACHMENT_MAX_BYTES: 1024,
    PLATOS_ATTACHMENT_ORG_QUOTA_BYTES: 4096,
    PLATOS_ATTACHMENT_PRESIGN_TTL_SECONDS: 900,
  },
}));
vi.mock("~/services/logger.server", () => ({
  logger: { info: vi.fn(), warn: vi.fn(), debug: vi.fn() },
}));
vi.mock("@platos/database", () => ({
  OrganizationRole: { OWNER: "OWNER", ADMIN: "ADMIN", MEMBER: "MEMBER" },
  ProjectRole: { ADMIN: "ADMIN", EDITOR: "EDITOR", VIEWER: "VIEWER" },
  reserveAttachmentUpload: mocks.reserveAttachmentUpload,
  reconcileAttachmentUploadBytes: mocks.reconcileAttachmentUploadBytes,
  sweepExpiredAttachmentUploadReservations: vi.fn(),
}));

import {
  createPresignedDownload,
  createPresignedUpload,
} from "~/services/platosAttachments.server";

const scope = {
  organizationId: "org_1",
  projectId: "project_1",
  environmentId: "env_1",
  userId: "user_1",
};

describe("Platos attachment service authorization", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.prisma.environment.findFirst.mockResolvedValue({ id: "env_1" });
    mocks.prisma.organizationMembership.findUnique.mockResolvedValue({
      id: "membership_1",
      role: "MEMBER",
      deactivatedAt: null,
    });
    mocks.prisma.projectMembership.findUnique.mockResolvedValue(null);
  });

  it("does not treat ordinary organization ownership as upload authorization", async () => {
    await expect(createPresignedUpload({
      scope,
      mimeType: "text/plain",
      bytes: 1,
    })).rejects.toThrow("Attachment scope is not accessible");
    expect(mocks.reserveAttachmentUpload).not.toHaveBeenCalled();
  });

  it("does not mint download URLs without canonical project membership", async () => {
    await expect(createPresignedDownload("reservation_1", scope))
      .rejects.toThrow("Attachment scope is not accessible");
    expect(mocks.prisma.attachmentUploadReservation.findFirst).not.toHaveBeenCalled();
  });
});
