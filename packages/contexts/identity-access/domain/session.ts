// OperatorSession — the dashboard session, and the impersonation chain.
//
// Extracted from `PlatosAuthService.authorizeOperatorSession`. That method
// interleaves five database reads with eight decisions; the decisions are all
// here, take a plain record, and are exercisable at any instant. The reads stay
// in the use case behind the repository port.
//
// THE ORDER OF THE CHECKS IS PART OF THE CONTRACT, because each one leaks a
// different amount:
//
//   1. actor disabled          -> UNAUTHENTICATED  (opaque: the account is gone)
//   2. session revoked         -> SESSION_REVOKED  (explicit: stop retrying)
//   3. session expired         -> SESSION_EXPIRED  (explicit: re-authenticate)
//   4. second factor unmet     -> MFA_REQUIRED     (explicit: the next step)
//   5. parent chain broken     -> SESSION_REVOKED  (an impersonation whose
//                                                   origin session died)
//   6. impersonation invalid   -> UNAUTHENTICATED  (opaque: never confirm that a
//                                                   target user exists)
//
// Swapping 2 and 3 turns a revoked credential into one whose holder is told to
// wait. Swapping 1 and 6 turns the impersonation check into an account probe.

import { credentialStateAt } from "./credential.js";
import {
  mfaRequired,
  sessionExpired,
  sessionRevoked,
  unauthenticated,
} from "./errors.js";
import type {
  EmailAddress,
  ImpersonationAction,
  OperatorSessionId,
  PrincipalTier,
  TokenHash,
  UserId,
} from "./principal.js";
import { err, ok, type Result } from "@platos/kernel";

/** 7 days, as in the extraction source's `DEFAULT_SESSION_TTL_MS`. */
export const DEFAULT_SESSION_TTL_MS = 7 * 24 * 60 * 60 * 1000;

export interface OperatorSessionRecord {
  readonly sessionId: OperatorSessionId;
  readonly tokenHash: TokenHash;
  readonly tier: PrincipalTier;
  readonly userId: UserId;
  /** Set only on an impersonation session. */
  readonly impersonatedUserId: UserId | null;
  /** The origin session an impersonation hangs off, and returns to. */
  readonly parentSessionId: OperatorSessionId | null;
  readonly mfaVerifiedAt: Date | null;
  readonly expiresAt: Date;
  readonly revokedAt: Date | null;
  readonly lastSeenAt: Date | null;
  readonly createdAt: Date;
}

export interface OperatorUserRecord {
  readonly userId: UserId;
  readonly email: EmailAddress;
  /** The platform-operator flag; the only thing that permits impersonation. */
  readonly platformOperator: boolean;
  readonly disabledAt: Date | null;
}

export interface ImpersonationState {
  readonly active: true;
  readonly actorUserId: UserId;
  readonly targetUserId: UserId;
}

export interface OperatorAuthorization {
  readonly sessionId: OperatorSessionId;
  /** Who is really acting. Never the impersonated user. */
  readonly actorUserId: UserId;
  /** Whose permissions apply. The impersonated user, when impersonating. */
  readonly effectiveUserId: UserId;
  readonly email: EmailAddress;
  readonly expiresAt: Date;
  readonly mfaVerifiedAt: Date | null;
  readonly impersonation: ImpersonationState | null;
}

export interface OperatorSessionEvaluation {
  readonly session: OperatorSessionRecord;
  readonly actor: OperatorUserRecord;
  /** The impersonation target, when `session.impersonatedUserId` is set. */
  readonly impersonatedUser: OperatorUserRecord | null;
  /** The origin session, when `session.parentSessionId` is set. */
  readonly parentSession: OperatorSessionRecord | null;
  /** True when the actor has an enabled TOTP credential. */
  readonly mfaEnabled: boolean;
  readonly now: Date;
}

export function issuedSession(input: {
  readonly sessionId: OperatorSessionId;
  readonly tokenHash: TokenHash;
  readonly userId: UserId;
  readonly now: Date;
  readonly expiresAt: Date;
  readonly mfaVerifiedAt?: Date | null;
  readonly impersonatedUserId?: UserId | null;
  readonly parentSessionId?: OperatorSessionId | null;
}): OperatorSessionRecord {
  return {
    sessionId: input.sessionId,
    tokenHash: input.tokenHash,
    tier: "OPERATOR",
    userId: input.userId,
    impersonatedUserId: input.impersonatedUserId ?? null,
    parentSessionId: input.parentSessionId ?? null,
    mfaVerifiedAt: input.mfaVerifiedAt ?? null,
    expiresAt: input.expiresAt,
    revokedAt: null,
    lastSeenAt: null,
    createdAt: input.now,
  };
}

