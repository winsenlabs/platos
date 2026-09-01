import { asIdentifier } from "@platos/kernel";
import { beforeEach, describe, expect, it } from "vitest";

import { DEFAULT_FILES_POLICY, type ContentHash } from "../domain/index.js";
import { presignAttachmentUpload } from "./presign-attachment-upload.js";
import { buildFilesTestContext, testAttachmentScope, type FilesTestContext } from "./testing/index.js";

const HASH = asIdentifier<ContentHash>("sha256:abc");

describe("presignAttachmentUpload", () => {
  let context: FilesTestContext;

  beforeEach(() => {
    context = buildFilesTestContext();
  });

  it("mints a row with a derived key and returns an upload grant", async () => {
    const scope = testAttachmentScope("env-1");
    const result = await presignAttachmentUpload(context.dependencies, {
      scope,
      intake: { mimeType: "image/png", bytes: 1024, originalName: "photo.png" },
    });

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("unreachable");
    expect(result.value.attachment.storageKey).toBe(
      "org/org-1/proj/proj-1/env/env-1/thread/thread-1/attachment/id-0001/photo.png",
    );
    expect(result.value.attachment.binding.state).toBe("pending");
    expect(result.value.grant?.method).toBe("PUT");
    expect(result.value.grant?.requiredHeaders["content-type"]).toBe("image/png");
    expect(result.value.origin.origin).toBe("upload");
    expect(context.repository.allAttachments()).toHaveLength(1);
  });

  it("gives the pending row the short grace window, not the full retention window", async () => {
    const issuedAt = context.clock.now();
    const result = await presignAttachmentUpload(context.dependencies, {
      scope: testAttachmentScope("env-1"),
      intake: { mimeType: "image/png", bytes: 1024 },
    });
    if (!result.ok) throw new Error("unreachable");
    const expiresAt = result.value.attachment.expiresAt;
    expect(expiresAt).not.toBeNull();
    expect((expiresAt?.getTime() ?? 0) - issuedAt.getTime()).toBe(
      DEFAULT_FILES_POLICY.retention.pendingGraceSeconds * 1000,
    );
  });

  it("bounds the grant to the policy window measured from the injected clock", async () => {
    const result = await presignAttachmentUpload(context.dependencies, {
      scope: testAttachmentScope("env-1"),
      intake: { mimeType: "image/png", bytes: 1024 },
    });
    if (!result.ok) throw new Error("unreachable");
    const grant = result.value.grant;
    expect(grant).not.toBeNull();
    expect((grant?.expiresAt.getTime() ?? 0) - (grant?.issuedAt.getTime() ?? 0)).toBe(
      DEFAULT_FILES_POLICY.upload.uploadWindowSeconds * 1000,
    );
  });

  it("refuses a window longer than policy permits", async () => {
    const denied = await presignAttachmentUpload(context.dependencies, {
      scope: testAttachmentScope("env-1"),
      intake: { mimeType: "image/png", bytes: 1024 },
      windowSeconds: DEFAULT_FILES_POLICY.upload.maxWindowSeconds + 1,
    });
    expect(denied.ok).toBe(false);
    if (denied.ok) throw new Error("unreachable");
    expect(denied.error.code).toBe("FILES_PRESIGN_WINDOW_INVALID");
    expect(context.repository.allAttachments()).toHaveLength(0);
  });

  it("refuses once the organization quota would be crossed, before minting a row", async () => {
    const small = { ...DEFAULT_FILES_POLICY, upload: { ...DEFAULT_FILES_POLICY.upload, organizationQuotaBytes: 100 } };
    const tight = buildFilesTestContext(small);
    const denied = await presignAttachmentUpload(tight.dependencies, {
      scope: testAttachmentScope("env-1"),
      intake: { mimeType: "image/png", bytes: 101 },
    });
    expect(denied.ok).toBe(false);
    if (denied.ok) throw new Error("unreachable");
    expect(denied.error.code).toBe("FILES_ATTACHMENT_QUOTA_EXCEEDED");
    expect(tight.repository.allAttachments()).toHaveLength(0);
    expect(tight.objectStore.calls).toHaveLength(0);
  });

  describe("content-hash dedupe", () => {
    it("copies server-side inside one environment and asks the client for nothing", async () => {
      const scope = testAttachmentScope("env-1");
      const first = await presignAttachmentUpload(context.dependencies, {
        scope,
        intake: { mimeType: "image/png", bytes: 1024, contentHash: HASH },
      });
      if (!first.ok) throw new Error("unreachable");
      context.objectStore.seed(first.value.attachment.storageKey, new Uint8Array([1, 2, 3]), "image/png");

      const second = await presignAttachmentUpload(context.dependencies, {
        scope: testAttachmentScope("env-1", "thread-2"),
        intake: { mimeType: "image/png", bytes: 1024, contentHash: HASH },
      });
      expect(second.ok).toBe(true);
      if (!second.ok) throw new Error("unreachable");
      expect(second.value.origin.origin).toBe("copy-from");
      expect(second.value.grant).toBeNull();
      expect(context.objectStore.callsTo("copy")).toHaveLength(1);
      expect(context.objectStore.has(second.value.attachment.storageKey)).toBe(true);
      expect(second.value.attachment.storageKey).not.toBe(first.value.attachment.storageKey);
    });

    it("REFUSES to reuse a matching hash from a different environment", async () => {
      const first = await presignAttachmentUpload(context.dependencies, {
        scope: testAttachmentScope("env-1"),
        intake: { mimeType: "image/png", bytes: 1024, contentHash: HASH },
      });
      if (!first.ok) throw new Error("unreachable");
      context.objectStore.seed(first.value.attachment.storageKey, new Uint8Array([1]), "image/png");

      const other = await presignAttachmentUpload(context.dependencies, {
        scope: testAttachmentScope("env-2"),
        intake: { mimeType: "image/png", bytes: 1024, contentHash: HASH },
      });
      if (!other.ok) throw new Error("unreachable");
      expect(other.value.origin.origin).toBe("upload");
      expect(other.value.grant).not.toBeNull();
      expect(context.objectStore.callsTo("copy")).toHaveLength(0);
    });
  });

  describe("rollback when the store cannot seed the blob", () => {
    it("removes the row it minted, leaving nothing orphaned", async () => {
      context.objectStore.presignFails = true;
      const denied = await presignAttachmentUpload(context.dependencies, {
        scope: testAttachmentScope("env-1"),
        intake: { mimeType: "image/png", bytes: 1024 },
      });
      expect(denied.ok).toBe(false);
      expect(context.repository.allAttachments()).toHaveLength(0);
      expect(context.objectStore.size).toBe(0);
      expect(context.objectStore.callsTo("delete")).toHaveLength(1);
    });

    it("RETAINS the row when the rollback's blob destruction itself fails, and reports it", async () => {
      context.objectStore.presignFails = true;
      context.objectStore.deleteFails = true;
      const denied = await presignAttachmentUpload(context.dependencies, {
        scope: testAttachmentScope("env-1"),
        intake: { mimeType: "image/png", bytes: 1024 },
      });
      expect(denied.ok).toBe(false);
      if (denied.ok) throw new Error("unreachable");
      expect(denied.error.code).toBe("FILES_BLOB_DESTRUCTION_FAILED");
      expect(context.repository.allAttachments()).toHaveLength(1);
    });
  });
});
