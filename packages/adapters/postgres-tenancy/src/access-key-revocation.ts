// `EnvironmentAccessKeyRevocationCounter` — the fence ADR M0.3 §15 was argued
// on, implemented against the row that carries it.
//
// WHY THIS PORT IS THE DECIDING CASE FOR AMENDMENT 15, restated at the place it
// bites. `Environment` is a TENANCY row and `AccessKey` is identity-access's, so
// the generation counter a rotation and a revocation race over sits on the
// wrong side of the ownership line from the context that reads it. A thirteenth
// adapter package holding only identity-access's repositories could not have
// bumped this column without writing a row it does not own; the shared
// directory can, because it is already tenancy's delegate. Every write below is
// tenancy's, issued through tenancy's port, and `CANONICAL_STORE_ADAPTERS`
// checks that per write.
//
// THE FENCE IS THE PAIR, NOT THE INCREMENT. `accessKeyRevocationVersion = x + 1`
// is a single statement and PostgreSQL takes the row lock for it on its own, so
// two concurrent bumps ALREADY produce n+1 and n+2 rather than n+1 twice — the
// increment needs no help. What needs the lock is the COMPARE-AND-SET the
// counter exists for: read the generation, decide the caller's snapshot is still
// current, then bump. Without `TenancyLocks.lockEnvironmentForUpdate` held
// across all three, two rotations both read n, both find their snapshot
// current, and both commit, which is precisely the superseded rotation the
// counter was added to refuse. `locks.integration.test.ts` proves that by
// running the two concurrently with the lock and without it.
//
// EXPAND/CONTRACT. This column was ADDED by
// `migrations/20260825070000_access_key_revocation_fence`, not by the frozen
// baseline, and it landed NOT NULL DEFAULT 0 after a backfill. So a row written
// by a release older than that migration reads back as generation 0 rather
// than as null, and `read` must not confuse "this environment has never been
// revoked" with "this environment does not exist". Only the second is null.

import type {
  EnvironmentAccessKeyRevocationCounter,
  EnvironmentId,
  TransactionScope,
} from "@platos/context-tenancy/application/ports/index.js";

import type { TenancyTransactions } from "./transaction.js";

export function createAccessKeyRevocationCounter(
  transactions: TenancyTransactions,
): EnvironmentAccessKeyRevocationCounter {
  return {
    async read(environmentId: EnvironmentId): Promise<number | null> {
      // `reader()`, not `writer()`, and the port says why: a rotation snapshots
      // the generation BEFORE it queues for the row lock, so that a revocation
      // which starts while it waits still dominates. A read that took the lock
      // would turn every rotation into a queue and the fence into a bottleneck,
      // and — worse — would make a stale snapshot impossible, which would
      // silently delete the case `assertGenerationUnchanged` exists to catch.
      //
      // It still JOINS an open transaction when there is one, through the
      // ambient frame, so a read issued between this port's own bump and the
      // caller's commit sees the bump. That is the difference between "takes no
      // lock" and "runs on another connection".
      const row = await transactions.reader().environment.findUnique({
        where: { id: environmentId },
        select: { accessKeyRevocationVersion: true },
      });
      // `?? null` and not `?? 0`. Generation 0 is a real answer — every
      // environment starts there and every row backfilled by the fence
      // migration was set to it — so collapsing "absent" onto it would let
      // `revokeAccessKeyGeneration` accept a snapshot of 0 for an environment
      // that does not exist.
      return row?.accessKeyRevocationVersion ?? null;
    },

    async bump(environmentId: EnvironmentId, transaction: TransactionScope): Promise<number> {
      // ONE statement: `UPDATE ... SET x = x + 1 ... RETURNING x`. Read-modify-
      // write across two statements would be a lost update whenever the caller
      // forgot the row lock, and the port's contract — monotonic and
      // unconditional, so a revocation always dominates every rotation that read
      // an older value — is only true if the increment is computed by the
      // database from the value it holds rather than from one this process read.
      const row = await transactions.writer(transaction).environment.update({
        where: { id: environmentId },
        data: { accessKeyRevocationVersion: { increment: 1 } },
        select: { accessKeyRevocationVersion: true },
      });
      return row.accessKeyRevocationVersion;
    },
  };
}
