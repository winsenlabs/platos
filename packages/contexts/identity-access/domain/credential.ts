// The one lifecycle rule every bearer credential in this context obeys.
//
// OperatorSession, EndUserSession, McpToken, McpBearerToken,
// PersonalAccessToken, OAuthAccessToken, OAuthRefreshToken and AccessKey all
// carry the same two nullable columns — `expiresAt` and `revokedAt` — and every
// one of them was checking them in its own hand-written order. Two of the eight
// checked expiry first. That is the difference between a revoked credential
// reporting "expired" (a lie the holder can wait out) and reporting "revoked".
//
// So the order is fixed here, once, and every credential path goes through it.
//
// REVOKED BEATS EXPIRED. A revocation is a decision somebody made; an expiry is
// a clock running out. When both are true the decision is the truth worth
// reporting, and reporting the clock instead invites a caller to retry.
//
// EXPIRY IS INCLUSIVE. `expiresAt <= now` is expired, matching the extraction
// source's `expiresAt.getTime() <= now.getTime()` exactly. A credential is never
// usable at the instant it names as its last.

import { credentialExpired, credentialRevoked } from "./errors.js";
import { err, ok, type Result } from "@platos/kernel";

/** The two columns. `expiresAt: null` means "does not expire on its own". */
export interface RevocableCredential {
  readonly expiresAt: Date | null;
  readonly revokedAt: Date | null;
}

export type CredentialState = "active" | "revoked" | "expired";

export function credentialStateAt(credential: RevocableCredential, now: Date): CredentialState {
  if (credential.revokedAt !== null) return "revoked";
  if (credential.expiresAt !== null && credential.expiresAt.getTime() <= now.getTime()) {
    return "expired";
  }
  return "active";
}

export function isUsableAt(credential: RevocableCredential, now: Date): boolean {
  return credentialStateAt(credential, now) === "active";
}

/** The state check as a Result, for use cases that return rather than branch. */
export function requireUsableAt<Credential extends RevocableCredential>(
  credential: Credential,
  now: Date,
): Result<Credential> {
  const state = credentialStateAt(credential, now);
  if (state === "revoked") return err(credentialRevoked());
  if (state === "expired") return err(credentialExpired());
  return ok(credential);
}

/**
 * Whole seconds until `expiresAt`, floored at zero.
 *
 * Rounded UP, so a client told to wait N seconds never returns while the window
 * is still open. Rounding down produces a retry that is refused again, which
 * reads to the client as a limiter that is broken rather than one that is
 * working.
 */
export function secondsUntil(instant: Date, now: Date): number {
  const remaining = instant.getTime() - now.getTime();
  return remaining <= 0 ? 0 : Math.ceil(remaining / 1000);
}

/** `now + milliseconds`, as the one place a TTL becomes an instant. */
export function instantAfter(now: Date, milliseconds: number): Date {
  return new Date(now.getTime() + milliseconds);
}
