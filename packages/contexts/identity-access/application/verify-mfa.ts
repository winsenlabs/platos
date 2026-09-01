// Satisfy the second factor for a live session.
//
// THE REPLAY DEFENCE IS TWO LAYERS AND BOTH ARE NECESSARY.
//
//   1. `acceptTotpCounter` (domain) refuses a counter that does not strictly
//      exceed the recorded one. This is the rule, it is pure, and it is what the
//      unit test exercises.
//   2. `advanceTotpCounter` (port) performs the move as a CONDITIONAL write and
//      reports whether it won. This is the concurrency control: two requests
//      carrying the same six digits both pass step 1 against the same stale
//      credential, and exactly one of them can win step 2.
//
// Drop layer 1 and the rule lives in SQL where it cannot be tested. Drop layer 2
// and a doubled request slips through. The extraction source has both; so does
// this.
//
// THE RATE LIMIT IS CONSUMED AFTER THE CREDENTIAL IS FOUND AND BEFORE THE CODE
// IS CHECKED. Before the lookup, and an unauthenticated caller could drain
// another user's MFA budget and lock them out. After the check, and it would not
// bound guessing at all. Between them is the only correct position.
//
// A RECOVERY CODE IS AN ALTERNATIVE PROOF, NOT A WEAKER ONE. It is single-use,
// consumed conditionally, and spends the same budget.

import {
  acceptTotpCounter,
  invalidMfaCode,
  isTotpEnabled,
  normalizeRecoveryCode,
  requireUsableAt,
  totpCounterWindow,
  unauthenticated,
  verifiedSecondFactor,
  type OperatorSessionRecord,
  type TotpCredential,
} from "../domain/index.js";
import { consumeRateLimit, type ConsumeRateLimitPorts } from "./consume-rate-limit.js";
import type { PortsOf } from "./dependencies.js";
import { err, ok, type Result, type TenantScope } from "@platos/kernel";

export type VerifyMfaPorts = ConsumeRateLimitPorts &
  PortsOf<"repository" | "hasher" | "totp" | "cipher" | "clock">;

export interface VerifyMfaInput {
  readonly sessionToken: string;
  readonly rateLimitIdentifier: string;
  readonly scope: TenantScope;
  /** Exactly one of these is expected. Both absent is a failed verification. */
  readonly totpCode?: string;
  readonly recoveryCode?: string;
}

export async function verifyMfaForSession(
  ports: VerifyMfaPorts,
  input: VerifyMfaInput,
): Promise<Result<OperatorSessionRecord>> {
  const now = ports.clock.now();
  const loaded = await loadVerifiableSession(ports, input.sessionToken, now);
  if (!loaded.ok) return err(loaded.error);
  const { session, credential } = loaded.value;

  const limited = await consumeRateLimit(ports, {
    action: "MFA_VERIFY",
    identifier: `session:${input.rateLimitIdentifier}`,
    scope: input.scope,
    principalId: null,
  });
  if (!limited.ok) return err(limited.error);

  const proved = await proveSecondFactor(ports, session, credential, input, now);
  if (!proved.ok) return err(proved.error);

  const verified = verifiedSecondFactor(session, now);
  await ports.repository.operatorSessions.save(verified);
  return ok(verified);
}

interface VerifiableSession {
  readonly session: OperatorSessionRecord;
  readonly credential: TotpCredential;
}

async function loadVerifiableSession(
  ports: VerifyMfaPorts,
  sessionToken: string,
  now: Date,
): Promise<Result<VerifiableSession>> {
  const session = await ports.repository.operatorSessions.findByTokenHash(
    ports.hasher.hash(sessionToken),
  );
  if (session === null) return err(unauthenticated({ reason: "no-session" }));

  const actor = await ports.repository.users.findById(session.userId);
  if (actor === null || actor.disabledAt !== null) {
    return err(unauthenticated({ reason: "actor-disabled" }));
  }

  const usable = requireUsableAt(session, now);
  if (!usable.ok) return err(unauthenticated({ reason: "session-unusable" }));

  const credential = await ports.repository.mfa.findTotp(session.userId);
  // No enrolled factor means there is nothing to verify. Reported as an invalid
  // code, not as "you have no MFA", so the endpoint does not disclose which
  // accounts are protected.
  if (!isTotpEnabled(credential) || credential === null) return err(invalidMfaCode());

  return ok({ session, credential });
}

async function proveSecondFactor(
  ports: VerifyMfaPorts,
  session: OperatorSessionRecord,
  credential: TotpCredential,
  input: VerifyMfaInput,
  now: Date,
): Promise<Result<"totp" | "recovery-code">> {
  if (input.totpCode !== undefined && input.totpCode !== "") {
    const proved = await proveTotpCode(ports, credential, input.totpCode, now);
    return proved.ok ? ok("totp") : err(proved.error);
  }
  if (input.recoveryCode !== undefined && input.recoveryCode !== "") {
    const codeHash = ports.hasher.hash(normalizeRecoveryCode(input.recoveryCode));
    const spent = await ports.repository.mfa.consumeRecoveryCode(session.userId, codeHash, now);
    return spent ? ok("recovery-code") : err(invalidMfaCode());
  }
  return err(invalidMfaCode());
}

async function proveTotpCode(
  ports: VerifyMfaPorts,
  credential: TotpCredential,
  code: string,
  now: Date,
): Promise<Result<bigint>> {
  if (credential.encryptedSecret === null) return err(invalidMfaCode());
  const counter = ports.totp.verify({
    secret: ports.cipher.open(credential.encryptedSecret),
    code,
    candidateCounters: totpCounterWindow(now),
  });
  if (counter === null) return err(invalidMfaCode());

  // Layer 1: the rule.
  const accepted = acceptTotpCounter(credential, counter);
  if (!accepted.ok) return err(accepted.error);
  // Layer 2: the race.
  if (!(await ports.repository.mfa.advanceTotpCounter(credential.userId, counter))) {
    return err(invalidMfaCode());
  }
  return ok(counter);
}
