import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  requireUserId: vi.fn(),
  resolveAndVerifyScope: vi.fn(),
  createPresignedUpload: vi.fn(),
  createPresignedDownload: vi.fn(),
  deleteAttachment: vi.fn(),
}));

vi.mock("~/services/session.server", () => ({ requireUserId: mocks.requireUserId }));
vi.mock("~/services/platos/scopeVerify.server", () => ({
  resolveAndVerifyScope: mocks.resolveAndVerifyScope,
  scopeErrorStatus: () => 403,
}));
vi.mock("~/services/platosAttachments.server", () => ({
  createPresignedUpload: mocks.createPresignedUpload,
  createPresignedDownload: mocks.createPresignedDownload,
  deleteAttachment: mocks.deleteAttachment,
}));
vi.mock("~/services/logger.server", () => ({
  logger: { warn: vi.fn(), info: vi.fn(), debug: vi.fn() },
}));

import { action as presign } from "~/routes/api.v1.agent.attachments.presigned";
import {
  action as remove,
  loader as download,
} from "~/routes/api.v1.agent.attachments.$attachmentId";

const scopeQuery = "organizationId=org_1&projectId=project_1&environmentId=env_1";
const forbidden = {
  ok: false,
  error: { kind: "forbidden", message: "User does not have required project access" },
};

describe("attachment route project authorization", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.requireUserId.mockResolvedValue("user_1");
    mocks.resolveAndVerifyScope.mockResolvedValue(forbidden);
  });

  it("requires mutation access before reserving upload quota", async () => {
    const response = await presign({
      request: new Request("https://platos.example/api/v1/agent/attachments/presigned", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          organizationId: "org_1",
          projectId: "project_1",
          environmentId: "env_1",
          mimeType: "text/plain",
          bytes: 1,
        }),
      }),
      params: {},
      context: {},
    } as any);

    expect(response.status).toBe(403);
    expect(mocks.resolveAndVerifyScope).toHaveBeenCalledWith(
      expect.objectContaining({ projectId: "project_1" }),
      "user_1",
      "mutate",
    );
    expect(mocks.createPresignedUpload).not.toHaveBeenCalled();
  });

  it("requires project read membership before minting a download URL", async () => {
    const response = await download({
      request: new Request(`https://platos.example/api/v1/agent/attachments/a?${scopeQuery}`),
      params: { attachmentId: "attachment_1" },
      context: {},
    } as any);

    expect(response.status).toBe(403);
    expect(mocks.resolveAndVerifyScope).toHaveBeenCalledWith(
      expect.objectContaining({ projectId: "project_1" }),
      "user_1",
      "read",
    );
    expect(mocks.createPresignedDownload).not.toHaveBeenCalled();
  });

  it("requires mutation access before deleting metadata or storage", async () => {
    const response = await remove({
      request: new Request(`https://platos.example/api/v1/agent/attachments/a?${scopeQuery}`, {
        method: "DELETE",
      }),
      params: { attachmentId: "attachment_1" },
      context: {},
    } as any);

    expect(response.status).toBe(403);
    expect(mocks.resolveAndVerifyScope).toHaveBeenCalledWith(
      expect.objectContaining({ projectId: "project_1" }),
      "user_1",
      "mutate",
    );
    expect(mocks.deleteAttachment).not.toHaveBeenCalled();
  });
});
