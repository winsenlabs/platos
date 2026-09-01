// ADR M0.3 §4 kernel port: UnitOfWork.
//
// ADR M0.3 §3 names the leaked-Prisma-transaction outbox as one of the two
// self-introduced cycles this design pre-empts: "No context passes a Prisma txn
// handle across a port." `TransactionScope` is therefore opaque — it carries an
// identifier and nothing else. The adapter keeps the real handle in its own
// side table keyed by that identifier, so a context can enlist the outbox in its
// transaction without ever naming a vendor type.

import type { TransactionId } from "../vo/identifier.js";

/**
 * A handle to the open transaction. Deliberately carries no vendor object: it is
 * a token that adapters correlate on, not a database session.
 */
export interface TransactionScope {
  readonly transactionId: TransactionId;
}

export interface UnitOfWork {
  /**
   * Run `work` inside one transaction. It commits when `work` resolves and rolls
   * back when it rejects. Nesting joins the outer transaction rather than opening
   * a second one, so a use case composed of two smaller ones stays atomic.
   */
  run<Value>(work: (transaction: TransactionScope) => Promise<Value>): Promise<Value>;
}