/**
 * An origin session is still standing.
 *
 * All five conditions matter. Dropping the `impersonatedUserId === null` clause
 * would let one impersonation session parent another, so an operator could chain
 * hops and the audit trail would no longer name a single responsible human.
 */
export function parentSessionIsIntact(
  child: OperatorSessionRecord,
  parent: OperatorSessionRecord | null,
  now: Date,
): boolean {
  return (
    parent !== null &&
    parent.userId === child.userId &&
    parent.impersonatedUserId === null &&
    parent.revokedAt === null &&
    parent.expiresAt.getTime() > now.getTime()
  );
}

function evaluateImpersonation(input: OperatorSessionEvaluation): Result<ImpersonationState | null> {
  const { session, actor, impersonatedUser } = input;
  if (session.impersonatedUserId === null) return ok(null);
  if (!actor.platformOperator || impersonatedUser === null || impersonatedUser.disabledAt !== null) {
    return err(unauthenticated({ reason: "impersonation-invalid" }));
  }
  return ok({ active: true, actorUserId: session.userId, targetUserId: session.impersonatedUserId });
}

/** The whole authentication decision for a dashboard session. */
export function evaluateOperatorSession(
  input: OperatorSessionEvaluation,
): Result<OperatorAuthorization> {
  const { session, actor, now } = input;

  if (actor.disabledAt !== null) return err(unauthenticated({ reason: "actor-disabled" }));

  const state = credentialStateAt(session, now);
  if (state === "revoked") return err(sessionRevoked());
  if (state === "expired") return err(sessionExpired());

  if (input.mfaEnabled && session.mfaVerifiedAt === null) return err(mfaRequired());

  if (session.parentSessionId !== null && !parentSessionIsIntact(session, input.parentSession, now)) {
    return err(sessionRevoked("Parent session is no longer active"));
  }

  const impersonation = evaluateImpersonation(input);
  if (!impersonation.ok) return err(impersonation.error);

  const effectiveUser = input.impersonatedUser ?? actor;
  return ok({
    sessionId: session.sessionId,
    actorUserId: session.userId,
    effectiveUserId: session.impersonatedUserId ?? session.userId,
    email: effectiveUser.email,
    expiresAt: session.expiresAt,
    mfaVerifiedAt: session.mfaVerifiedAt,
    impersonation: impersonation.value,
  });
}

/** Stamp liveness. Only ever applied to a session that just authenticated. */
export function touched(session: OperatorSessionRecord, now: Date): OperatorSessionRecord {
  return { ...session, lastSeenAt: now };
}

/**
 * Revoking is not idempotent, and says so.
 *
 * The extraction source reports `count === 1` from a conditional update, which
 * is how a caller learns whether it was the one that ended the session. A
 * silently-idempotent revoke would make a double logout indistinguishable from a
 * successful one, and the same distinction is what makes concurrent
 * impersonation-stop safe.
 */
export function revoked(session: OperatorSessionRecord, now: Date): Result<OperatorSessionRecord> {
  if (session.revokedAt !== null) return err(sessionRevoked());
  return ok({ ...session, revokedAt: now });
}

export function verifiedSecondFactor(
  session: OperatorSessionRecord,
  now: Date,
): OperatorSessionRecord {
  return { ...session, mfaVerifiedAt: now };
}

export function clearedSecondFactor(session: OperatorSessionRecord): OperatorSessionRecord {
  return { ...session, mfaVerifiedAt: null };
}

/**
 * One row of the impersonation ledger.
 *
 * Written on START and on STOP, never updated. Both ends are recorded because a
 * ledger with only starts cannot answer "was anyone impersonating at 14:05?",
 * which is the question an incident actually asks.
 *
 * `actorUserId` is always the real human. The whole point of the record is that
 * it cannot be confused with the account they were acting as.
 */
export interface ImpersonationAuditEntry {
  readonly action: ImpersonationAction;
  readonly actorUserId: UserId;
  readonly targetUserId: UserId;
  readonly impersonationSessionId: OperatorSessionId;
  readonly ipAddress: string | null;
  readonly userAgent: string | null;
  readonly recordedAt: Date;
}
