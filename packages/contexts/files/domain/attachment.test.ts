import { asIdentifier, environmentScope } from "@platos/kernel";
import { describe, expect, it } from "vitest";

import {
  ATTACHMENT_KIND_AUDIO,
  ATTACHMENT_KIND_DOCUMENT,
  ATTACHMENT_KIND_IMAGE,
  ATTACHMENT_KIND_VIDEO,
  attachmentRetentionHasElapsed,
  attachmentTurnId,
  bindAttachment,
  classifyAttachmentKind,
  NO_MEDIA_DIMENSIONS,
  PENDING_BINDING,
  type Attachment,
} from "./attachment.js";
import {
  admitAttachment,
  admitAgainstQuota,
  admitTurnTotal,
  boundExpiry,
  decideBlobOrigin,
  pendingExpiry,
} from "./attachment-intake.js";
import type { AgentId, AttachmentId, ContentHash, EndUserId, StorageKey, ThreadId, TurnId } from "./identifiers.js";
import { DEFAULT_FILES_POLICY } from "./policy.js";
import { attachmentScope, threadScope, type AttachmentScope } from "./scope.js";
import { deriveAttachmentStorageKey } from "./storage-key.js";

const NOW = new Date("2026-01-01T00:00:00.000Z");

function scopeIn(environmentId: string, threadId = "thread-1"): AttachmentScope {
  return attachmentScope(
    threadScope(
      environmentScope(asIdentifier("org-1"), asIdentifier("proj-1"), asIdentifier(environmentId)),
      asIdentifier<ThreadId>(threadId),
    ),
    { endUserId: asIdentifier<EndUserId>("eu-1"), agentId: asIdentifier<AgentId>("ag-1") },
  );
}

function attachmentIn(scope: AttachmentScope, overrides: Partial<Attachment> = {}): Attachment {
  const attachmentId = overrides.attachmentId ?? asIdentifier<AttachmentId>("att-1");
  return {
    attachmentId,
    scope,
    binding: PENDING_BINDING,
    kind: ATTACHMENT_KIND_IMAGE,
    mimeType: "image/png",
    bytes: 1024,
    media: NO_MEDIA_DIMENSIONS,
    storageKey: deriveAttachmentStorageKey(scope, attachmentId, "photo.png"),
    originalName: "photo.png",
    contentHash: null,
    createdAt: NOW,
    expiresAt: new Date(NOW.getTime() + 60_000),
    ...overrides,
  };
}

describe("classifyAttachmentKind", () => {
  it("keeps the four values the current classifier produces", () => {
    expect(classifyAttachmentKind("image/png")).toBe(ATTACHMENT_KIND_IMAGE);
    expect(classifyAttachmentKind("AUDIO/mpeg")).toBe(ATTACHMENT_KIND_AUDIO);
    expect(classifyAttachmentKind("video/mp4")).toBe(ATTACHMENT_KIND_VIDEO);
    expect(classifyAttachmentKind("application/pdf")).toBe(ATTACHMENT_KIND_DOCUMENT);
  });
});

describe("admitAttachment", () => {
  const policy = DEFAULT_FILES_POLICY.upload;

  it("normalises the media type and classifies an omitted kind", () => {
    const admitted = admitAttachment({ mimeType: "  IMAGE/PNG ", bytes: 10 }, policy);
    expect(admitted.ok).toBe(true);
    if (!admitted.ok) throw new Error("unreachable");
    expect(admitted.value.mimeType).toBe("image/png");
    expect(admitted.value.kind).toBe(ATTACHMENT_KIND_IMAGE);
  });

  it("keeps `kind` an OPEN string — a value outside the four is accepted verbatim", () => {
    const admitted = admitAttachment({ mimeType: "application/x-thing", bytes: 10, kind: "spreadsheet" }, policy);
    expect(admitted.ok).toBe(true);
    if (!admitted.ok) throw new Error("unreachable");
    expect(admitted.value.kind).toBe("spreadsheet");
  });

  it("keeps `mimeType` open too — shape is checked, membership is not", () => {
    const admitted = admitAttachment({ mimeType: "application/vnd.acme.widget+json", bytes: 10 }, policy);
    expect(admitted.ok).toBe(true);
  });

  it("rejects a malformed media type", () => {
    const admitted = admitAttachment({ mimeType: "not-a-media-type", bytes: 10 }, policy);
    expect(admitted.ok).toBe(false);
    if (admitted.ok) throw new Error("unreachable");
    expect(admitted.error.code).toBe("FILES_ATTACHMENT_METADATA_INVALID");
  });

  it("rejects a non-positive or non-integral byte count", () => {
    for (const bytes of [0, -1, 1.5, Number.NaN]) {
      const admitted = admitAttachment({ mimeType: "image/png", bytes }, policy);
      expect(admitted.ok).toBe(false);
    }
  });

  it("rejects an oversized attachment before any byte moves", () => {
    const admitted = admitAttachment({ mimeType: "image/png", bytes: policy.maxAttachmentBytes + 1 }, policy);
    expect(admitted.ok).toBe(false);
    if (admitted.ok) throw new Error("unreachable");
    expect(admitted.error.code).toBe("FILES_ATTACHMENT_TOO_LARGE");
  });
});

