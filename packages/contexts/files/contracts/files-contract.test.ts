// End-to-end through the PUBLISHED surface only.
//
// Everything below goes through `FilesContract`, the one entrypoint `skills` and
// `conversations` may import. If a rule is reachable here, it is reachable by
// them; if a rule is only reachable by calling a use case directly, it is not
// really part of the contract.

import { asIdentifier } from "@platos/kernel";
import type { PrincipalId } from "@platos/kernel";
import { beforeEach, describe, expect, it } from "vitest";

import { createFilesContract } from "../application/files-contract.js";
import {
  buildFilesTestContext,
  testAttachmentScope,
  testThreadScope,
  type FilesTestContext,
} from "../application/testing/index.js";
import { DEFAULT_FILES_POLICY } from "../domain/index.js";
import type { ArtifactKey, ContentHash, FilesContract } from "./index.js";

const KEY = asIdentifier<ArtifactKey>("a_report");
const AUTHOR: PrincipalId = asIdentifier("principal-1");

describe("FilesContract", () => {
  let context: FilesTestContext;
  let files: FilesContract;

  beforeEach(() => {
    context = buildFilesTestContext();
    files = createFilesContract(context.dependencies);
  });

  it("names itself", () => {
    expect(files.name).toBe("files");
  });

  it("carries an attachment from upload through binding to download", async () => {
    const uploaded = await files.requestUpload({
      scope: testAttachmentScope("env-1"),
      mimeType: "image/png",
      bytes: 3,
      originalName: "photo.png",
      width: 10,
      height: 20,
    });
    if (!uploaded.ok) throw new Error(uploaded.error.code);
    expect(uploaded.value.deduplicated).toBe(false);
    expect(uploaded.value.grant?.method).toBe("PUT");
    expect(uploaded.value.attachment.width).toBe(10);
    expect(uploaded.value.attachment.turnId).toBeNull();

    const attachmentId = uploaded.value.attachment.attachmentId;
    const stored = context.repository.allAttachments()[0];
    if (stored === undefined) throw new Error("unreachable");
    context.objectStore.seed(stored.storageKey, new Uint8Array([1, 2, 3]), "image/png");

    const bound = await files.bindToTurn({
      scope: testThreadScope("env-1"),
      attachmentIds: [attachmentId],
      turnId: asIdentifier("turn-1"),
    });
    if (!bound.ok) throw new Error(bound.error.code);
    expect(bound.value[0]?.turnId).toBe("turn-1");

    const download = await files.requestDownload({ scope: testThreadScope("env-1"), attachmentId });
    if (!download.ok) throw new Error(download.error.code);
    expect(download.value.grant.method).toBe("GET");

    const described = await files.describeAttachment({ scope: testThreadScope("env-1"), attachmentId });
    if (!described.ok) throw new Error(described.error.code);
    expect(described.value.attachmentId).toBe(attachmentId);
  });

  it("hides another environment's attachment behind `not_found`", async () => {
    const uploaded = await files.requestUpload({
      scope: testAttachmentScope("env-2"),
      mimeType: "image/png",
      bytes: 3,
    });
    if (!uploaded.ok) throw new Error(uploaded.error.code);

    const denied = await files.describeAttachment({
      scope: testThreadScope("env-1"),
      attachmentId: uploaded.value.attachment.attachmentId,
    });
    expect(denied.ok).toBe(false);
    if (denied.ok) throw new Error("unreachable");
    expect(denied.error.code).toBe("FILES_ATTACHMENT_NOT_FOUND");
  });

  it("reports a dedupe as `deduplicated` with no grant to redeem", async () => {
    const first = await files.requestUpload({
      scope: testAttachmentScope("env-1"),
      mimeType: "image/png",
      bytes: 3,
      contentHash: asIdentifier<ContentHash>("sha256:abc"),
    });
    if (!first.ok) throw new Error(first.error.code);
    const stored = context.repository.allAttachments()[0];
    if (stored === undefined) throw new Error("unreachable");
    context.objectStore.seed(stored.storageKey, new Uint8Array([1, 2, 3]), "image/png");

    const second = await files.requestUpload({
      scope: testAttachmentScope("env-1", "thread-2"),
      mimeType: "image/png",
      bytes: 3,
      contentHash: asIdentifier<ContentHash>("sha256:abc"),
    });
    if (!second.ok) throw new Error(second.error.code);
    expect(second.value.deduplicated).toBe(true);
    expect(second.value.grant).toBeNull();
  });

  it("appends artifact revisions and reads back exactly the one asked for", async () => {
    for (const content of ["# one", "# two"]) {
      const written = await files.appendArtifactRevision({
        scope: testThreadScope("env-1"),
        artifactKey: KEY,
        kind: "markdown",
        content,
        createdBy: AUTHOR,
      });
      if (!written.ok) throw new Error(written.error.code);
    }

    const latest = await files.readArtifact({ scope: testThreadScope("env-1"), artifactKey: KEY });
    if (!latest.ok) throw new Error(latest.error.code);
    expect(latest.value.revision).toBe(2);

    const first = await files.readArtifact({ scope: testThreadScope("env-1"), artifactKey: KEY, revision: 1 });
    if (!first.ok) throw new Error(first.error.code);
    expect(first.value.content).toBe("# one");

    const absent = await files.readArtifact({ scope: testThreadScope("env-1"), artifactKey: KEY, revision: 5 });
    expect(absent.ok).toBe(false);
    if (absent.ok) throw new Error("unreachable");
    expect(absent.error.code).toBe("FILES_ARTIFACT_REVISION_NOT_FOUND");
  });

  it("reports a retention sweep per row, including rows it had to retain", async () => {
    const uploaded = await files.requestUpload({
      scope: testAttachmentScope("env-1"),
      mimeType: "image/png",
      bytes: 3,
    });
    if (!uploaded.ok) throw new Error(uploaded.error.code);
    const stored = context.repository.allAttachments()[0];
    if (stored === undefined) throw new Error("unreachable");
    context.objectStore.seed(stored.storageKey, new Uint8Array([1, 2, 3]), "image/png");

    context.clock.advanceSeconds(DEFAULT_FILES_POLICY.retention.pendingGraceSeconds + 1);
    context.objectStore.deleteFails = true;

    const swept = await files.sweepRetention({ limit: 10 });
    if (!swept.ok) throw new Error(swept.error.code);
    expect(swept.value.examined).toBe(1);
    expect(swept.value.rowsDestroyed).toBe(0);
    expect(swept.value.rowsRetained).toBe(1);
    expect(swept.value.reports[0]?.retainedBecause).toBe("FILES_BLOB_DESTRUCTION_FAILED");
    expect(swept.value.reports[0]?.blobDestroyed).toBe(false);
  });

  it("publishes this context's ErasureTarget as a stable instance", () => {
    const target = files.erasureTarget();
    expect(target.targetName).toBe("files");
    expect(files.erasureTarget()).toBe(target);
  });
});
