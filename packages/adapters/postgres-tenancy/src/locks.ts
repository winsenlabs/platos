// `TenancyLocks` — the two serialization primitives, over real PostgreSQL.
//
// A LOCK NOTHING CAN OBSERVE BLOCKING IS DECORATIVE. That is the whole risk in
// this file and it is why every method here resolves its client through
// `writer(scope)` rather than through `reader()`. Both of PostgreSQL's locking
// facilities are TRANSACTION-scoped: `FOR UPDATE` holds until the surrounding
// transaction ends, and `pg_advisory_xact_lock` is released by commit or
// rollback and by nothing else. Taken on a pooled connection with no
// transaction open, the first is released the instant the statement returns and
// the second is taken on a connection the caller will never use again — in both
// cases the call succeeds, every test passes, and the race the lock exists to
// close is wide open. `writer(scope)` is what makes that unrepresentable: it
// refuses three ways when no transaction is open, when the token names a
// finished one, and when it names another live one, so a lock taken here is a
// lock the caller's own transaction holds.
//
// THE SECOND HALF OF THE SAME POINT is that `lockOrganizationForUpdate` and
// `lockEnvironmentForUpdate` return a BOOLEAN rather than throwing. `FOR UPDATE`
// over a row that does not exist is not an error in PostgreSQL: it locks nothing
// and returns no rows. The oracle's `organization.length !== 1` case is that
// empty result, and a caller which read "no exception" as "locked" would proceed
// unserialized against a tenant that is not there.
//
// WHY RAW SQL. Neither primitive is expressible through the query builder:
// `FOR UPDATE` has no representation in it at all, and `pg_advisory_xact_lock`
// is a function call rather than a row operation. The statements are static text
// with bound parameters, which is also what keeps them attributable to a table
// under the ADR M0.3 §5.2 sole-writer lint; a table name assembled at run time
// is refused there as unattributable, and rightly.

import type {
  EmailAddress,
  EnvironmentId,
  OrganizationId,
  TenancyLocks,
  TransactionScope,
} from "@platos/context-tenancy/application/ports/index.js";

import type { TenancyTransactions } from "./transaction.js";

/**
 * The advisory key an invitation slot is locked on.
 *
 * Exported and pure, so the key is checkable without a database and so the
 * shared conformance scenario can compare it against the string the in-memory
 * double records. A lock the fake spells one way and the adapter another is two
 * locks, and two locks serialize nothing.
 */
export function invitationSlotKey(organizationId: string, email: string): string {
  return `organization-invitation:${organizationId}:${email}`;
}

export function createTenancyLocks(transactions: TenancyTransactions): TenancyLocks {
  return {
    async lockOrganizationForUpdate(
      organizationId: OrganizationId,
      transaction: TransactionScope,
    ): Promise<boolean> {
      const rows = await transactions.writer(transaction).$queryRaw<readonly { id: string }[]>`
        SELECT id FROM "Organization"
        WHERE id = ${organizationId}::uuid AND "archivedAt" IS NULL
        FOR UPDATE
      `;
      // `=== 1`, not `> 0`. The primary key makes more than one row impossible,
      // and saying so is how a reader knows this is the oracle's
      // `organization.length !== 1` and not a truthiness test that would also
      // accept a future query returning several.
      return rows.length === 1;
    },

    async lockInvitationSlot(
      organizationId: OrganizationId,
      email: EmailAddress,
      transaction: TransactionScope,
    ): Promise<void> {
      // ADVISORY, and 64-bit. `hashtextextended(text, bigint)` turns an
      // arbitrary key into the bigint the advisory lock space is addressed by;
      // the seed is 0 because the value has to be reproducible across processes
      // and across releases, which a per-process seed would not be.
      //
      // It is the `_xact_` form and not the session form. A session advisory
      // lock outlives the transaction and is released only by an explicit
      // unlock or by the connection closing, which on a pooled connection is a
      // lock leaked into whichever caller is handed that connection next.
      //
      // THE FUNCTION IS IN `FROM`, NOT IN THE SELECT LIST, AND THAT IS FORCED.
      // `pg_advisory_xact_lock` returns `void`, and the client cannot
      // deserialize a `void` column: `SELECT pg_advisory_xact_lock(...)` fails
      // with "Failed to deserialize column of type 'void'". This is a real
      // PostgreSQL fact that no in-memory double could have surfaced — the first
      // integration run of this tranche found it — so the call is a one-row
      // function scan and the projection is a constant. The lock is taken all
      // the same: `pg_locks` shows one `advisory` row inside the transaction.
      await transactions.writer(transaction).$queryRaw<readonly { locked: number }[]>`
        SELECT 1 AS locked
        FROM pg_advisory_xact_lock(
          hashtextextended(${invitationSlotKey(organizationId, email)}::text, 0)
        )
      `;
    },

    async lockEnvironmentForUpdate(
      environmentId: EnvironmentId,
      transaction: TransactionScope,
    ): Promise<boolean> {
      // `accessKeyRevocationVersion` is selected although the boolean does not
      // need it, because this statement IS the fence: it is the read the
      // increment that follows has to be serialized behind, and naming the
      // column under the lock is what makes the lock's subject legible at the
      // one place a reader will look for it. There is deliberately NO
      // `archivedAt` clause — the port spells the statement without one, and an
      // archived environment whose keys are being revoked is exactly the case
      // that must still serialize.
      const rows = await transactions.writer(transaction).$queryRaw<
        readonly { id: string; accessKeyRevocationVersion: number }[]
      >`
        SELECT id, "accessKeyRevocationVersion" FROM "Environment"
        WHERE id = ${environmentId}::uuid
        FOR UPDATE
      `;
      return rows.length === 1;
    },
  };
}
