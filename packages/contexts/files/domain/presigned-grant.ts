// A presigned grant, as a value with an expiry the domain can reason about.
//
// The store enforces the signature; nothing here can forge or extend one. What
// this module adds is that a grant is a VALUE with an instant on it, so the two
// things that actually go wrong are catchable before a request leaves the
// process:
//
//   1. Issuing a window that is absurd (non-positive, or longer than policy).
//   2. Redeeming a grant the caller has been holding past its expiry.
//
// Without (2) a stale grant is a 403 from the store with a vendor-shaped body,
// which is precisely the failure mode this context exists to eliminate. With it
// the caller gets `FILES_PRESIGNED_GRANT_ELAPSED` and the store is never called.

import { err, ok, type Result } from "@platos/kernel";

import { presignedGrantElapsed, presignWindowInvalid } from "./errors.js";
import type { StorageKey } from "./identifiers.js";

export type GrantOperation = "upload" | "download";

export interface PresignedGrant {
  readonly operation: GrantOperation;
  readonly key: StorageKey;
  /** Opaque to the domain: it is produced and verified entirely by the store. */
  readonly url: string;
  readonly method: "PUT" | "GET";
  /** Headers the redeeming client MUST send for the signature to verify. */
  readonly requiredHeaders: Readonly<Record<string, string>>;
  readonly issuedAt: Date;
  readonly expiresAt: Date;
}

/** Validate a requested window against policy before anything is signed. */
export function admitGrantWindow(seconds: number, maxSeconds: number): Result<number> {
  if (!Number.isSafeInteger(seconds) || seconds <= 0 || seconds > maxSeconds) {
    return err(presignWindowInvalid(seconds, maxSeconds));
  }
  return ok(seconds);
}

export function grantExpiry(issuedAt: Date, seconds: number): Date {
  return new Date(issuedAt.getTime() + seconds * 1000);
}

export function grantHasElapsed(grant: PresignedGrant, now: Date): boolean {
  return grant.expiresAt.getTime() <= now.getTime();
}

/** The last gate before a grant is handed to the store. */
export function redeemGrant(grant: PresignedGrant, now: Date): Result<PresignedGrant> {
  if (grantHasElapsed(grant, now)) {
    return err(presignedGrantElapsed(grant.expiresAt.toISOString(), now.toISOString()));
  }
  return ok(grant);
}

export function remainingGrantSeconds(grant: PresignedGrant, now: Date): number {
  const remaining = Math.floor((grant.expiresAt.getTime() - now.getTime()) / 1000);
  return remaining > 0 ? remaining : 0;
}
