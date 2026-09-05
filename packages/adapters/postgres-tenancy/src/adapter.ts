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
//
// AND SO DOES THE IDENTITY-ACCESS REPOSITORY, for exactly that reason widened by
// one context (ADR M0.3 §15). `tenancy` and `identity-access` own rows in the
// SAME PostgreSQL database, so their repositories are the same connection and
// the same transaction. A use case that creates an organization and its first
// owner's session is atomic across both without either context knowing the other
// has a store — and a second adapter package would have made that two pools, two
// transactions and a window in which one half is committed.
//
// AND SO DO TENANCY'S OTHER FIVE PORTS (WIN-258 T3). `TenancyDependencies` names
// six driven ports and only ONE of them is the repository: a row lock and an
// advisory lock, a session revoker, an access-key revocation counter, an
// invitation token issuer and an operator directory. Five of the six are here
// because they are the same connection as the sixth — the lock a use case takes
// has to be held by the transaction its writes are in, and a revocation ordered
// by a role change has to commit or roll back with it. The token issuer is the
// exception that proves the rule: it touches no database at all and is here only
// because a context asked for a port and something has to satisfy it.
//
// AND SO DOES THE `tools` REPOSITORY (WIN-258 T5), for the third time and for
// the same one sentence: `Tool`, `EnvironmentEntityTool`, `ToolHealth`,
// `ToolCall`, `ToolCallAudit`, `AgentToolPolicy`, `EntityToolPolicy`,
// `EntityMcpConfig`, `EntityMcpClient` and `OrganizationMcpPolicy` live in the
// SAME PostgreSQL database behind the SAME client. Its twenty-five names —
// twenty-five methods, no properties — collide with nothing tenancy or
// identity-access publishes, which is what lets the composite be SPREAD in and
// therefore lets `PORT_SATISFACTION` resolve `PostgresTenancyAdapter extends
// ToolsRepository` at compile time. A nested property could not satisfy that.
//
// AND SO DOES THE KERNEL OUTBOX'S `Event` WRITE (WIN-258 T4). `Event` is the one
// canonical row whose owner is an adapter rather than a context, and Amendment
// 15 gives the ORM a single home — so the package that owns the outbox port
// cannot be the package that issues its INSERT. `packages/adapters/outbox` keeps
// every decision that makes an event an event and hands a prepared row of
// primitives across the `OutboxEventStore` seam; the two statements that satisfy
// that seam are `./outbox-store.js`, spread in below.

import type { IdentityAccessRepository } from "@platos/context-identity-access/application/ports/index.js";
import type { ToolsRepository } from "@platos/context-tools/application/ports/index.js";
import type {
  EnvironmentAccessKeyRevocationCounter,
  InvitationTokenIssuer,
  OperatorDirectory,
  OperatorSessionRevoker,
  TenancyLocks,
  TenancyRepository,
  UnitOfWork,
} from "@platos/context-tenancy/application/ports/index.js";

import { createAccessKeyRevocationCounter } from "./access-key-revocation.js";
import type { TenancyClientOptions, TenancyDatabaseClient } from "./client.js";
import { createTenancyDatabaseClient } from "./client.js";
import { createIdentityAccessRepository } from "./identity-repository.js";
import { createInvitationRepository } from "./invitation.js";
import { createInvitationTokenIssuer } from "./invitation-token.js";
import { createTenancyLocks } from "./locks.js";
import { createMembershipRepository } from "./membership.js";
import { createOperatorDirectory, createOperatorSessionRevoker } from "./operator-peers.js";
import type { OutboxEventStorePort } from "./outbox-store.js";
import { createOutboxEventStore } from "./outbox-store.js";
import type { TenancyTransactions, TransactionTimeouts } from "./transaction.js";
import { createTenancyTransactions } from "./transaction.js";
import { createToolsRepository } from "./tools-repository.js";
import { createTreeRepository } from "./tree.js";

export interface PostgresTenancyAdapter
  extends TenancyRepository,
    IdentityAccessRepository,
    ToolsRepository,
    OutboxEventStorePort {
  readonly adapterName: "postgres-tenancy";
  /** The transaction boundary every write of this repository must run inside. */
  readonly unitOfWork: UnitOfWork;
  /**
   * WIN-258 T3 — tenancy's five driven ports that are NOT the repository.
   *
   * They are properties rather than spread-in methods, because unlike
   * `IdentityAccessRepository`'s ten stores they are five SEPARATE ports on
   * `TenancyDependencies` and a composition root has to hand each one to the
   * context under its own name. The names below are those names exactly, so the
   * bundle a root builds is this adapter's own keys and cannot be assembled with
   * one port in another's slot.
   */
  readonly locks: TenancyLocks;
  readonly sessionRevoker: OperatorSessionRevoker;
  readonly accessKeyRevocation: EnvironmentAccessKeyRevocationCounter;
  readonly invitationTokens: InvitationTokenIssuer;
  readonly operators: OperatorDirectory;
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
  // WIN-258 T3. Built ONCE and referenced twice: `operators` and
  // `sessionRevoker` below are handed narrow `Pick<>`s of these very stores, so
  // tenancy's two edges into identity-access resolve to the SAME objects the
  // identity-access half of this adapter publishes — one connection, one ambient
  // transaction, and no second implementation of `User` or `OperatorSession` to
  // keep in step. Building a second `createIdentityAccessRepository()` here
  // would have been two of everything over one database, which is the arrangement
  // ADR M0.3 §15 exists to refuse.
  const identity = createIdentityAccessRepository(transactions);
  return {
    adapterName: "postgres-tenancy",
    unitOfWork: transactions.unitOfWork,
    locks: createTenancyLocks(transactions),
    sessionRevoker: createOperatorSessionRevoker(transactions, identity.operatorSessions),
    accessKeyRevocation: createAccessKeyRevocationCounter(transactions),
    invitationTokens: createInvitationTokenIssuer(),
    operators: createOperatorDirectory(identity.users),
    async close(): Promise<void> {
      await client.$disconnect();
    },
    ...createTreeRepository(transactions),
    ...createMembershipRepository(transactions),
    ...createInvitationRepository(transactions),
    // WIN-258 T2 (ADR M0.3 §15). The identity-access composite is SPREAD in
    // beside tenancy's methods rather than nested under a property, because the
    // adapter type must EXTEND both ports for `PORT_SATISFACTION` in the
    // composition root to resolve — and `IdentityAccessRepository` is itself ten
    // named store properties, so there is no name collision to arbitrate: its
    // ten keys and tenancy's thirty-one are disjoint.
    ...identity,
    // WIN-258 T5. The `tools` repository, spread in for the reason the
    // identity-access composite is: the composition root proves
    // `PostgresTenancyAdapter extends ToolsRepository` at compile time, and a
    // nested property could not satisfy that. It is built from the same
    // `transactions` as everything else here, so a use case that registers an
    // entity's tools and bumps its environment's fence is ONE transaction.
    ...createToolsRepository(transactions),
    // WIN-258 T4. The canonical `Event` row, written on the kernel outbox
    // adapter's behalf. It is spread in here rather than exposed as a separate
    // object for the reason the identity-access composite is: the composition
    // root proves `PostgresTenancyAdapter extends OutboxEventStore` at compile
    // time, and a nested property could not satisfy that. Its two method names
    // collide with nothing — `insertOutboxEvent` and `readOutboxEventsAfter`
    // are the only members any of the three spread-in composites has that begin
    // with those words.
    ...createOutboxEventStore(transactions),
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
