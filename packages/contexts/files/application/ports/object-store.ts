// The `ObjectStore` port — OWNED AND PUBLISHED BY THIS CONTEXT.
//
// ADR M0.3 §13: an adapter-facing port belongs to the context whose capability
// it serves; it does not move into the kernel because its implementation happens
// to live under `packages/adapters/`. `files` is the only holder of an
// object-store client (§1, context 10), and this interface is the only thing the
// rest of the system sees of it.
//
// THREE PROPERTIES THIS INTERFACE MUST HAVE, and why each one is shaped as it is:
//
// 1. IT NAMES NO VENDOR. There is no bucket, no region, no endpoint, no
//    credential and no client option anywhere below. Those belong to the
//    adapter's construction, not to a call. Every operation addresses a
//    `StorageKey` and nothing else, so the same interface is satisfiable by any
//    S3-compatible store, by a local filesystem in a test, or by the in-memory
//    fake this package ships.
//
// 2. FAILURE IS A VALUE, NOT AN EXCEPTION. Every method returns
//    `Promise<Result<T>>`. An implementation MUST translate its client's errors
//    into the `FILES_OBJECT_*` domain errors and MUST NOT let a vendor error
//    escape — a caller that is forbidden from importing the SDK (ADR M0.3 §2)
//    cannot possibly catch a typed error from it. A rejected promise from any
//    method below is a defect in the adapter, not a business outcome.
//
// 3. TIME IS ABSOLUTE. Presign takes an `expiresAt` instant, not a relative TTL.
//    The window is decided by the caller from the kernel `Clock`, so the grant
//    an in-memory test issues and the grant production issues expire on the same
//    rule, and an adapter cannot quietly apply a default of its own.
//
// DELETE IS IDEMPOTENT. Deleting an object that is already gone is a SUCCESS
// carrying `existed: false`. That is what makes the destruction ordering rule in
// `domain/destruction.ts` converge on a retry rather than wedge.

import type { Result } from "@platos/kernel";

import type { StorageKey } from "../../domain/index.js";

/** What the store knows about an object without transferring its bytes. */
export interface ObjectSummary {
  readonly key: StorageKey;
  readonly bytes: number;
  readonly contentType: string | null;
  /** The store's opaque version/integrity tag, when it publishes one. */
  readonly versionTag: string | null;
  readonly lastModifiedAt: Date;
}

export interface StoredObject {
  readonly key: StorageKey;
  readonly content: Uint8Array;
  readonly contentType: string | null;
}

export interface ObjectDeletion {
  readonly key: StorageKey;
  /** False when the object was already absent. Still a success. */
  readonly existed: boolean;
}

export interface PresignUploadRequest {
  readonly key: StorageKey;
  readonly contentType: string;
  /**
   * Signed into the grant so an oversized body is refused by the store itself,
   * not merely by a check the client could skip.
   */
  readonly contentLengthBytes: number;
  readonly expiresAt: Date;
}

export interface PresignDownloadRequest {
  readonly key: StorageKey;
  readonly expiresAt: Date;
  /** Suggested filename for a browser download, when the caller wants one. */
  readonly downloadName?: string | null;
}

export interface PresignedUrl {
  readonly key: StorageKey;
  readonly url: string;
  readonly method: "PUT" | "GET";
  /** Headers the redeeming client MUST send for the signature to verify. */
  readonly requiredHeaders: Readonly<Record<string, string>>;
  readonly expiresAt: Date;
}

export interface PutObjectRequest {
  readonly key: StorageKey;
  readonly content: Uint8Array;
  readonly contentType: string;
}

/**
 * Server-side duplication. The bytes never travel through this process, which is
 * the entire point: it is how content-hash dedupe gives a new row its own blob
 * without the client re-uploading. Both keys are already scope-verified by the
 * caller (`assertStorageKeyInScope`).
 */
export interface CopyObjectRequest {
  readonly sourceKey: StorageKey;
  readonly destinationKey: StorageKey;
}

export interface ObjectStore {
  /** Mint a grant a client can PUT to directly, without proxying bytes. */
  presignUpload(request: PresignUploadRequest): Promise<Result<PresignedUrl>>;

  /** Mint a grant a client can GET from directly. */
  presignDownload(request: PresignDownloadRequest): Promise<Result<PresignedUrl>>;

  /** Server-side write, for bytes this process already holds. */
  put(request: PutObjectRequest): Promise<Result<ObjectSummary>>;

  /** Fetch bytes. `FILES_OBJECT_NOT_FOUND` when the object is absent. */
  get(key: StorageKey): Promise<Result<StoredObject>>;

  /** Metadata without a transfer. `FILES_OBJECT_NOT_FOUND` when absent. */
  stat(key: StorageKey): Promise<Result<ObjectSummary>>;

  /** Idempotent. An absent object is `ok({ existed: false })`, not an error. */
  delete(key: StorageKey): Promise<Result<ObjectDeletion>>;

  /** Server-side copy. `FILES_OBJECT_NOT_FOUND` when the source is absent. */
  copy(request: CopyObjectRequest): Promise<Result<ObjectSummary>>;
}
