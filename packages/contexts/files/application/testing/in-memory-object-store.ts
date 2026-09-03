// An in-memory `ObjectStore`.
//
// It exists so every rule in this context is provable without a bucket. It is
// framework-free and vendor-free by construction — it is a `Map` — which is the
// point: if a use case can be driven to its conclusion against this, then no
// rule in it secretly depends on a client's behaviour.
//
// It records every call. Several of this context's guarantees are NEGATIVE
// ("the store is never asked"), and a negative is only provable against a double
// that remembers what it was asked.

import { err, ok, type Result } from "@platos/kernel";

import { objectNotFound, objectStoreUnavailable, type StorageKey } from "../../domain/index.js";
import type {
  CopyObjectRequest,
  ObjectDeletion,
  ObjectStore,
  ObjectSummary,
  PresignDownloadRequest,
  PresignedUrl,
  PresignUploadRequest,
  PutObjectRequest,
  StoredObject,
} from "../ports/index.js";

interface StoredEntry {
  readonly content: Uint8Array;
  readonly contentType: string | null;
  readonly lastModifiedAt: Date;
}

export type ObjectStoreCall =
  | { readonly call: "presignUpload"; readonly key: StorageKey }
  | { readonly call: "presignDownload"; readonly key: StorageKey }
  | { readonly call: "put"; readonly key: StorageKey }
  | { readonly call: "get"; readonly key: StorageKey }
  | { readonly call: "stat"; readonly key: StorageKey }
  | { readonly call: "delete"; readonly key: StorageKey }
  | { readonly call: "copy"; readonly key: StorageKey };

export interface InMemoryObjectStoreOptions {
  readonly now?: () => Date;
}

export class InMemoryObjectStore implements ObjectStore {
  private readonly objects = new Map<string, StoredEntry>();
  private readonly now: () => Date;
  readonly calls: ObjectStoreCall[] = [];

  /** Set to make the NEXT delete report a store failure. */
  deleteFails = false;
  /** Set to make every presign report the store unavailable. */
  presignFails = false;
  /** Set to make every copy report the store unavailable. */
  copyFails = false;

  constructor(options: InMemoryObjectStoreOptions = {}) {
    this.now = options.now ?? (() => new Date(0));
  }

  /** Seed bytes without going through a grant, for arranging a test. */
  seed(key: StorageKey, content: Uint8Array, contentType: string | null = null): void {
    this.objects.set(key, { content, contentType, lastModifiedAt: this.now() });
  }

  has(key: StorageKey): boolean {
    return this.objects.has(key);
  }

  get size(): number {
    return this.objects.size;
  }

  callsTo(call: ObjectStoreCall["call"]): readonly ObjectStoreCall[] {
    return this.calls.filter((entry) => entry.call === call);
  }

  private summary(key: StorageKey, entry: StoredEntry): ObjectSummary {
    return {
      key,
      bytes: entry.content.byteLength,
      contentType: entry.contentType,
      versionTag: `v${entry.content.byteLength}`,
      lastModifiedAt: entry.lastModifiedAt,
    };
  }

  async presignUpload(request: PresignUploadRequest): Promise<Result<PresignedUrl>> {
    this.calls.push({ call: "presignUpload", key: request.key });
    if (this.presignFails) return err(objectStoreUnavailable("presign refused"));
    return ok({
      key: request.key,
      url: `memory://put/${request.key}?expires=${request.expiresAt.toISOString()}`,
      method: "PUT",
      requiredHeaders: { "content-type": request.contentType },
      expiresAt: request.expiresAt,
    });
  }

  async presignDownload(request: PresignDownloadRequest): Promise<Result<PresignedUrl>> {
    this.calls.push({ call: "presignDownload", key: request.key });
    if (this.presignFails) return err(objectStoreUnavailable("presign refused"));
    return ok({
      key: request.key,
      url: `memory://get/${request.key}?expires=${request.expiresAt.toISOString()}`,
      method: "GET",
      requiredHeaders: {},
      expiresAt: request.expiresAt,
    });
  }

  async put(request: PutObjectRequest): Promise<Result<ObjectSummary>> {
    this.calls.push({ call: "put", key: request.key });
    const entry: StoredEntry = {
      content: request.content,
      contentType: request.contentType,
      lastModifiedAt: this.now(),
    };
    this.objects.set(request.key, entry);
    return ok(this.summary(request.key, entry));
  }

  async get(key: StorageKey): Promise<Result<StoredObject>> {
    this.calls.push({ call: "get", key });
    const entry = this.objects.get(key);
    if (entry === undefined) return err(objectNotFound(key));
    return ok({ key, content: entry.content, contentType: entry.contentType });
  }

  async stat(key: StorageKey): Promise<Result<ObjectSummary>> {
    this.calls.push({ call: "stat", key });
    const entry = this.objects.get(key);
    if (entry === undefined) return err(objectNotFound(key));
    return ok(this.summary(key, entry));
  }

  async delete(key: StorageKey): Promise<Result<ObjectDeletion>> {
    this.calls.push({ call: "delete", key });
    if (this.deleteFails) return err(objectStoreUnavailable("delete refused"));
    const existed = this.objects.delete(key);
    return ok({ key, existed });
  }

  async copy(request: CopyObjectRequest): Promise<Result<ObjectSummary>> {
    this.calls.push({ call: "copy", key: request.destinationKey });
    if (this.copyFails) return err(objectStoreUnavailable("copy refused"));
    const source = this.objects.get(request.sourceKey);
    if (source === undefined) return err(objectNotFound(request.sourceKey));
    const entry: StoredEntry = { ...source, lastModifiedAt: this.now() };
    this.objects.set(request.destinationKey, entry);
    return ok(this.summary(request.destinationKey, entry));
  }
}
