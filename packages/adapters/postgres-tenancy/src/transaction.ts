// The `UnitOfWork` implementation, and the correlation table that keeps the
// vendor transaction handle on this side of the port.
//
// ADR M0.3 §3 names the leaked transaction handle as one of the two cycles the
// design pre-empts: "No context passes a Prisma txn handle across a port."
// `TransactionScope` therefore carries an identifier and nothing else, and this
// module is the side table the kernel port's own comment describes — identifier
// in, real client out, and the real client never leaves this package.
//
// WHY THERE IS AN AMBIENT FRAME AS WELL AS A REGISTRY. `TenancyRepository`'s
// READ methods take no `TransactionScope`; only its writes do. That is not an
// oversight in the port, it is the shape a use case wants — but it means a read
// issued between two writes of the same transaction has no token to correlate
// on, and a repository that sent it to the pool would answer from OUTSIDE the
// transaction. Two things would then be wrong at once: the read would not see
// the transaction's own uncommitted rows, and `countActiveOwners` — whose port
// comment says "read under the organization row lock" — would run on a
// connection that holds no lock, which is the last-owner race the lock exists to
// close. So the open transaction is also carried in `AsyncLocalStorage`, and a
// read prefers it. The registry stays because a WRITE still has to prove the
// token it was handed is the transaction it is actually inside.
//
// THE THREE REFUSALS BELOW HAVE THREE CODES ON PURPOSE. They are three different
// mistakes — a write outside any transaction, a write with a token whose
// transaction has already finished, and a write with another live transaction's
// token — and a single shared code would make the second and third
// indistinguishable in a log, which is exactly how two defects hid behind one
// code in `privacy` and in `identity-access`.

import { AsyncLocalStorage } from "node:async_hooks";

import { asIdentifier } from "@platos/context-tenancy/application/ports/index.js";
import type {
  TransactionId,
  TransactionScope,
  UnitOfWork,
} from "@platos/context-tenancy/application/ports/index.js";

import type {
  TenancyDatabaseClient,
  TenancyReader,
  TenancyTransactionClient,
} from "./client.js";

/** A write was issued with no open transaction around it. */
export const TRANSACTION_NOT_OPEN = "tenancy.transaction.not_open";

/** The token names a transaction that has already committed or rolled back. */
export const TRANSACTION_SCOPE_UNKNOWN = "tenancy.transaction.scope_unknown";

/** The token names a DIFFERENT live transaction than the one being run in. */
export const TRANSACTION_SCOPE_FOREIGN = "tenancy.transaction.scope_foreign";

export class TransactionScopeError extends Error {
  readonly code: string;
  readonly transactionId: string;

  constructor(code: string, transactionId: string, message: string) {
    super(message);
    this.name = "TransactionScopeError";
    this.code = code;
    this.transactionId = transactionId;
  }
}

interface TransactionFrame {
  readonly transactionId: TransactionId;
  readonly client: TenancyTransactionClient;
}

/** How long a transaction may hold its connection, and how long it waits for one. */
export interface TransactionTimeouts {
  /** Milliseconds the callback may run before the transaction is rolled back. */
  readonly transactionTimeoutMs?: number;
  /** Milliseconds to wait for a free connection before failing to start. */
  readonly maxWaitMs?: number;
}

