// `EnvironmentAccessKeyRevocationCounter` — the port that closes a real
// single-writer violation in the baseline.
//
// THE VIOLATION, PRECISELY.
//
// `Environment` is a tenancy-owned row: ADR M0.3 §1 lists it in tenancy's
// SOLE-WRITER column, and §1's cutting rule is "every canonical row has exactly
// one context permitted to write it".
//
// `internal-packages/tenancy-database/src/access-key.ts` writes it anyway:
//
//     await tx.environment.update({
//       where: { id: input.environmentId },
//       data: { accessKeyRevocationVersion: { increment: 1 } },
//     });
//
// inside `revokeAccessKeys`, and reads it in `rotateAccessKey` /
// `lockEnvironment`. Access keys (`AccessKey`) are identity-access's rows
// (§1, context 1). So identity-access mutates a tenancy column directly. Under
// the §5.2 sole-writer lint — "FAIL if a file under packages/<X> calls a mutator
// on prisma.<model> whose OWNER[<model>] !== <X>" — that write is a violation
// the moment access-key rotation is extracted into `identity-access`.
//
// WHY THE COLUMN EXISTS AT ALL. It is a generation counter for a
// compare-and-set: a rotation snapshots the version, takes the environment row
// lock, and aborts with `access_key_rotation_superseded` if the version moved,
// so a revocation issued during a rotation always dominates. That is genuine,
// load-bearing behaviour and must survive the extraction unchanged. What must
// change is WHO issues the write.
//
// THE FIX MODELLED HERE. Tenancy keeps the write. identity-access calls
// `TenancyContract.revokeEnvironmentAccessKeyGeneration()` inside its own unit
// of work, and this port is the driven half the tenancy adapter implements.
// The `@@`-level atomicity the oracle gets from one `$transaction` is preserved
// because both halves take the same `TransactionScope`.
//
// REPORTED, NOT SILENTLY FIXED. The extraction of `AccessKey` belongs to
// identity-access (M2.1), so nothing here can complete the fix on its own. This
// port and `TenancyContract` are the tenancy-side half; the identity-access
// side must stop writing `Environment` directly for the violation to close.

import type { EnvironmentId, TransactionScope } from "@platos/kernel";

export interface EnvironmentAccessKeyRevocationCounter {
  /**
   * The current generation. Read WITHOUT the row lock, exactly as the oracle
   * snapshots it before waiting for the lock: a rotation that observes a stale
   * value is meant to be superseded, not to block.
   */
  read(environmentId: EnvironmentId): Promise<number | null>;

  /**
   * Increment the generation by one and return the new value.
   *
   * Monotonic and unconditional. The caller must hold the environment row lock
   * (`TenancyLocks.lockEnvironmentForUpdate`) so the read-modify-write is
   * serialized; the counter itself never decreases, so a revocation always
   * dominates every rotation that read an older value.
   */
  bump(environmentId: EnvironmentId, transaction: TransactionScope): Promise<number>;
}
