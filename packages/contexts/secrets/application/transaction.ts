// Turning a `Result` failure into a rollback.
//
// The kernel `UnitOfWork` commits when the work resolves and rolls back when it
// rejects. Use cases return `Result` rather than throwing, so without this bridge
// a failed step would RESOLVE with an error value and the transaction would
// COMMIT the partial write. For a vault that means a credential row with no
// envelope, or an envelope with no audit record.
//
// So a failing step rejects with a private carrier, the carrier is caught out
// here, and the caller still sees a plain `Result`. The carrier is private to this
// module: nothing else can manufacture one, and an unrecognised rejection is
// re-thrown untouched because it is a defect and not a business outcome.

import { err } from "@platos/kernel";
import type { DomainError, Result, TransactionScope, UnitOfWork } from "@platos/kernel";

const ROLLBACK = Symbol("secrets.rollback");

class TransactionRollback extends Error {
  readonly [ROLLBACK] = true;
  readonly domainError: DomainError;

  constructor(domainError: DomainError) {
    super(domainError.code);
    this.name = "TransactionRollback";
    this.domainError = domainError;
  }
}

function isRollback(thrown: unknown): thrown is TransactionRollback {
  return thrown instanceof TransactionRollback;
}

/**
 * Run `work` in one transaction. A `Result` failure rolls back and is returned;
 * anything else propagates.
 */
export async function inTransaction<Value>(
  unitOfWork: UnitOfWork,
  work: (transaction: TransactionScope) => Promise<Result<Value>>,
): Promise<Result<Value>> {
  try {
    return await unitOfWork.run(async (transaction) => {
      const outcome = await work(transaction);
      if (!outcome.ok) throw new TransactionRollback(outcome.error);
      return outcome;
    });
  } catch (thrown) {
    if (isRollback(thrown)) return err(thrown.domainError);
    throw thrown;
  }
}
