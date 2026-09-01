// `OperatorSessionRevoker` — how a tenancy decision reaches a row tenancy does
// not own.
//
// `OperatorSession` belongs to identity-access (ADR M0.3 §1, context 1), so
// tenancy may not write it, yet a privilege change MUST end the affected user's
// sessions or the demotion does not take effect until the old session expires.
// The oracle does both writes in one `$transaction`; this port keeps that
// atomicity while keeping the ownership boundary, because the order is carried
// out inside the caller's `TransactionScope`.
//
// This is the same shape ADR M0.3 §3 uses for the auth wrong-way edges: tenancy
// does not import identity-access's internals, it publishes an intent and the
// composition root wires the implementation.

import type { TransactionScope } from "@platos/kernel";

import type { SessionRevocationOrder } from "../../domain/index.js";

export interface OperatorSessionRevoker {
  /**
   * Revoke every live operator session of the ordered user, matching BOTH
   * `userId` and `impersonatedUserId` — the database rule
   * `revoke_operator_sessions_for_membership_change()` matches both, and an
   * implementation that matched only the first would leave a platform operator
   * impersonating the demoted user holding privileges the demotion removed.
   *
   * Returns how many sessions ended, so a caller can record it.
   */
  revoke(order: SessionRevocationOrder, transaction: TransactionScope): Promise<number>;
}
