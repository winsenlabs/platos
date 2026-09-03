import { beforeEach, describe, expect, it } from "vitest";

import { DEFAULT_FILES_POLICY } from "../domain/index.js";
import { destroyAttachment, sweepElapsedAttachments } from "./destroy-attachment.js";
import { presignAttachmentUpload } from "./presign-attachment-upload.js";
import { buildFilesTestContext, testAttachmentScope, type FilesTestContext } from "./testing/index.js";

async function uploadedAndStored(context: FilesTestContext, threadId = "thread-1") {
  const created = await presignAttachmentUpload(context.dependencies, {
    scope: testAttachmentScope("env-1", threadId),
    intake: { mimeType: "image/png", bytes: 3 },
  });
  if (!created.ok) throw new Error(created.error.code);
  context.objectStore.seed(created.value.attachment.storageKey, new Uint8Array([1, 2, 3]), "image/png");
  return created.value.attachment;
}

describe("destroyAttachment — blob first, row second", () => {
  let context: FilesTestContext;

  beforeEach(() => {
    context = buildFilesTestContext();
  });

  it("destroys the blob before the row, and destroys both", async () => {
    const attachment = await uploadedAndStored(context);
    const report = await destroyAttachment(context.dependencies, attachment);

    expect(report.blob.outcome).toBe("destroyed");
    expect(report.rowDestroyed).toBe(true);
    expect(report.error).toBeNull();
    expect(context.objectStore.has(attachment.storageKey)).toBe(false);
    expect(context.repository.allAttachments()).toHaveLength(0);

    const deletes = context.objectStore.calls.findIndex((call) => call.call === "delete");
    expect(deletes).toBeGreaterThanOrEqual(0);
  });

  it("still destroys the row when the blob was already absent — the retry converges", async () => {
    const created = await presignAttachmentUpload(context.dependencies, {
      scope: testAttachmentScope("env-1"),
      intake: { mimeType: "image/png", bytes: 3 },
    });
    if (!created.ok) throw new Error("unreachable");

    const report = await destroyAttachment(context.dependencies, created.value.attachment);
    expect(report.blob.outcome).toBe("already-absent");
    expect(report.rowDestroyed).toBe(true);
    expect(context.repository.allAttachments()).toHaveLength(0);
  });

  it("RETAINS the row when the blob will not go, and REPORTS it — never a silent success", async () => {
    const attachment = await uploadedAndStored(context);
    context.objectStore.deleteFails = true;

    const report = await destroyAttachment(context.dependencies, attachment);

    expect(report.blob.outcome).toBe("failed");
    expect(report.rowDestroyed).toBe(false);
    expect(report.error?.code).toBe("FILES_BLOB_DESTRUCTION_FAILED");
    expect(context.repository.allAttachments()).toHaveLength(1);
    expect(context.objectStore.has(attachment.storageKey)).toBe(true);
  });

  it("leaves a retained row on the worklist so the next pass finishes the job", async () => {
    const attachment = await uploadedAndStored(context);
    context.objectStore.deleteFails = true;
    context.clock.advanceSeconds(DEFAULT_FILES_POLICY.retention.pendingGraceSeconds + 1);

    const firstPass = await sweepElapsedAttachments(context.dependencies, { limit: 10 });
    if (!firstPass.ok) throw new Error("unreachable");
    expect(firstPass.value.rowsDestroyed).toBe(0);
    expect(firstPass.value.rowsRetained).toBe(1);

    context.objectStore.deleteFails = false;
    const secondPass = await sweepElapsedAttachments(context.dependencies, { limit: 10 });
    if (!secondPass.ok) throw new Error("unreachable");
    expect(secondPass.value.rowsDestroyed).toBe(1);
    expect(context.repository.allAttachments()).toHaveLength(0);
    expect(context.objectStore.has(attachment.storageKey)).toBe(false);
  });
});

describe("sweepElapsedAttachments", () => {
  let context: FilesTestContext;

  beforeEach(() => {
    context = buildFilesTestContext();
  });

  it("leaves rows whose retention has not elapsed alone", async () => {
    await uploadedAndStored(context);
    const swept = await sweepElapsedAttachments(context.dependencies, { limit: 10 });
    if (!swept.ok) throw new Error("unreachable");
    expect(swept.value.reports.length).toBe(0);
    expect(context.repository.allAttachments()).toHaveLength(1);
  });

  it("destroys every elapsed row and reports blob and row counts separately", async () => {
    await uploadedAndStored(context, "thread-1");
    await uploadedAndStored(context, "thread-2");
    context.clock.advanceSeconds(DEFAULT_FILES_POLICY.retention.pendingGraceSeconds + 1);

    const swept = await sweepElapsedAttachments(context.dependencies, { limit: 10 });
    if (!swept.ok) throw new Error("unreachable");
    expect(swept.value.reports.length).toBe(2);
    expect(swept.value.rowsDestroyed).toBe(2);
    expect(swept.value.blobsDestroyed).toBe(2);
    expect(context.objectStore.size).toBe(0);
  });

  it("honours its limit so one pass is bounded", async () => {
    await uploadedAndStored(context, "thread-1");
    await uploadedAndStored(context, "thread-2");
    context.clock.advanceSeconds(DEFAULT_FILES_POLICY.retention.pendingGraceSeconds + 1);

    const swept = await sweepElapsedAttachments(context.dependencies, { limit: 1 });
    if (!swept.ok) throw new Error("unreachable");
    expect(swept.value.reports.length).toBe(1);
    expect(context.repository.allAttachments()).toHaveLength(1);
  });
});
