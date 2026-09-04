// The single `TenancyRepository` implementation. The vendor client is imported
// in `./client.js` and nowhere else in the repository.
//
// WHAT THIS FILE IS FOR. `PostgresTenancyAdapter` is the type `apps/core-api`
// binds: `PORT_SATISFACTION` in the composition root resolves
// `Satisfies<PostgresTenancyAdapter, TenancyRepository>` at compile time, so if
// this interface ever stops extending the port the build fails at the place the
// mistake matters. The three repository modules it is assembled from are split
// by concern rather than by method count, and the split is what keeps each of
// them inside ADR M0.3 §6's file budget.
//
// THE UNIT OF WORK SHIPS WITH THE REPOSITORY. They are one adapter because they
// are one connection: the transaction the `UnitOfWork` opens is the transaction
// the repository's writes have to be inside, and handing a caller two objects
// from two factories would make "which pool is this transaction on" a question
// with more than one answer.

import type {
  TenancyRepository,
  UnitOfWork,
} from "@platos/context-tenancy/application/ports/index.js";

import type { TenancyClientOptions, TenancyDatabaseClient } from "./client.js";
import { createTenancyDatabaseClient } from "./client.js";
import { createInvitationRepository } from "./invitation.js";
import { createMembershipRepository } from "./membership.js";
import type { TenancyTransactions, TransactionTimeouts } from "./transaction.js";
import { createTenancyTransactions } from "./transaction.js";
import { createTreeRepository } from "./tree.js";

export interface PostgresTenancyAdapter extends TenancyRepository {
  readonly adapterName: "postgres-tenancy";
  /** The transaction boundary every write of this repository must run inside. */
  readonly unitOfWork: UnitOfWork;
  /** Release the pool. The composition root owns this adapter's lifetime. */
  close(): Promise<void>;
}

export type PostgresTenancyOptions = TenancyClientOptions & TransactionTimeouts;

/**
 * Build the adapter over an ALREADY-OPEN client.
 *
 * Separate from `createPostgresTenancyAdapter` so a test can supply a client it
 * built against a container and still exercise the real repository. `close()`
 * here disconnects the client it was given, because the caller that opened it is
 * the caller that asked for the adapter.
 */
export function buildPostgresTenancyAdapter(
  client: TenancyDatabaseClient,
  timeouts: TransactionTimeouts = {},
): PostgresTenancyAdapter {
  const transactions: TenancyTransactions = createTenancyTransactions(client, timeouts);
  return {
    adapterName: "postgres-tenancy",
    unitOfWork: transactions.unitOfWork,
    async close(): Promise<void> {
      await client.$disconnect();
    },
    ...createTreeRepository(transactions),
    ...createMembershipRepository(transactions),
    ...createInvitationRepository(transactions),
  };
}

/** Open a pool and build the adapter over it. */
export function createPostgresTenancyAdapter(
  options: PostgresTenancyOptions,
): PostgresTenancyAdapter {
  const { transactionTimeoutMs, maxWaitMs, ...clientOptions } = options;
  const timeouts: TransactionTimeouts = {
    ...(transactionTimeoutMs === undefined ? {} : { transactionTimeoutMs }),
    ...(maxWaitMs === undefined ? {} : { maxWaitMs }),
  };
  return buildPostgresTenancyAdapter(createTenancyDatabaseClient(clientOptions), timeouts);
}
