// Enrol a TOTP second factor.
//
// Two steps, and the split is the security property. `beginTotpEnrolment` mints
// a secret and parks it in `pendingEncryptedSecret` with a 15-minute deadline;
// `confirmTotpEnrolment` promotes it only on proof that a device actually holds
// it. A one-step enrolment would let a user lock themselves out of their own
// account by scanning nothing, and would let a hijacked session install a factor
// the real owner cannot satisfy.
//
// THE PENDING SLOT IS SEPARATE FROM THE LIVE ONE. An in-flight enrolment never
// touches `encryptedSecret`, so re-enrolling while a factor is already active
// cannot disable it half-way: either the confirmation succeeds and the new
// secret replaces the old atomically, or the window closes and nothing changed.
//
// CONFIRMATION IS DESTRUCTIVE ON PURPOSE. It replaces every recovery code and
// revokes every other live session for the user. Codes issued against the old
// factor must not survive it, and a session minted before the account was
// protected is a session that never proved the new factor.

import {
  RECOVERY_CODE_COUNT,
  beganEnrolment,
  confirmedEnrolment,
  invalidMfaCode,
  normalizeRecoveryCode,
  otpAuthUri,
  totpCounterWindow,
  unauthenticated,
  type TokenHash,
  type TotpCredential,
  type UserId,
} from "../domain/index.js";
import { consumeRateLimit, type ConsumeRateLimitPorts } from "./consume-rate-limit.js";
import type { PortsOf } from "./dependencies.js";
import { err, ok, type Result, type TenantScope } from "@platos/kernel";

export type EnrolTotpPorts = PortsOf<"repository" | "minter" | "cipher" | "clock">;

export interface BegunTotpEnrolment {
  /** Shown once, as a QR code. Never stored in plaintext. */
  readonly secret: string;
  readonly otpAuthUri: string;
  readonly expiresAt: Date;
}

export async function beginTotpEnrolment(
  ports: EnrolTotpPorts,
  input: { readonly userId: UserId },
): Promise<Result<BegunTotpEnrolment>> {
  const user = await ports.repository.users.findById(input.userId);
  if (user === null || user.disabledAt !== null) {
    return err(unauthenticated({ reason: "actor-disabled" }));
  }

  const now = ports.clock.now();
  const secret = ports.minter.mintTotpSecret();
  const existing = await ports.repository.mfa.findTotp(input.userId);
  const credential = beganEnrolment(
    existing ?? emptyCredential(input.userId),
    ports.cipher.seal(secret),
    now,
  );
  await ports.repository.mfa.saveTotp(credential);

  return ok({
    secret,
    otpAuthUri: otpAuthUri(user.email, secret),
    expiresAt: credential.pendingExpiresAt ?? now,
  });
}

export type ConfirmTotpEnrolmentPorts = ConsumeRateLimitPorts &
  EnrolTotpPorts &
  PortsOf<"hasher" | "totp">;

export interface ConfirmTotpEnrolmentInput {
  readonly userId: UserId;
  readonly code: string;
  readonly rateLimitIdentifier: string;
  readonly scope: TenantScope;
}

export interface ConfirmedTotpEnrolment {
  /** The only moment these exist. Displayed once, stored as verifiers. */
  readonly recoveryCodes: readonly string[];
  readonly enabledAt: Date;
}

export async function confirmTotpEnrolment(
  ports: ConfirmTotpEnrolmentPorts,
  input: ConfirmTotpEnrolmentInput,
): Promise<Result<ConfirmedTotpEnrolment>> {
  // Enrolment confirmation is a guess at six digits, so it spends the same
  // budget as a login verification — under its own bucket key, so a stalled
  // enrolment cannot exhaust the budget the account needs to log in.
  const limited = await consumeRateLimit(ports, {
    action: "MFA_VERIFY",
    identifier: `enrolment:${input.userId}:${input.rateLimitIdentifier}`,
    scope: input.scope,
    principalId: null,
  });
  if (!limited.ok) return err(limited.error);

  const now = ports.clock.now();
  const credential = await ports.repository.mfa.findTotp(input.userId);
  if (credential === null || credential.pendingEncryptedSecret === null) {
    return err(invalidMfaCode());
  }

  const counter = ports.totp.verify({
    secret: ports.cipher.open(credential.pendingEncryptedSecret),
    code: input.code,
    candidateCounters: totpCounterWindow(now),
  });
  if (counter === null) return err(invalidMfaCode());

  const confirmed = confirmedEnrolment(credential, counter, now);
  if (!confirmed.ok) return err(confirmed.error);

  const recoveryCodes = ports.minter.mintRecoveryCodes(RECOVERY_CODE_COUNT);
  const codeHashes: readonly TokenHash[] = recoveryCodes.map((code) =>
    ports.hasher.hash(normalizeRecoveryCode(code)),
  );

  await ports.repository.mfa.saveTotp(confirmed.value);
  await ports.repository.mfa.replaceRecoveryCodes(input.userId, codeHashes);
  await ports.repository.operatorSessions.revokeAllForUser(input.userId, now);

  return ok({ recoveryCodes, enabledAt: now });
}

function emptyCredential(userId: UserId): TotpCredential {
  return {
    userId,
    encryptedSecret: null,
    enabledAt: null,
    lastUsedCounter: null,
    pendingEncryptedSecret: null,
    pendingExpiresAt: null,
  };
}
