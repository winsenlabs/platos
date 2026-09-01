import { beforeEach, describe, expect, it } from "vitest";

import { DEFAULT_FILES_POLICY } from "../domain/index.js";
import { presignAttachmentUpload } from "./presign-attachment-upload.js";
import { issueAttachmentDownload, readAttachmentContent, redeemAttachmentDownload } from "./read-attachment.js";
import { buildFilesTestContext, testAttachmentScope, testThreadScope, type FilesTestContext } from "./testing/index.js";

async function uploadInto(context: FilesTestContext, environmentId: string) {
  const created = await presignAttachmentUpload(context.dependencies, {
    scope: testAttachmentScope(environmentId),
    intake: { mimeType: "image/png", bytes: 3, originalName: "photo.png" },
  });
  if (!created.ok) throw new Error(created.error.code);
  context.objectStore.seed(created.value.attachment.storageKey, new Uint8Array([1, 2, 3]), "image/png");
  return created.value.attachment;
}

describe("issueAttachmentDownload", () => {
  let context: FilesTestContext;

  beforeEach(() => {
    context = buildFilesTestContext();
  });

  it("mints a GET grant bounded by the download window", async () => {
    const attachment = await uploadInto(context, "env-1");
    const issued = await issueAttachmentDownload(context.dependencies, {
      scope: testThreadScope("env-1"),
      attachmentId: attachment.attachmentId,
    });
    expect(issued.ok).toBe(true);
    if (!issued.ok) throw new Error("unreachable");
    expect(issued.value.grant.method).toBe("GET");
    expect(issued.value.grant.expiresAt.getTime() - issued.value.grant.issuedAt.getTime()).toBe(
      DEFAULT_FILES_POLICY.upload.downloadWindowSeconds * 1000,
    );
  });

  it("reports an attachment from another environment as absent", async () => {
    const attachment = await uploadInto(context, "env-2");
    const denied = await issueAttachmentDownload(context.dependencies, {
      scope: testThreadScope("env-1"),
      attachmentId: attachment.attachmentId,
    });
    expect(denied.ok).toBe(false);
    if (denied.ok) throw new Error("unreachable");
    expect(denied.error.code).toBe("FILES_ATTACHMENT_NOT_FOUND");
    expect(context.objectStore.callsTo("presignDownload")).toHaveLength(0);
  });
});

describe("redeemAttachmentDownload — the elapsed-grant negative control", () => {
  let context: FilesTestContext;

  beforeEach(() => {
    context = buildFilesTestContext();
  });

  it("fetches the bytes while the grant is live", async () => {
    const attachment = await uploadInto(context, "env-1");
    const issued = await issueAttachmentDownload(context.dependencies, {
      scope: testThreadScope("env-1"),
      attachmentId: attachment.attachmentId,
    });
    if (!issued.ok) throw new Error("unreachable");

    const fetched = await redeemAttachmentDownload(context.dependencies, {
      scope: testThreadScope("env-1"),
      grant: issued.value.grant,
    });
    expect(fetched.ok).toBe(true);
    if (!fetched.ok) throw new Error("unreachable");
    expect([...fetched.value.content]).toEqual([1, 2, 3]);
  });

  it("REFUSES a grant past its expiry, and never calls the store", async () => {
    const attachment = await uploadInto(context, "env-1");
    const issued = await issueAttachmentDownload(context.dependencies, {
      scope: testThreadScope("env-1"),
      attachmentId: attachment.attachmentId,
    });
    if (!issued.ok) throw new Error("unreachable");

    const getsBefore = context.objectStore.callsTo("get").length;
    context.clock.advanceSeconds(DEFAULT_FILES_POLICY.upload.downloadWindowSeconds + 1);

    const denied = await redeemAttachmentDownload(context.dependencies, {
      scope: testThreadScope("env-1"),
      grant: issued.value.grant,
    });
    expect(denied.ok).toBe(false);
    if (denied.ok) throw new Error("unreachable");
    expect(denied.error.code).toBe("FILES_PRESIGNED_GRANT_ELAPSED");
    expect(context.objectStore.callsTo("get")).toHaveLength(getsBefore);
  });

  it("REFUSES a live grant presented under a different environment's scope", async () => {
    const attachment = await uploadInto(context, "env-1");
    const issued = await issueAttachmentDownload(context.dependencies, {
      scope: testThreadScope("env-1"),
      attachmentId: attachment.attachmentId,
    });
    if (!issued.ok) throw new Error("unreachable");

    const denied = await redeemAttachmentDownload(context.dependencies, {
      scope: testThreadScope("env-2"),
      grant: issued.value.grant,
    });
    expect(denied.ok).toBe(false);
    if (denied.ok) throw new Error("unreachable");
    expect(denied.error.code).toBe("FILES_STORAGE_KEY_SCOPE_MISMATCH");
    expect(denied.error.category).toBe("forbidden");
  });
});

describe("readAttachmentContent", () => {
  it("reports a dangling pointer as an absent object rather than empty bytes", async () => {
    const context = buildFilesTestContext();
    const created = await presignAttachmentUpload(context.dependencies, {
      scope: testAttachmentScope("env-1"),
      intake: { mimeType: "image/png", bytes: 3 },
    });
    if (!created.ok) throw new Error("unreachable");

    const missing = await readAttachmentContent(context.dependencies, created.value.attachment);
    expect(missing.ok).toBe(false);
    if (missing.ok) throw new Error("unreachable");
    expect(missing.error.code).toBe("FILES_OBJECT_NOT_FOUND");
  });
});