export interface TenancyTransactions {
  readonly unitOfWork: UnitOfWork;
  /** The client a WRITE carrying `scope` must use. Refuses three ways. */
  writer(scope: TransactionScope): TenancyTransactionClient;
  /** The client a READ must use: the open transaction if there is one, else the pool. */
  reader(): TenancyReader;
  /**
   * The POOLED client, never the ambient transaction.
   *
   * WIN-258 T5. `ProvidersRepository.touchProviderKey` is the one method in this
   * directory whose port says outright that it must NOT enlist in the caller's
   * unit of work: "it is bookkeeping on a read path, and enlisting it in the
   * caller's unit of work would make a failed write of this timestamp roll back
   * the turn that succeeded". `reader()` cannot express that — inside a
   * transaction it resolves to the transaction's own client, which is the whole
   * point of the ambient frame — so a `lastUsedAt` written through it would be
   * discarded with the turn that rolled back.
   *
   * It is deliberately NOT a general escape hatch, and the distinction is one a
   * reader can check: `writer(scope)` refuses three ways precisely so a write
   * cannot leave its transaction by accident, and every canonical WRITE in this
   * package goes through it. This returns the pool for a write whose port
   * requires it to be outside, and its one caller says so at the call site.
   */
  pool(): TenancyDatabaseClient;
  /**
   * Run `work` inside a transaction, JOINING one that is already open.
   *
   * WIN-258 T2. `IdentityAccessRepository`'s methods take no `TransactionScope`
   * at all — not even its writes — because ADR M0.3 §3 forbids passing a vendor
   * handle across a port and that context's use cases never needed to name one.
   * Several of those methods are nonetheless MULTI-STATEMENT and have to be
   * atomic: `saveTokenPair` writes a pair and consumes the token it replaces,
   * `replaceRecoveryCodes` deletes a set and inserts another, `commitRotation`
   * writes two rows under a row lock. Each one calls this.
   *
   * It is not a second transaction mechanism. It resolves its client through
   * `writer()`, so an identity-access multi-statement write is held to exactly
   * the three refusals a tenancy write is, and a use case that composes an
   * identity-access write with a tenancy one gets ONE transaction rather than
   * two — which is the whole reason the two contexts' repositories share a
   * directory (ADR M0.3 §15).
   */
  atomic<Value>(work: (client: TenancyTransactionClient) => Promise<Value>): Promise<Value>;
}

export function createTenancyTransactions(
  client: TenancyDatabaseClient,
  timeouts: TransactionTimeouts = {},
): TenancyTransactions {
  const ambient = new AsyncLocalStorage<TransactionFrame>();
  const open = new Map<string, TenancyTransactionClient>();
  let counter = 0;

  const unitOfWork: UnitOfWork = {
    async run<Value>(work: (transaction: TransactionScope) => Promise<Value>): Promise<Value> {
      const joined = ambient.getStore();
      // Nesting JOINS rather than opening a second transaction, which is the
      // kernel port's stated contract and what keeps a use case composed of two
      // smaller ones atomic.
      if (joined !== undefined) return work({ transactionId: joined.transactionId });

      counter += 1;
      const transactionId = asIdentifier<TransactionId>(`pg-txn-${counter}`);
      const options: { timeout?: number; maxWait?: number } = {};
      if (timeouts.transactionTimeoutMs !== undefined) options.timeout = timeouts.transactionTimeoutMs;
      if (timeouts.maxWaitMs !== undefined) options.maxWait = timeouts.maxWaitMs;

      try {
        return await client.$transaction(async (transactionClient) => {
          open.set(transactionId, transactionClient);
          return await ambient.run({ transactionId, client: transactionClient }, () =>
            work({ transactionId }),
          );
        }, options);
      } finally {
        // Removed whether the transaction committed or rolled back. A token that
        // outlived its transaction has to stop resolving, or a write handed a
        // stale scope would run on a closed client and fail somewhere with no
        // useful name on it.
        open.delete(transactionId);
      }
    },
  };

  const transactions: TenancyTransactions = {
    unitOfWork,

    writer(scope: TransactionScope): TenancyTransactionClient {
      const frame = ambient.getStore();
      if (frame === undefined) {
        throw new TransactionScopeError(
          TRANSACTION_NOT_OPEN,
          scope.transactionId,
          "a tenancy write must run inside UnitOfWork.run; no transaction is open",
        );
      }
      if (!open.has(scope.transactionId)) {
        throw new TransactionScopeError(
          TRANSACTION_SCOPE_UNKNOWN,
          scope.transactionId,
          `transaction ${scope.transactionId} is not open; it has already finished or never existed`,
        );
      }
      if (scope.transactionId !== frame.transactionId) {
        throw new TransactionScopeError(
          TRANSACTION_SCOPE_FOREIGN,
          scope.transactionId,
          `transaction ${scope.transactionId} is open but is not the one this write is running inside (${frame.transactionId})`,
        );
      }
      return frame.client;
    },

    reader(): TenancyReader {
      return ambient.getStore()?.client ?? client;
    },

    pool(): TenancyDatabaseClient {
      // The ambient frame is not consulted, and that is the whole difference
      // between this and `reader()`.
      return client;
    },

    async atomic<Value>(
      work: (transactionClient: TenancyTransactionClient) => Promise<Value>,
    ): Promise<Value> {
      // Named through `transactions` rather than `this`, because every store in
      // this package destructures the object it is handed and a `this`-bound
      // method would lose its receiver on the way in.
      return unitOfWork.run(async (scope) => work(transactions.writer(scope)));
    },
  };

  return transactions;
}
