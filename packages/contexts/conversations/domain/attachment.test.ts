// Attachments: five ceilings and five codes, where the source has three codes
// for five decisions.
//
// Mutations M-A1 (count), M-A2 (per-file bytes), M-A3 (media type), M-A4
// (ownership), M-A5 (per-turn bytes). The last two are the ones the source
// cannot distinguish: it carries a `kind` inside one error class for the two
// size ceilings, and a transport switching on the code cannot see a `kind`.

import { describe, expect, it } from "vitest";
import { asIdentifier } from "@platos/kernel";

import { admitAttachments, contentPartKindFor, type AttachmentCandidate } from "./attachment.js";
import { DEFAULT_CONVERSATIONS_POLICY } from "./policy.js";
import type { ThreadId } from "./identifiers.js";

const POLICY = DEFAULT_CONVERSATIONS_POLICY.attachment;
const THREAD = asIdentifier<ThreadId>("thread-1");

function file(overrides: Partial<AttachmentCandidate> = {}): AttachmentCandidate {
  return {
    fileId: "file-1",
    mediaType: "image/png",
    bytes: 1_024,
    threadId: THREAD,
    ...overrides,
  };
}

describe("admitAttachments", () => {
  it("admits a set and reports the EXACT total bytes", () => {
    const admitted = admitAttachments(
      THREAD,
      [file({ fileId: "a", bytes: 1_000 }), file({ fileId: "b", bytes: 2_500 })],
      POLICY,
    );
    expect(admitted.ok).toBe(true);
    if (!admitted.ok) return;
    expect(admitted.value.totalBytes).toBe(3_500);
    expect(admitted.value.candidates).toHaveLength(2);
  });

  it("admits an empty set at exactly zero bytes", () => {
    const admitted = admitAttachments(THREAD, [], POLICY);
    expect(admitted.ok).toBe(true);
    if (!admitted.ok) return;
    expect(admitted.value.totalBytes).toBe(0);
  });

  it("refuses one file over the per-file ceiling", () => {
    const refused = admitAttachments(
      THREAD,
      [file({ bytes: POLICY.maxBytesPerAttachment + 1 })],
      POLICY,
    );
    expect(refused.ok).toBe(false);
    if (refused.ok) return;
    expect(refused.error.code).toBe("CONVERSATIONS_ATTACHMENT_TOO_LARGE");
    expect(refused.error.details.maximum).toBe(POLICY.maxBytesPerAttachment);
  });

  it("refuses the per-TURN total with a DIFFERENT code, every file being legal", () => {
    const each = POLICY.maxBytesPerAttachment;
    const count = Math.ceil(POLICY.maxBytesPerTurn / each) + 1;
    const files = Array.from({ length: count }, (_, index) =>
      file({ fileId: `f-${index}`, bytes: each }),
    );
    const refused = admitAttachments(THREAD, files, {
      ...POLICY,
      maxAttachmentsPerTurn: count,
    });
    expect(refused.ok).toBe(false);
    if (refused.ok) return;
    // Every file is inside the per-file ceiling. The source reports this with
    // the same error class and a `kind` field a transport cannot switch on.
    expect(refused.error.code).toBe("CONVERSATIONS_ATTACHMENT_TURN_TOO_LARGE");
    expect(refused.error.details.maximum).toBe(POLICY.maxBytesPerTurn);
  });

  it("refuses too MANY files, each of them one byte", () => {
    const files = Array.from({ length: POLICY.maxAttachmentsPerTurn + 1 }, (_, index) =>
      file({ fileId: `f-${index}`, bytes: 1 }),
    );
    const refused = admitAttachments(THREAD, files, POLICY);
    expect(refused.ok).toBe(false);
    if (refused.ok) return;
    // Neither byte ceiling is anywhere near breached; the count ceiling is the
    // only thing between an agent and a thousand attachments.
    expect(refused.error.code).toBe("CONVERSATIONS_ATTACHMENT_COUNT_EXCEEDED");
    expect(refused.error.details.count).toBe(POLICY.maxAttachmentsPerTurn + 1);
  });

  it("admits exactly the count ceiling", () => {
    const files = Array.from({ length: POLICY.maxAttachmentsPerTurn }, (_, index) =>
      file({ fileId: `f-${index}`, bytes: 1 }),
    );
    expect(admitAttachments(THREAD, files, POLICY).ok).toBe(true);
  });

  it("refuses a media type no prompt content part can carry", () => {
    const refused = admitAttachments(THREAD, [file({ mediaType: "application/x-tar" })], POLICY);
    expect(refused.ok).toBe(false);
    if (refused.ok) return;
    // The source drops these silently, so a caller learns their file was ignored
    // by reading a model answer that does not mention it.
    expect(refused.error.code).toBe("CONVERSATIONS_ATTACHMENT_MEDIA_TYPE_REFUSED");
    expect(refused.error.details.mediaType).toBe("application/x-tar");
  });

  it("admits every prefix the policy names", () => {
    for (const prefix of POLICY.promptableMediaTypePrefixes) {
      const admitted = admitAttachments(THREAD, [file({ mediaType: `${prefix}` })], POLICY);
      expect(admitted.ok).toBe(true);
    }
  });

  it("refuses a file that hangs off ANOTHER thread", () => {
    const refused = admitAttachments(
      THREAD,
      [file({ threadId: asIdentifier<ThreadId>("thread-2") })],
      POLICY,
    );
    expect(refused.ok).toBe(false);
    if (refused.ok) return;
    expect(refused.error.code).toBe("CONVERSATIONS_ATTACHMENT_FOREIGN");
    expect(refused.error.category).toBe("forbidden");
  });

  it("refuses a file that hangs off NO thread", () => {
    const refused = admitAttachments(THREAD, [file({ threadId: null })], POLICY);
    expect(refused.ok).toBe(false);
    if (refused.ok) return;
    expect(refused.error.code).toBe("CONVERSATIONS_ATTACHMENT_FOREIGN");
  });

  it("reports the COUNT breach first when a request breaches count and size", () => {
    const files = Array.from({ length: POLICY.maxAttachmentsPerTurn + 1 }, (_, index) =>
      file({ fileId: `f-${index}`, bytes: POLICY.maxBytesPerAttachment + 1 }),
    );
    const refused = admitAttachments(THREAD, files, POLICY);
    expect(refused.ok).toBe(false);
    if (refused.ok) return;
    expect(refused.error.code).toBe("CONVERSATIONS_ATTACHMENT_COUNT_EXCEEDED");
  });
});

describe("contentPartKindFor", () => {
  it("routes an image to the image part and everything else to the file part", () => {
    expect(contentPartKindFor("image/png")).toBe("image");
    expect(contentPartKindFor("image/jpeg")).toBe("image");
    expect(contentPartKindFor("application/pdf")).toBe("file");
    expect(contentPartKindFor("text/plain")).toBe("file");
  });
});
