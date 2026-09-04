// The identity-access failure catalogue.
//
// The extraction source (`internal-packages/tenancy-database/src/auth.ts`)
// carries a `PlatosAuthError` class with a lower-case `code` and an HTTP status
// baked into the constructor. Both are wrong at this layer: ADR M0.3 §2 forbids
// the domain from naming a transport status, and the kernel models a failure as
// a VALUE so a caller's failure paths are type-checked rather than discovered.
//
// The mapping is one-for-one and deliberately lossless, so the extraction can be
// diffed against the oracle:
//
//   unauthorized            -> UNAUTHENTICATED          (401)
//   forbidden               -> FORBIDDEN_SCOPE          (403)
//   forbidden (capability)  -> MISSING_PERMISSION       (403)
//   expired                 -> SESSION_EXPIRED          (401)
//   revoked                 -> SESSION_REVOKED          (401)
//   mfa_required            -> MFA_REQUIRED             (401)
//   invalid_mfa             -> INVALID_MFA_CODE         (401)
//   rate_limited            -> RATE_LIMITED             (429)
//   invite_invalid          -> INVITATION_INVALID       (401)
//   invite_email_mismatch   -> INVITATION_EMAIL_MISMATCH(403)
//   invite_consumed         -> INVITATION_CONSUMED      (409)
//   owner_invariant         -> OWNER_INVARIANT          (409)
//   impersonation_forbidden -> IMPERSONATION_FORBIDDEN  (403)
//
// The status column is documentation of what the transport WILL choose (WIN-260
// owns the table); nothing here depends on it.

import { domainError, type DomainError } from "@platos/kernel";

/**
 * Deliberately uniform message.
 *
 * Every path that cannot establish an operator returns the same text whether the
 * token was unknown, malformed, or belonged to a disabled user. A message that
 * distinguishes them is an account-enumeration oracle, and the extraction source
 * is uniform here for exactly that reason.
 */
const OPAQUE_AUTHENTICATION_MESSAGE = "Invalid operator session";

export function unauthenticated(details: Readonly<Record<string, string>> = {}): DomainError {
  return domainError("UNAUTHENTICATED", "unauthenticated", OPAQUE_AUTHENTICATION_MESSAGE, { details });
}

export function sessionExpired(): DomainError {
  return domainError("SESSION_EXPIRED", "unauthenticated", "Session expired");
}

export function sessionRevoked(reason = "Session revoked"): DomainError {
  return domainError("SESSION_REVOKED", "unauthenticated", reason);
}

export function mfaRequired(): DomainError {
  return domainError("MFA_REQUIRED", "unauthenticated", "Multi-factor authentication required");
}

/**
 * One code for every way a second factor can fail: wrong digits, a replayed
 * counter, an unconsumed recovery code that does not match, an enrolment window
 * that closed. Distinguishing them tells a caller which guess got closer.
 */
export function invalidMfaCode(): DomainError {
  return domainError("INVALID_MFA_CODE", "unauthenticated", "Invalid authentication code");
}

export function rateLimited(retryAfterSeconds: number): DomainError {
  return domainError("RATE_LIMITED", "rate_limited", "Too many authentication requests", {
    retryAfterSeconds,
  });
}

export function forbiddenScope(message = "Principal is not authorized for this scope"): DomainError {
  return domainError("FORBIDDEN_SCOPE", "forbidden", message);
}

/**
 * A credential that REACHES the scope but does not carry the capability.
 *
 * It is a separate code from `forbiddenScope` on purpose. The two denials are
 * decided by different gates, in a fixed order — scope first, so a caller cannot
 * probe which capabilities a credential holds by asking about a tenant it cannot
 * reach — and while both answered `FORBIDDEN_SCOPE` that ordering was not
 * observable: a build that checked capability first returned the same code and
 * every ordering test still passed. Distinct codes make the order falsifiable,
 * and give a transport the information it needs to say which of the two failed.
 */
export function missingPermission(required: string): DomainError {
  return domainError("MISSING_PERMISSION", "forbidden", `Credential does not carry the ${required} permission`);
}

export function impersonationForbidden(): DomainError {
  return domainError(
    "IMPERSONATION_FORBIDDEN",
    "forbidden",
    "Impersonation requires a platform operator session",
  );
}

export function invitationInvalid(): DomainError {
  return domainError("INVITATION_INVALID", "unauthenticated", "Invitation is invalid or expired");
}

export function invitationEmailMismatch(): DomainError {
  return domainError(
    "INVITATION_EMAIL_MISMATCH",
    "forbidden",
    "Invitation belongs to another email address",
  );
}

export function invitationConsumed(): DomainError {
  return domainError("INVITATION_CONSUMED", "conflict", "Invitation has already been accepted");
}

export function ownerInvariant(): DomainError {
  return domainError(
    "OWNER_INVARIANT",
    "conflict",
    "An organization must retain at least one active owner",
  );
}

export function credentialExpired(): DomainError {
  return domainError("CREDENTIAL_EXPIRED", "unauthenticated", "Credential expired");
}

export function credentialRevoked(): DomainError {
  return domainError("CREDENTIAL_REVOKED", "unauthenticated", "Credential revoked");
}

/**
 * A refresh token presented after it was already exchanged.
 *
 * The verdict is not "try again": the whole rotation family is destroyed,
 * because either the client or an interceptor holds a copy and there is no way
 * to tell which.
 */
export function tokenReplayed(): DomainError {
  return domainError("TOKEN_REPLAYED", "unauthenticated", "Refresh token replay detected");
}

export function invalidGrant(message: string): DomainError {
  return domainError("INVALID_GRANT", "invalid_input", message);
}

export function unknownClient(): DomainError {
  return domainError("UNKNOWN_CLIENT", "unauthenticated", "Unknown client identifier");
}

export function invalidAccessKeyMaterial(field: string): DomainError {
  return domainError("INVALID_ACCESS_KEY_MATERIAL", "invalid_input", "Access key material is invalid", {
    fields: [{ field, code: "malformed", message: "does not match the required form" }],
  });
}

/**
 * A concurrent revoke incremented the environment's revocation generation while
 * this rotation was in flight. Revoke dominates: the rotation is refused rather
 * than allowed to resurrect a key an operator just destroyed.
 */
export function accessKeyRotationSuperseded(): DomainError {
  return domainError(
    "ACCESS_KEY_ROTATION_SUPERSEDED",
    "conflict",
    "Access key rotation was superseded by a revocation",
  );
}

/**
 * The one-time first-install grant has already been spent, or the environment
 * already has a key and the path has disabled itself.
 *
 * Reported as a conflict rather than a forbidden: nothing about the caller is
 * wrong, the window simply closed. Re-entry is an explicit, authorized recovery.
 */
export function bootstrapGrantUnavailable(): DomainError {
  return domainError(
    "BOOTSTRAP_GRANT_UNAVAILABLE",
    "conflict",
    "The one-time access key bootstrap grant is no longer available",
  );
}

export function identityStoreUnavailable(): DomainError {
  return domainError("IDENTITY_STORE_UNAVAILABLE", "unavailable", "Identity store is unavailable", {
    retryAfterSeconds: 1,
  });
}
