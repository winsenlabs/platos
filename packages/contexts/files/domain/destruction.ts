// The blob/row destruction ordering rule.
//
// A `MessageAttachment` is two physical things — a Postgres row and an object in
// a bucket — and no transaction spans them. Exactly one of two damaged states
// follows any partial failure:
//
//   ORPHAN BLOB    the row is gone, the object survives. Nothing points at it.
//                  No Platos read path can reach it (every path starts from a
//                  row), no future sweep can find it (the sweep is driven by
//                  `expiresAt` on rows), and it still holds the tenant's bytes.
//                  It is unrecoverable without an out-of-band bucket scan, and
//                  under an erasure obligation it is a breach.
//
//   DANGLING PTR   the object is gone, the row survives. A read fails loudly at
//                  fetch time with `FILES_OBJECT_NOT_FOUND`, and the row is
//                  still on the sweep's worklist with its expiry in the past, so
//                  the next pass finishes the job. Self-healing.
//
// THE ROW IS AUTHORITATIVE and the blob is destroyed FIRST. Destroying the
// authoritative record last is what makes every failure land on the recoverable
// side of that pair. `ObjectStore.delete` is idempotent — an already-absent
// object reports `existed: false` and is a success — which is what lets the
// retry converge instead of wedging on the second pass.
//
// The corollary, stated so it cannot be quietly skipped: a row is deleted ONLY
// after its blob is confirmed destroyed or confirmed absent. A row deletion
// requested without that confirmation is REPORTED as a failure. It is never
// silently succeeded.

import type { DomainError } from "@platos/kernel";

import { blobDestructionFailed } from "./errors.js";
import type { AttachmentId, StorageKey } from "./identifiers.js";

/** The fixed order. Reversing it converts every failure into an orphan. */
export const DESTRUCTION_ORDER = Object.freeze(["blob", "row"] as const);

export type BlobDestruction =
  | { readonly outcome: "destroyed" }
  /** Idempotent success: the object was already gone. */
  | { readonly outcome: "already-absent" }
  | { readonly outcome: "failed"; readonly error: DomainError };

export const BLOB_DESTROYED: BlobDestruction = Object.freeze({ outcome: "destroyed" });
export const BLOB_ALREADY_ABSENT: BlobDestruction = Object.freeze({ outcome: "already-absent" });

export function blobDestructionFailure(error: DomainError): BlobDestruction {
  return { outcome: "failed", error };
}

export type RowDestruction =
  | { readonly decision: "destroy-row" }
  | { readonly decision: "retain-row"; readonly error: DomainError };

/**
 * The whole rule, in one total function. There is no third answer and no
 * "delete anyway" branch, which is what stops a caller from talking itself into
 * one on a bad day.
 */
export function decideRowDestruction(key: StorageKey, blob: BlobDestruction): RowDestruction {
  if (blob.outcome === "failed") {
    return { decision: "retain-row", error: blobDestructionFailed(key, blob.error) };
  }
  return { decision: "destroy-row" };
}

export interface DestructionReport {
  readonly attachmentId: AttachmentId;
  readonly storageKey: StorageKey;
  readonly blob: BlobDestruction;
  readonly rowDestroyed: boolean;
  /** Set exactly when `rowDestroyed` is false. */
  readonly error: DomainError | null;
}

export function retainedReport(
  attachmentId: AttachmentId,
  storageKey: StorageKey,
  blob: BlobDestruction,
  error: DomainError,
): DestructionReport {
  return { attachmentId, storageKey, blob, rowDestroyed: false, error };
}

export function destroyedReport(
  attachmentId: AttachmentId,
  storageKey: StorageKey,
  blob: BlobDestruction,
): DestructionReport {
  return { attachmentId, storageKey, blob, rowDestroyed: true, error: null };
}

export interface DestructionSummary {
  readonly reports: readonly DestructionReport[];
  readonly rowsDestroyed: number;
  readonly rowsRetained: number;
  readonly blobsDestroyed: number;
}

export function summarizeDestruction(reports: readonly DestructionReport[]): DestructionSummary {
  let rowsDestroyed = 0;
  let blobsDestroyed = 0;
  for (const report of reports) {
    if (report.rowDestroyed) rowsDestroyed += 1;
    if (report.blob.outcome === "destroyed") blobsDestroyed += 1;
  }
  return {
    reports,
    rowsDestroyed,
    rowsRetained: reports.length - rowsDestroyed,
    blobsDestroyed,
  };
}
