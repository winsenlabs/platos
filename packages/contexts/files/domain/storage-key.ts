// Deterministic storage-key derivation.
//
// A storage key is DERIVED, never supplied. That is the whole rule, and it is
// what makes cross-tenant blob access unreachable rather than merely checked:
// the key's prefix is the kernel's `resolvePath()` of the owning environment, so
// two tenants cannot produce the same key even if they upload the same file with
// the same name on the same millisecond, and a key minted under one environment
// fails `assertStorageKeyInScope` under any other.
//
// Layout:
//   org/<org>/proj/<proj>/env/<env>/thread/<thread>/attachment/<id>/<name>
//
// The attachment id segment is what keeps the leaf name free: two attachments in
// one thread with the same filename get different keys, so the object store
// never needs an overwrite and `put` is never destructive.

import { err, ok, type Result } from "@platos/kernel";

import { storageKeyScopeMismatch } from "./errors.js";
import type { AttachmentId, StorageKey } from "./identifiers.js";
import { threadPath, type AttachmentScope, type ThreadScope } from "./scope.js";

/** The one segment that separates the scope prefix from the per-row suffix. */
export const ATTACHMENT_KEY_SEGMENT = "attachment";

const OBJECT_NAME_MAX_LENGTH = 120;
const UNSAFE_OBJECT_NAME_CHARACTER = /[^A-Za-z0-9._-]/gu;
const FALLBACK_OBJECT_NAME = "file";

/**
 * Reduce an operator-supplied filename to a safe single path segment.
 *
 * Beyond the existing behaviour (non-alphanumerics collapse to `_`, truncate to
 * 120, empty becomes `file`) this also rejects `.` and `..`. Those two survive
 * the character filter unchanged and, as the final segment of a key, are the one
 * input that could address a directory rather than an object. That is a
 * hardening, not transcribed behaviour.
 */
export function sanitizeObjectName(value: string | null | undefined): string {
  const collapsed = (value ?? "")
    .trim()
    .replace(UNSAFE_OBJECT_NAME_CHARACTER, "_")
    .slice(0, OBJECT_NAME_MAX_LENGTH);
  if (collapsed === "" || collapsed === "." || collapsed === "..") return FALLBACK_OBJECT_NAME;
  return collapsed;
}

/**
 * Everything in a key that is fixed by scope. A key that does not start with
 * exactly this belongs to another tenant, another environment or another thread.
 */
export function storageKeyPrefix(scope: ThreadScope): string {
  return `${threadPath(scope)}/${ATTACHMENT_KEY_SEGMENT}`;
}

/** Pure and total: the same scope, id and name always give the same key. */
export function deriveAttachmentStorageKey(
  scope: AttachmentScope,
  attachmentId: AttachmentId,
  originalName: string | null,
): StorageKey {
  const name = sanitizeObjectName(originalName);
  return `${storageKeyPrefix(scope)}/${attachmentId}/${name}` as StorageKey;
}

/** True when `key` was derived under `scope` — a prefix test, not a parse. */
export function storageKeyBelongsToScope(key: StorageKey, scope: ThreadScope): boolean {
  return (key as string).startsWith(`${storageKeyPrefix(scope)}/`);
}

/**
 * The gate every read, copy and destroy passes through. Returns `forbidden`
 * rather than `not_found` so an audit log records a cross-scope reach as what
 * it is.
 */
export function assertStorageKeyInScope(key: StorageKey, scope: ThreadScope): Result<StorageKey> {
  if (!storageKeyBelongsToScope(key, scope)) {
    return err(storageKeyScopeMismatch(`${storageKeyPrefix(scope)}/`));
  }
  return ok(key);
}

/** The attachment id a derived key carries, or null when the key is foreign. */
export function attachmentIdFromStorageKey(key: StorageKey, scope: ThreadScope): AttachmentId | null {
  if (!storageKeyBelongsToScope(key, scope)) return null;
  const suffix = (key as string).slice(`${storageKeyPrefix(scope)}/`.length);
  const separator = suffix.indexOf("/");
  if (separator <= 0) return null;
  return suffix.slice(0, separator) as AttachmentId;
}
