// The second factor: TOTP counters and recovery codes.
//
// RFC 6238 parameters, from the extraction source: SHA-1 HMAC, 30-second period,
// 6 digits, +/-1 step of clock tolerance, 9 recovery codes per enrolment.
//
// THE HMAC IS NOT HERE. Producing the six digits for a counter needs a keyed
// hash, which is I/O-shaped work behind `TotpCodeVerifier` in application/ports.
// What lives here is the part the crypto cannot decide: WHICH counter is
// acceptable. That is the replay rule, and it is the reason a stolen code that
// is still inside its 30-second window cannot be used twice.
//
// REPLAY PROTECTION IS A MONOTONIC COUNTER, NOT A TIME COMPARISON.
// `lastUsedCounter` must strictly increase. The extraction source enforces it
// with a conditional update (`lastUsedCounter IS NULL OR lastUsedCounter <
// counter`) so two concurrent verifications of the same code cannot both win.
// The rule is stated here so it survives a change of store; the conditional
// write remains the adapter's job.

import { instantAfter } from "./credential.js";
import { invalidMfaCode } from "./errors.js";
import type { EmailAddress, UserId } from "./principal.js";
import { err, ok, type Result } from "@platos/kernel";

export const TOTP_PERIOD_SECONDS = 30;
export const TOTP_DIGITS = 6;
/** Steps of clock skew tolerated either side of the current counter. */
export const TOTP_WINDOW = 1;
export const RECOVERY_CODE_COUNT = 9;
/** An enrolment that is not confirmed within 15 minutes is abandoned. */
export const MFA_ENROLMENT_TTL_MS = 15 * 60 * 1000;

/** Exactly six decimal digits. A shorter or padded string is not a code. */
export const TOTP_CODE_PATTERN = /^\d{6}$/u;

export interface TotpCredential {
  readonly userId: UserId;
  /** Ciphertext of the shared secret. Plaintext never enters the domain. */
  readonly encryptedSecret: string | null;
  readonly enabledAt: Date | null;
  readonly lastUsedCounter: bigint | null;
  /** Set while an enrolment is in flight, cleared when it is confirmed. */
  readonly pendingEncryptedSecret: string | null;
  readonly pendingExpiresAt: Date | null;
}

export interface RecoveryCodeRecord {
  readonly userId: UserId;
  readonly codeHash: string;
  readonly consumedAt: Date | null;
}

export function isTotpCodeShaped(code: string): boolean {
  return TOTP_CODE_PATTERN.test(code);
}

/** The RFC 6238 step number for an instant. */
export function totpCounterAt(now: Date): bigint {
  return BigInt(Math.floor(now.getTime() / 1000 / TOTP_PERIOD_SECONDS));
}

/**
 * The counters a verifier may test, nearest-first order irrelevant.
 *
 * Negative counters are dropped rather than clamped: at the Unix epoch the
 * window would otherwise wrap to a counter that is not the one the authenticator
 * used, and a test fixture pinned near zero would pass for the wrong reason.
 */
export function totpCounterWindow(now: Date): readonly bigint[] {
  const current = totpCounterAt(now);
  const counters: bigint[] = [];
  for (let offset = -TOTP_WINDOW; offset <= TOTP_WINDOW; offset += 1) {
    const counter = current + BigInt(offset);
    if (counter >= 0n) counters.push(counter);
  }
  return counters;
}

/** True when the credential is enrolled and usable as a second factor. */
export function isTotpEnabled(credential: TotpCredential | null): boolean {
  return credential !== null && credential.enabledAt !== null && credential.encryptedSecret !== null;
}

export function isEnrolmentPending(credential: TotpCredential, now: Date): boolean {
  return (
    credential.pendingEncryptedSecret !== null &&
    credential.pendingExpiresAt !== null &&
    credential.pendingExpiresAt.getTime() > now.getTime()
  );
}

export function beganEnrolment(
  credential: TotpCredential,
  encryptedSecret: string,
  now: Date,
): TotpCredential {
  return {
    ...credential,
    pendingEncryptedSecret: encryptedSecret,
    pendingExpiresAt: instantAfter(now, MFA_ENROLMENT_TTL_MS),
  };
}

/**
 * Accept a counter, or refuse it as a replay.
 *
 * Strictly greater, never equal: a code presented twice inside its own 30-second
 * window yields the SAME counter, and that is precisely the case an attacker who
 * shoulder-surfed the digits is exploiting.
 */
export function acceptTotpCounter(
  credential: TotpCredential,
  counter: bigint,
): Result<TotpCredential> {
  if (credential.lastUsedCounter !== null && counter <= credential.lastUsedCounter) {
    return err(invalidMfaCode());
  }
  return ok({ ...credential, lastUsedCounter: counter });
}

/**
 * Promote a pending enrolment to the live credential.
 *
 * The confirming code's counter is recorded as `lastUsedCounter`, so the code
 * that proved possession cannot immediately be replayed as a login.
 */
export function confirmedEnrolment(
  credential: TotpCredential,
  counter: bigint,
  now: Date,
): Result<TotpCredential> {
  if (!isEnrolmentPending(credential, now)) return err(invalidMfaCode());
  return ok({
    ...credential,
    encryptedSecret: credential.pendingEncryptedSecret,
    enabledAt: now,
    lastUsedCounter: counter,
    pendingEncryptedSecret: null,
    pendingExpiresAt: null,
  });
}

/** Consume a recovery code, or refuse one already spent. */
export function consumedRecoveryCode(
  code: RecoveryCodeRecord,
  now: Date,
): Result<RecoveryCodeRecord> {
  if (code.consumedAt !== null) return err(invalidMfaCode());
  return ok({ ...code, consumedAt: now });
}

/**
 * The provisioning URI an authenticator app scans.
 *
 * Pure string assembly over already-generated material, so it belongs here
 * rather than beside the randomness that produced the secret.
 */
export function otpAuthUri(email: EmailAddress, secret: string, issuer = "Platos"): string {
  const label = encodeURIComponent(`${issuer}:${email}`);
  return `otpauth://totp/${label}?secret=${secret}&issuer=${issuer}&digits=${TOTP_DIGITS}&period=${TOTP_PERIOD_SECONDS}`;
}
