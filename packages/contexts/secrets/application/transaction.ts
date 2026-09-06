// Turning a `Result` failure into a rollback — now by DELEGATION, not by a
// carrier of this context's own.
//
// The kernel `UnitOfWork` commits when the work resolves and rolls back when it
// rejects. Use cases return `Result` rather than throwing, so without a bridge a
// failed step would RESOLVE with an error value and the transaction would COMMIT
// the partial write. For a vault that means a credential row with no envelope,
// or an envelope with no audit record.
//
// THIS FILE USED TO BUILD THAT BRIDGE ITSELF: a private `TransactionRollback`
// error class, a `ROLLBACK` symbol brand, and a `catch` that told its own
// rejection from a defect underneath. `cost-monitoring` had built a SECOND one,
// `CrossingFanOutFailed`, independently, for the same reason — which is the
// evidence that this shape is not a mistake anyone makes once but the ordinary
// reading of two contracts that collide. The kernel now owns the bridge, as
// `runResult` in `ports/unit-of-work.ts`, and `UnitOfWork.run`'s signature
// REFUSES a `Result`-valued callback outright, so there is no longer a third copy
// to reach for.
//
// `inTransaction` survives under the name `secrets` and its PostgreSQL
// transaction-boundary suite already use, and is now exactly the kernel's
// function wearing it.

import { runResult } from "@platos/kernel";
import type { Result, TransactionScope, UnitOfWork } from "@platos/kernel";

/**
 * Run `work` in one transaction. A `Result` failure rolls back and is returned;
 * anything else propagates.
 *
 * The signature is `runResult`'s, unchanged, because the two were always the same
 * function — one of them just did not yet know it belonged in the kernel.
 */
export async function inTransaction<Value>(
  unitOfWork: UnitOfWork,
  work: (transaction: TransactionScope) => Promise<Result<Value>>,
): Promise<Result<Value>> {
  return runResult(unitOfWork, work);
}
