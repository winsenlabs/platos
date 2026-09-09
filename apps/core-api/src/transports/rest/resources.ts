// THE WIRE TYPES V1 PUBLISHES, AND THE ONE PLACE A `Date` BECOMES A STRING.
//
// ADR M0.4 D7 (CORRECTED, accepted): "without declared DTOs, 'additive-only field
// compat' is a policy nobody can enforce; the new contexts (which are the bulk of
// M4) should be born with schemas so the breaking-change guard actually guards
// fields." These are those declarations for the identity surface. A handler that
// returned a context view directly would publish every field a later contract
// change added, without anybody deciding to, and the guard would have nothing
// stable to diff.
//
// `instant` LIVES HERE BECAUSE IT WAS ABOUT TO LIVE IN FIVE PLACES. `Date`
// survives `JSON.stringify` as an ISO-8601 string already, so each copy looked
// like a no-op and would have been deleted one at a time by whoever read it next
// — at which point the DECLARED type would say `string` and the wire would carry
// whatever a future serializer chose.

import type { OperatorAuthorizationView } from "@platos/context-identity-access";

/** ISO-8601 UTC. The only conversion from a domain instant to the wire. */
export function instant(at: Date): string {
  return at.toISOString();
}

/** `instant`, or null. Written once because four DTOs below take nullable dates. */
export function nullableInstant(at: Date | null): string | null {
  return at === null ? null : instant(at);
}

/**
 * The authenticated operator, as V1 publishes them.
 *
 * `impersonating` is a nullable OBJECT rather than a boolean beside a nullable id,
 * because those would be two fields carrying one fact and two fields carrying one
 * fact can disagree — the argument `collectionEnvelope` makes for deriving
 * `hasMore` from `nextCursor` instead of accepting both.
 */
export interface OperatorSessionResource {
  readonly sessionId: string;
  /** The real human. Never the impersonated account. */
  readonly actorUserId: string;
  /** Whose permissions apply — the impersonated account, when impersonating. */
  readonly effectiveUserId: string;
  readonly email: string;
  readonly expiresAt: string;
  readonly mfaVerifiedAt: string | null;
  readonly impersonating: { readonly targetUserId: string } | null;
}

export function operatorSessionResource(
  operator: OperatorAuthorizationView,
): OperatorSessionResource {
  return {
    sessionId: operator.sessionId,
    actorUserId: operator.actorUserId,
    effectiveUserId: operator.effectiveUserId,
    email: operator.email,
    expiresAt: instant(operator.expiresAt),
    mfaVerifiedAt: nullableInstant(operator.mfaVerifiedAt),
    impersonating:
      operator.impersonating === null
        ? null
        : { targetUserId: operator.impersonating.targetUserId },
  };
}
