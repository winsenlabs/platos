// Identifiers owned by the `files` context (ADR M0.3 §1, context 10).
//
// The kernel brands the tenancy tree; these brand the rows this context is sole
// writer of, plus the two opaque strings that are NOT primary keys and are the
// easiest to mix up: an object-store key and a content digest. Both are plain
// `String` columns in the baseline schema, and both are the kind of value that
// silently substitutes for a filename or an id when it is typed as `string`.

import type { Branded } from "@platos/kernel";

/** `MessageAttachment.id` — uuid. */
export type AttachmentId = Branded<string, "AttachmentId">;

/** `Artifact.id` — uuid. */
export type ArtifactId = Branded<string, "ArtifactId">;

// Rows this context references but never writes. They are branded here because
// `files` must not import another context's domain to name them (ADR M0.3 §2),
// and a `threadId` reaching an `agentId` parameter is exactly the defect the
// kernel's branding note describes.
export type ThreadId = Branded<string, "ThreadId">;
export type TurnId = Branded<string, "TurnId">;
export type AgentId = Branded<string, "AgentId">;
export type EndUserId = Branded<string, "EndUserId">;

/**
 * The object-store address of one blob. Derived, never accepted from a caller:
 * see `domain/storage-key.ts`. Branding it is what makes an un-derived string
 * unable to reach `ObjectStore`.
 */
export type StorageKey = Branded<string, "StorageKey">;

/** `MessageAttachment.contentHash` — a digest of the blob's bytes. */
export type ContentHash = Branded<string, "ContentHash">;

/**
 * `Artifact.artifactKey` — the stable name that groups revisions. It is NOT a
 * row id: many rows share one key, one per revision.
 */
export type ArtifactKey = Branded<string, "ArtifactKey">;