describe("quota and per-turn budgets", () => {
  const policy = DEFAULT_FILES_POLICY.upload;

  it("refuses the request that would cross the organization quota", () => {
    const denied = admitAgainstQuota(policy.organizationQuotaBytes, 1, policy);
    expect(denied.ok).toBe(false);
    if (denied.ok) throw new Error("unreachable");
    expect(denied.error.code).toBe("FILES_ATTACHMENT_QUOTA_EXCEEDED");
  });

  it("refuses a turn whose summed bytes cross the per-turn budget", () => {
    const scope = scopeIn("env-1");
    const many = Array.from({ length: 5 }, (_unused, index) =>
      attachmentIn(scope, {
        attachmentId: asIdentifier<AttachmentId>(`att-${index}`),
        bytes: policy.maxAttachmentBytes,
      }),
    );
    const denied = admitTurnTotal(many, policy);
    expect(denied.ok).toBe(false);
  });
});

describe("retention windows", () => {
  it("gives a pending upload the short grace window and a bound one the long window", () => {
    const pending = pendingExpiry(NOW, DEFAULT_FILES_POLICY.retention);
    const bound = boundExpiry(NOW, DEFAULT_FILES_POLICY.retention);
    expect(pending.getTime()).toBeLessThan(bound.getTime());
    expect(pending.getTime() - NOW.getTime()).toBe(7 * 86_400 * 1000);
    expect(bound.getTime() - NOW.getTime()).toBe(30 * 86_400 * 1000);
  });

  it("treats an elapsed expiry as elapsed and a null expiry as indefinite", () => {
    const scope = scopeIn("env-1");
    const elapsed = attachmentIn(scope, { expiresAt: new Date(NOW.getTime() - 1) });
    expect(attachmentRetentionHasElapsed(elapsed, NOW)).toBe(true);
    const forever = attachmentIn(scope, { expiresAt: null });
    expect(attachmentRetentionHasElapsed(forever, NOW)).toBe(false);
  });
});

describe("bindAttachment", () => {
  const scope = scopeIn("env-1");
  const turn = asIdentifier<TurnId>("turn-1");
  const retainUntil = boundExpiry(NOW, DEFAULT_FILES_POLICY.retention);

  it("binds a pending attachment and extends its retention", () => {
    const bound = bindAttachment(attachmentIn(scope), turn, retainUntil, NOW);
    expect(bound.ok).toBe(true);
    if (!bound.ok) throw new Error("unreachable");
    expect(attachmentTurnId(bound.value)).toBe(turn);
    expect(bound.value.expiresAt).toEqual(retainUntil);
  });

  it("is idempotent for a repeat of the SAME turn — delivery is at-least-once", () => {
    const once = bindAttachment(attachmentIn(scope), turn, retainUntil, NOW);
    if (!once.ok) throw new Error("unreachable");
    const twice = bindAttachment(once.value, turn, retainUntil, NOW);
    expect(twice.ok).toBe(true);
  });

  it("REFUSES to re-point a bound attachment at a different turn", () => {
    const once = bindAttachment(attachmentIn(scope), turn, retainUntil, NOW);
    if (!once.ok) throw new Error("unreachable");
    const moved = bindAttachment(once.value, asIdentifier<TurnId>("turn-2"), retainUntil, NOW);
    expect(moved.ok).toBe(false);
    if (moved.ok) throw new Error("unreachable");
    expect(moved.error.code).toBe("FILES_ATTACHMENT_BINDING_CONFLICT");
    expect(moved.error.category).toBe("conflict");
  });

  it("REFUSES to bind an attachment whose retention has already elapsed", () => {
    const stale = attachmentIn(scope, { expiresAt: new Date(NOW.getTime() - 1) });
    const bound = bindAttachment(stale, turn, retainUntil, NOW);
    expect(bound.ok).toBe(false);
    if (bound.ok) throw new Error("unreachable");
    expect(bound.error.code).toBe("FILES_ATTACHMENT_RETENTION_ELAPSED");
  });
});

describe("decideBlobOrigin — content-hash dedupe", () => {
  const hash = asIdentifier<ContentHash>("sha256:abc");
  const here = scopeIn("env-1");

  it("uploads when there is no hash or no candidate", () => {
    expect(decideBlobOrigin(here, null, null).origin).toBe("upload");
    expect(decideBlobOrigin(here, hash, null).origin).toBe("upload");
  });

  it("copies server-side from a matching row in the same environment", () => {
    const candidate = attachmentIn(scopeIn("env-1", "thread-9"), {
      attachmentId: asIdentifier<AttachmentId>("att-9"),
      contentHash: hash,
    });
    const decision = decideBlobOrigin(here, hash, candidate);
    expect(decision.origin).toBe("copy-from");
    if (decision.origin !== "copy-from") throw new Error("unreachable");
    expect(decision.sourceKey).toBe(candidate.storageKey);
  });

  it("REFUSES to reuse a matching hash from another environment", () => {
    const foreign = attachmentIn(scopeIn("env-2"), {
      attachmentId: asIdentifier<AttachmentId>("att-9"),
      contentHash: hash,
    });
    expect(decideBlobOrigin(here, hash, foreign).origin).toBe("upload");
  });

  it("REFUSES to reuse a candidate whose key does not verify against its own scope", () => {
    const tampered = attachmentIn(scopeIn("env-1", "thread-9"), {
      attachmentId: asIdentifier<AttachmentId>("att-9"),
      contentHash: hash,
      storageKey: "org/other/proj/x/env/y/thread/z/attachment/a/b" as StorageKey,
    });
    expect(decideBlobOrigin(here, hash, tampered).origin).toBe("upload");
  });
});
