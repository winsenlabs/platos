import { asIdentifier, environmentScope } from "@platos/kernel";
import { describe, expect, it } from "vitest";

import type { AttachmentId, EndUserId, AgentId, ThreadId } from "./identifiers.js";
import { attachmentScope, threadScope, toThreadScope, type AttachmentScope } from "./scope.js";
import {
  assertStorageKeyInScope,
  attachmentIdFromStorageKey,
  deriveAttachmentStorageKey,
  sanitizeObjectName,
  storageKeyBelongsToScope,
  storageKeyPrefix,
} from "./storage-key.js";

function scopeIn(organizationId: string, projectId: string, environmentId: string, threadId = "thread-1"): AttachmentScope {
  return attachmentScope(
    threadScope(
      environmentScope(asIdentifier(organizationId), asIdentifier(projectId), asIdentifier(environmentId)),
      asIdentifier<ThreadId>(threadId),
    ),
    { endUserId: asIdentifier<EndUserId>("eu-1"), agentId: asIdentifier<AgentId>("ag-1") },
  );
}

const attachmentId = asIdentifier<AttachmentId>("att-1");

describe("sanitizeObjectName", () => {
  it("collapses everything outside the safe set", () => {
    expect(sanitizeObjectName("my report (final).pdf")).toBe("my_report__final_.pdf");
  });

  it("falls back for an empty or missing name", () => {
    expect(sanitizeObjectName(null)).toBe("file");
    expect(sanitizeObjectName("   ")).toBe("file");
  });

  it("refuses the two traversal segments the character filter leaves intact", () => {
    expect(sanitizeObjectName(".")).toBe("file");
    expect(sanitizeObjectName("..")).toBe("file");
  });

  it("truncates to a bounded segment", () => {
    expect(sanitizeObjectName("a".repeat(400))).toHaveLength(120);
  });
});

describe("deriveAttachmentStorageKey", () => {
  it("is deterministic: the same inputs always give the same key", () => {
    const scope = scopeIn("org-1", "proj-1", "env-1");
    const first = deriveAttachmentStorageKey(scope, attachmentId, "photo.png");
    const second = deriveAttachmentStorageKey(scope, attachmentId, "photo.png");
    expect(first).toBe(second);
    expect(first).toBe("org/org-1/proj/proj-1/env/env-1/thread/thread-1/attachment/att-1/photo.png");
  });

  it("gives two tenants disjoint keys even for identical uploads", () => {
    const left = deriveAttachmentStorageKey(scopeIn("org-1", "proj-1", "env-1"), attachmentId, "photo.png");
    const right = deriveAttachmentStorageKey(scopeIn("org-2", "proj-1", "env-1"), attachmentId, "photo.png");
    expect(left).not.toBe(right);
  });

  it("separates two attachments in one thread that share a filename", () => {
    const scope = scopeIn("org-1", "proj-1", "env-1");
    const left = deriveAttachmentStorageKey(scope, asIdentifier<AttachmentId>("att-1"), "photo.png");
    const right = deriveAttachmentStorageKey(scope, asIdentifier<AttachmentId>("att-2"), "photo.png");
    expect(left).not.toBe(right);
  });
});

describe("scope containment — the cross-tenant negative control", () => {
  const owner = scopeIn("org-1", "proj-1", "env-1");
  const key = deriveAttachmentStorageKey(owner, attachmentId, "photo.png");

  it("resolves under the environment that derived it", () => {
    expect(storageKeyBelongsToScope(key, toThreadScope(owner))).toBe(true);
    const verified = assertStorageKeyInScope(key, toThreadScope(owner));
    expect(verified.ok).toBe(true);
  });

  it("REFUSES to resolve under a different environment in the same project", () => {
    const other = toThreadScope(scopeIn("org-1", "proj-1", "env-2"));
    expect(storageKeyBelongsToScope(key, other)).toBe(false);
    const verified = assertStorageKeyInScope(key, other);
    expect(verified.ok).toBe(false);
    if (verified.ok) throw new Error("unreachable");
    expect(verified.error.code).toBe("FILES_STORAGE_KEY_SCOPE_MISMATCH");
    expect(verified.error.category).toBe("forbidden");
  });

  it("REFUSES to resolve under a different organization", () => {
    const other = toThreadScope(scopeIn("org-2", "proj-1", "env-1"));
    const verified = assertStorageKeyInScope(key, other);
    expect(verified.ok).toBe(false);
  });

  it("REFUSES to resolve under a different thread in the same environment", () => {
    const other = toThreadScope(scopeIn("org-1", "proj-1", "env-1", "thread-2"));
    expect(storageKeyBelongsToScope(key, other)).toBe(false);
  });

  it("is not fooled by a prefix that merely starts the same", () => {
    const sibling = toThreadScope(scopeIn("org-1", "proj-1", "env-1", "thread-10"));
    const siblingKey = deriveAttachmentStorageKey(
      scopeIn("org-1", "proj-1", "env-1", "thread-10"),
      attachmentId,
      "photo.png",
    );
    expect(storageKeyBelongsToScope(siblingKey, toThreadScope(owner))).toBe(false);
    expect(storageKeyBelongsToScope(key, sibling)).toBe(false);
  });

  it("recovers the attachment id only from a key in scope", () => {
    expect(attachmentIdFromStorageKey(key, toThreadScope(owner))).toBe("att-1");
    expect(attachmentIdFromStorageKey(key, toThreadScope(scopeIn("org-9", "proj-1", "env-1")))).toBeNull();
  });

  it("prefixes with the kernel resolvePath so keys and log fields agree", () => {
    expect(storageKeyPrefix(toThreadScope(owner))).toBe("org/org-1/proj/proj-1/env/env-1/thread/thread-1/attachment");
  });
});
