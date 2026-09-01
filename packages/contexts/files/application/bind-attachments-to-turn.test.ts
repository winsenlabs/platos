import { asIdentifier } from "@platos/kernel";
import { beforeEach, describe, expect, it } from "vitest";

import { DEFAULT_FILES_POLICY, toThreadScope, type AttachmentId, type TurnId } from "../domain/index.js";
import { bindAttachmentsToTurn } from "./bind-attachments-to-turn.js";
import { presignAttachmentUpload } from "./presign-attachment-upload.js";
import { buildFilesTestContext, testAttachmentScope, testThreadScope, type FilesTestContext } from "./testing/index.js";

const TURN = asIdentifier<TurnId>("turn-1");

async function upload(context: FilesTestContext, environmentId: string, threadId = "thread-1"): Promise<AttachmentId> {
  const created = await presignAttachmentUpload(context.dependencies, {
    scope: testAttachmentScope(environmentId, threadId),
    intake: { mimeType: "image/png", bytes: 16 },
  });
  if (!created.ok) throw new Error(created.error.code);
  return created.value.attachment.attachmentId;
}

describe("bindAttachmentsToTurn", () => {
  let context: FilesTestContext;

  beforeEach(() => {
    context = buildFilesTestContext();
  });

  it("binds every named attachment and extends retention to the bound window", async () => {
    const boundAt = context.clock.now();
    const first = await upload(context, "env-1");
    const second = await upload(context, "env-1");

    const bound = await bindAttachmentsToTurn(context.dependencies, {
      scope: testThreadScope("env-1"),
      attachmentIds: [first, second],
      turnId: TURN,
    });

    expect(bound.ok).toBe(true);
    if (!bound.ok) throw new Error("unreachable");
    expect(bound.value).toHaveLength(2);
    for (const attachment of bound.value) {
      expect(attachment.binding).toEqual({ state: "bound", turnId: TURN });
      expect((attachment.expiresAt?.getTime() ?? 0) - boundAt.getTime()).toBe(
        DEFAULT_FILES_POLICY.retention.boundRetentionSeconds * 1000,
      );
    }
  });

  it("collapses duplicate ids rather than binding twice", async () => {
    const only = await upload(context, "env-1");
    const bound = await bindAttachmentsToTurn(context.dependencies, {
      scope: testThreadScope("env-1"),
      attachmentIds: [only, only, only],
      turnId: TURN,
    });
    if (!bound.ok) throw new Error("unreachable");
    expect(bound.value).toHaveLength(1);
  });

  it("is idempotent when the same turn binds again", async () => {
    const only = await upload(context, "env-1");
    const command = { scope: testThreadScope("env-1"), attachmentIds: [only], turnId: TURN };
    expect((await bindAttachmentsToTurn(context.dependencies, command)).ok).toBe(true);
    expect((await bindAttachmentsToTurn(context.dependencies, command)).ok).toBe(true);
  });

  it("REFUSES to re-point a bound attachment at a second turn", async () => {
    const only = await upload(context, "env-1");
    await bindAttachmentsToTurn(context.dependencies, {
      scope: testThreadScope("env-1"),
      attachmentIds: [only],
      turnId: TURN,
    });
    const moved = await bindAttachmentsToTurn(context.dependencies, {
      scope: testThreadScope("env-1"),
      attachmentIds: [only],
      turnId: asIdentifier<TurnId>("turn-2"),
    });
    expect(moved.ok).toBe(false);
    if (moved.ok) throw new Error("unreachable");
    expect(moved.error.code).toBe("FILES_ATTACHMENT_BINDING_CONFLICT");
  });

  it("binds NOTHING when one named id is outside the scope — all or nothing", async () => {
    const mine = await upload(context, "env-1");
    const theirs = await upload(context, "env-2");

    const denied = await bindAttachmentsToTurn(context.dependencies, {
      scope: testThreadScope("env-1"),
      attachmentIds: [mine, theirs],
      turnId: TURN,
    });

    expect(denied.ok).toBe(false);
    if (denied.ok) throw new Error("unreachable");
    expect(denied.error.code).toBe("FILES_ATTACHMENT_NOT_FOUND");
    const untouched = context.repository
      .allAttachments()
      .find((attachment) => attachment.attachmentId === mine);
    expect(untouched?.binding.state).toBe("pending");
  });

  it("reports an id from another environment as absent, not as forbidden-but-present", async () => {
    const theirs = await upload(context, "env-2");
    const found = await context.repository.findAttachment(testThreadScope("env-1"), theirs);
    if (!found.ok) throw new Error("unreachable");
    expect(found.value).toBeNull();
  });

  it("REFUSES to bind an attachment whose retention has already elapsed", async () => {
    const only = await upload(context, "env-1");
    context.clock.advanceSeconds(DEFAULT_FILES_POLICY.retention.pendingGraceSeconds + 1);
    const denied = await bindAttachmentsToTurn(context.dependencies, {
      scope: testThreadScope("env-1"),
      attachmentIds: [only],
      turnId: TURN,
    });
    expect(denied.ok).toBe(false);
    if (denied.ok) throw new Error("unreachable");
    expect(denied.error.code).toBe("FILES_ATTACHMENT_RETENTION_ELAPSED");
  });

  it("binds nothing when asked for nothing", async () => {
    const bound = await bindAttachmentsToTurn(context.dependencies, {
      scope: testThreadScope("env-1"),
      attachmentIds: [],
      turnId: TURN,
    });
    if (!bound.ok) throw new Error("unreachable");
    expect(bound.value).toHaveLength(0);
  });

  it("keeps the derived key verifiable against the owning scope after binding", async () => {
    const only = await upload(context, "env-1");
    await bindAttachmentsToTurn(context.dependencies, {
      scope: testThreadScope("env-1"),
      attachmentIds: [only],
      turnId: TURN,
    });
    const row = context.repository.allAttachments()[0];
    expect(row).toBeDefined();
    if (row === undefined) throw new Error("unreachable");
    expect(row.storageKey.startsWith(`org/org-1/proj/proj-1/env/env-1/thread/thread-1/attachment/`)).toBe(true);
    expect(toThreadScope(row.scope).threadId).toBe("thread-1");
  });
});
