// Session revocation ordered BY tenancy, carried out BY identity-access.
//
// Two invariants in `migrations/00000000000000_initial/migration.sql` are
// implemented as database rules (`CREATE FUNCTION` + an `AFTER` row-level rule
// bound to a table). They are modelled here as domain rules as well, for two
// reasons: a rule that only exists in SQL is invisible to an in-memory use
// case, and the oracle already performs the same work in TypeScript inside the
// transaction, treating the database as defence in depth for callers that
// bypass the service.
//
//   RULE 1 — privilege change revokes sessions.
//   `revoke_operator_sessions_for_membership_change()` runs AFTER UPDATE OF
//   "role", "deactivatedAt" and AFTER DELETE on "OrganizationMembership", and
//   revokes every OperatorSession where "userId" OR "impersonatedUserId"
//   matches the affected user. Both columns matter: revoking only `userId`
//   would leave a platform operator impersonating the demoted user still
//   holding the privileges the demotion just removed.
//
//   RULE 2 — revocation cascades to child sessions.
//   `cascade_operator_session_revocation()` runs AFTER UPDATE OF "revokedAt"
//   and revokes every session whose "parentSessionId" is the newly revoked one,
//   so ending an operator's session ends the impersonation sessions descended
//   from it.
//
// `OperatorSession` is identity-access's row (ADR M0.3 §1, context 1), so
// tenancy may not write it. It emits the ORDER below and an
// `OperatorSessionRevoker` port carries it out inside tenancy's own
// transaction — the same atomicity the oracle gets from doing both writes in
// one `$transaction`.

import type { UserId } from "./identifiers.js";
import type { OperatorSessionId } from "./identifiers.js";

export type SessionRevocationCause =
  | "membership-role-changed"
  | "membership-deactivated"
  | "membership-removed";

export interface SessionRevocationOrder {
  readonly userId: UserId;
  readonly cause: SessionRevocationCause;
  readonly revokedAt: Date;
  /**
   * Always true. Named rather than implied so the `impersonatedUserId` half of
   * the database rule cannot be dropped by an adapter that only remembered the
   * obvious half.
   */
  readonly includeImpersonatedSessions: true;
}

export function revokeSessionsFor(
  userId: UserId,
  cause: SessionRevocationCause,
  revokedAt: Date,
): SessionRevocationOrder {
  return { userId, cause, revokedAt, includeImpersonatedSessions: true };
}

/**
 * RULE 2 as a pure function: given the parent that was just revoked and the
 * parent link of every live session, which sessions must also end.
 *
 * Modelled one level at a time because the database rule is per-row and
 * re-fires on each cascaded update; the fixed point is the transitive closure,
 * which `closeSessionRevocation` computes.
 */
export function childSessionsOf(
  parentSessionId: OperatorSessionId,
  links: readonly { readonly id: OperatorSessionId; readonly parentSessionId: OperatorSessionId | null }[],
): readonly OperatorSessionId[] {
  return links.filter((link) => link.parentSessionId === parentSessionId).map((link) => link.id);
}

/** The transitive closure of `childSessionsOf`, excluding the root itself. */
export function closeSessionRevocation(
  rootSessionId: OperatorSessionId,
  links: readonly { readonly id: OperatorSessionId; readonly parentSessionId: OperatorSessionId | null }[],
): readonly OperatorSessionId[] {
  const revoked = new Set<OperatorSessionId>();
  const pending: OperatorSessionId[] = [rootSessionId];
  while (pending.length > 0) {
    const next = pending.pop();
    if (next === undefined) break;
    for (const child of childSessionsOf(next, links)) {
      if (revoked.has(child)) continue;
      revoked.add(child);
      pending.push(child);
    }
  }
  return [...revoked];
}
