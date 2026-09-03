// The tunable limits, in one place, as data.
//
// Every value here is transcribed from the behaviour the current
// `attachments.service` and the artifact meta-tool primitives already have. They
// are a POLICY VALUE passed into a use case, not a module constant read from the
// environment, because a limit read from `process.env` inside a domain rule is
// untestable and is exactly the coupling ADR M0.3 §2 bans.

export interface FilesUploadPolicy {
  /** Per-attachment ceiling, checked before a byte moves. */
  readonly maxAttachmentBytes: number;
  /** Ceiling on the summed bytes one turn may pull into memory at once. */
  readonly maxTurnTotalBytes: number;
  /** Organization-wide stored-bytes ceiling. */
  readonly organizationQuotaBytes: number;
  /** Lifetime of an issued upload grant. */
  readonly uploadWindowSeconds: number;
  /** Lifetime of an issued download grant. */
  readonly downloadWindowSeconds: number;
  /** Nothing may be presigned for longer than this, whatever a caller asks. */
  readonly maxWindowSeconds: number;
}

export interface FilesRetentionPolicy {
  /** How long an unbound upload survives before the sweep may destroy it. */
  readonly pendingGraceSeconds: number;
  /** How long a turn-bound attachment survives, measured from binding. */
  readonly boundRetentionSeconds: number;
}

export interface FilesArtifactPolicy {
  /** Ceiling on one revision's inline content, in UTF-8 bytes. */
  readonly maxContentBytes: number;
  /** Ceiling on the length of an `artifactKey`. */
  readonly maxKeyLength: number;
}

export interface FilesPolicy {
  readonly upload: FilesUploadPolicy;
  readonly retention: FilesRetentionPolicy;
  readonly artifact: FilesArtifactPolicy;
}

const MEBIBYTE = 1024 * 1024;
const DAY_SECONDS = 24 * 60 * 60;

export const DEFAULT_FILES_POLICY: FilesPolicy = Object.freeze({
  upload: Object.freeze({
    maxAttachmentBytes: 20 * MEBIBYTE,
    maxTurnTotalBytes: 80 * MEBIBYTE,
    organizationQuotaBytes: 10 * 1024 * MEBIBYTE,
    uploadWindowSeconds: 900,
    downloadWindowSeconds: 300,
    maxWindowSeconds: 7 * DAY_SECONDS,
  }),
  retention: Object.freeze({
    pendingGraceSeconds: 7 * DAY_SECONDS,
    boundRetentionSeconds: 30 * DAY_SECONDS,
  }),
  artifact: Object.freeze({
    maxContentBytes: MEBIBYTE,
    maxKeyLength: 128,
  }),
});
