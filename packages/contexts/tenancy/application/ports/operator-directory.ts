// `OperatorDirectory` — the narrow read tenancy needs from identity-access.
//
// Accepting an invitation checks TWO addresses, not one: the address the caller
// proved they control, and the address on the `User` row the membership will be
// attached to. The oracle does the second with `tx.user.findUnique(...)` and
// compares emails, and skipping it would let somebody who proved control of
// `a@example.com` attach the resulting membership to a different account.
//
// `User` is identity-access's row, so tenancy reads it through a port. This is
// the reader-port inversion of ADR M0.3 §2: the narrow question tenancy needs
// answered, phrased by tenancy, satisfied at the composition root from
// identity-access's published contract. When that contract settles, this port
// collapses into it; until then tenancy names the question rather than reaching
// for the table.

import type { EmailAddress, UserId } from "../../domain/index.js";

export interface OperatorAccount {
  readonly userId: UserId;
  readonly email: EmailAddress;
  /** identity-access's `User.disabledAt`. A disabled account accepts nothing. */
  readonly disabledAt: Date | null;
}

export interface OperatorDirectory {
  /** `null` when identity-access has no such user. */
  findAccount(userId: UserId): Promise<OperatorAccount | null>;
}
