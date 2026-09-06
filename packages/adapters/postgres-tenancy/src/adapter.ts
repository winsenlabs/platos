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
//
// AND SO DO `agents`' TWO CANONICAL-STORE PORTS (WIN-258 T5). The seven rows of
// ADR M0.3 §1 row 5 are in the same PostgreSQL database as the other thirty-one,
// so by Amendment 15 they are written from the same directory behind the same
// client. Both are SPREAD IN, for the reason every composite above is: the
// composition root resolves `Satisfies<PostgresTenancyAdapter, AgentsRepository>`
// and `Satisfies<PostgresTenancyAdapter, ScaffoldingRepository>` at compile time,
// and a nested property could satisfy neither. The two ports are disjoint from
// each other by construction and share no method name with tenancy's,
// identity-access's, tools' or the outbox's.
//
// AND SO DO `governance`'s FIVE CANONICAL-STORE PORTS (WIN-258 T5). `SafetyEvent`,
// `MessageRating`, `EvalCriterion`, `AgentEval` and `GoldenSet` are in that same
// database behind that same client, so by Amendment 15 they are written from this
// directory too — the SIXTH owner delegated to it. They are the one delegation
// here that CANNOT be spread in: the five ports collide with each other on
// `findById`, `page`, `create`, `update` and `remove`, so they arrive as five
// named properties and `PORT_SATISFACTION` proves each through the property that
// carries it, exactly as it does for tenancy's five non-repository ports. The
// context's other five ports are deliberately absent: `read-seams.ts` declares
// three READERS of rows four OTHER contexts own, `judge.ts` is a provider
// transport, and `eval-run-queue.ts` is durable work whose own refusal code
// exists to stay separable from a store outage.
//
// AND SO DO `secrets`' TWO CANONICAL-STORE PORTS (WIN-258 T5) — but as
// PROPERTIES rather than as spread-in methods, and that is the one exception in
// this file that was FORCED rather than chosen. `SecretsRepository.appendAudit`
// and `ToolsRepository.appendAudit` are both top-level members, with different
// signatures, so `PostgresTenancyAdapter extends ToolsRepository,
// SecretsRepository` is a TypeScript error — "cannot simultaneously extend" —
// and a spread would have let whichever composite came last silently win. Named
// properties are what tranche 3 already does for tenancy's five
// non-repository ports, and the composition root proves each binding by indexing
// the property that carries it rather than the adapter itself.
//
// AND SO DOES `cost-monitoring`'s `BudgetRepository` (WIN-258 T5). Its six rows
// are in that same database behind that same client, so by Amendment 15 they
// are written from this directory too — the FIFTH owner delegated to it. Its
// twenty-two method names collide with nothing above, so it is spread in like
// the rest and `PORT_SATISFACTION` can resolve
// `Satisfies<PostgresTenancyAdapter, BudgetRepository>` at compile time. The
// context's three OTHER ports are deliberately not here: `SpendLedger` is an
// expiring counter keyspace, `BudgetCapCache` is the cache ADR M0.3 §7 chose so
// the pre-spend guard would not read the canonical store on the hot path, and
// `Notifier` is a transport bound to the two notifier packages.
//
// AND SO DOES `channels`' `ChannelsRepository` (WIN-258 T5). The six rows of ADR
// M0.3 §1 row 9 are in that same database behind that same client — the SIXTH
// owner delegated to this directory — so Amendment 15 puts them here rather than
// in a thirteenth package holding a second client. Its seventeen method names
// collide with nothing above, so it is spread in like the rest and
// `PORT_SATISFACTION` can resolve
// `Satisfies<PostgresTenancyAdapter, ChannelsRepository>` at compile time. The
// context's four OTHER ports are deliberately not here and
// `channels-repository.ts` says why for each: `ChannelAdapter` and
// `ChannelAdapterRegistry` are the provider seam §5.1(h) pins to
// `packages/adapters/channel-slack`, `ChannelCredentialReader` reads a vault
// this directory holds no grant for, `AgentDirectory` is a peer read across an
// edge the §1 DAG does not grant, and `ChannelEventCipher` is the key that opens
// every inbox row — which is the one thing the process that stores them must not
// hold.

// AND SO DOES `providers`' `ProvidersRepository` (WIN-258 T5). The four rows of
// ADR M0.3 §1 row 4 — `ProviderKey`, `EnvironmentProvider`, `Model` and
// `ModelPrice` — are in that same database behind that same client, so Amendment
// 15 puts them here rather than in a thirteenth package holding a second client.
// Its eighteen method names collide with nothing above, so it is spread in like
// the rest and `PORT_SATISFACTION` can resolve
// `Satisfies<PostgresTenancyAdapter, ProvidersRepository>` at compile time.
//
// IT IS ALSO WHAT MAKES `register-provider-key.ts` ATOMIC. That use case creates
// a credential through `secrets` and then writes the `ProviderKey` that points
// at it, and `ProviderKey_credential_provider_integrity` RE-READS that
// credential from inside the key's own INSERT. `secrets` resolves to this same
// directory, so both halves are the same client and the same transaction; two
// pools would have had the rule looking for a row still uncommitted on the
// other connection.
//
// The context's two OTHER ports are deliberately not here: `ModelRouter` is the
// provider SDK boundary §5.1 rule (h) pins to
// `packages/adapters/model-router-providers`, and `ProviderProbeCache` is a
// five-minute memo of what a provider said — backing it with the canonical store
// would put a provider's transient answers into the database the port exists to
// keep them out of.

import type { ChannelsRepository } from "@platos/context-channels/application/ports/index.js";
import type {
  AgentsRepository,
  ScaffoldingRepository,
} from "@platos/context-agents/application/ports/index.js";
import type { BudgetRepository } from "@platos/context-cost-monitoring/application/ports/index.js";
import type {
  CriteriaRepository,
  EvalsRepository,
  GoldenSetsRepository,
  RatingsRepository,
  SafetyLedger,
} from "@platos/context-governance/application/ports/index.js";
import type { IdentityAccessRepository } from "@platos/context-identity-access/application/ports/index.js";
import type { ProvidersRepository } from "@platos/context-providers/application/ports/index.js";
import type {
  EnvironmentVariableRepository,
  SecretsRepository,
} from "@platos/context-secrets/application/ports/index.js";
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
import { createAgentsRepository } from "./agents-repository.js";
import { createScaffoldingRepository } from "./agents-scaffolding.js";
import type { TenancyClientOptions, TenancyDatabaseClient } from "./client.js";
import { createTenancyDatabaseClient } from "./client.js";
import { createChannelsRepository } from "./channels-repository.js";
import { createCostMonitoringRepository } from "./cost-repository.js";
import { createGovernanceStores } from "./governance-repository.js";
import { createIdentityAccessRepository } from "./identity-repository.js";
import { createInvitationRepository } from "./invitation.js";
import { createInvitationTokenIssuer } from "./invitation-token.js";
import { createTenancyLocks } from "./locks.js";
import { createMembershipRepository } from "./membership.js";
import { createOperatorDirectory, createOperatorSessionRevoker } from "./operator-peers.js";
import type { OutboxEventStorePort } from "./outbox-store.js";
import { createOutboxEventStore } from "./outbox-store.js";
import { createProvidersRepository } from "./providers-repository.js";
import {
  createEnvironmentVariableRepository,
  createSecretsRepository,
} from "./secrets-repository.js";
import type { TenancyTransactions, TransactionTimeouts } from "./transaction.js";
import { createTenancyTransactions } from "./transaction.js";
import { createToolsRepository } from "./tools-repository.js";
import { createTreeRepository } from "./tree.js";

export interface PostgresTenancyAdapter
  extends TenancyRepository,
    IdentityAccessRepository,
    ToolsRepository,
    AgentsRepository,
    ScaffoldingRepository,
    BudgetRepository,
    ChannelsRepository,
    ProvidersRepository,
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
  /**
   * WIN-258 T5 — `governance`'s FIVE canonical-store ports.
   *
   * Properties rather than spread-in methods, and unlike tenancy's five that is
   * FORCED rather than preferred: these five ports collide with each other.
   * `findById` is declared on four of them, `page` on four, and `create`,
   * `update` and `remove` on two apiece — so a flat spread would keep whichever
   * composite came last and answer four ports from one table. The names are
   * `GovernanceDependencies`' own slot names, so the bundle a composition root
   * assembles is these keys and cannot put one port in another's slot.
   */
  readonly safety: SafetyLedger;
  readonly ratings: RatingsRepository;
  readonly criteria: CriteriaRepository;
  readonly evals: EvalsRepository;
  readonly goldenSets: GoldenSetsRepository;

  /**
   * WIN-258 T5 — `secrets`' two canonical-store ports.
   *
   * PROPERTIES, and for a harder reason than tenancy's five above. Those are
   * separate ports on a dependency bundle and could have been spread if their
   * names had been free; these two CANNOT be spread at all, because
   * `SecretsRepository.appendAudit(draft, transaction)` collides by name and
   * differs by signature with `ToolsRepository.appendAudit(scope, entry)`, which
   * this adapter already publishes. The names below are `SecretsDependencies`'
   * own two slots — `repository` and `variables` — spelled with the owner in
   * front, because `repository` alone is not a name a directory serving eight
   * owners can give to one of them.
   */
  readonly secrets: SecretsRepository;
  readonly secretsVariables: EnvironmentVariableRepository;
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
    // WIN-258 T5 (ADR M0.3 §15). The SIXTH owner delegated to this directory.
    // Built from the same `transactions` as everything above, so the erasure
    // target that counts a subject's safety events and ratings and then
    // anonymises the first and destroys the second is ONE transaction.
    ...createGovernanceStores(transactions),
    // WIN-258 T5. Built from the SAME `transactions` as everything else here,
    // so a `setEnvironmentVariable` that seals a credential, writes an envelope,
    // points the credential at it, writes the variable row and appends two audit
    // records is ONE transaction — and the `countReferences` that decides
    // whether to revoke sees the row the same transaction just wrote.
    secrets: createSecretsRepository(transactions),
    secretsVariables: createEnvironmentVariableRepository(transactions),
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
    // WIN-258 T5 (ADR M0.3 §15). The FIFTH owner in this directory, on the same
    // argument the second was: `cost-monitoring`'s six rows are in the one
    // PostgreSQL database, behind the one client, so a thirteenth adapter
    // package holding only its repositories would be a second home for that
    // client and would make `tenancy-prisma-only` unwritable as a single-home
    // rule. Its twenty-two method names are disjoint from tenancy's thirty-one,
    // identity-access's ten store properties, tools' twenty-five and agents'
    // thirty-five, so there is nothing to arbitrate; the spread is what lets
    // `PORT_SATISFACTION` in the composition root resolve
    // `PostgresTenancyAdapter extends BudgetRepository` at compile time, which a
    // nested property could not.
    ...createCostMonitoringRepository(transactions),
    // WIN-258 T4. The canonical `Event` row, written on the kernel outbox
    // adapter's behalf. It is spread in here rather than exposed as a separate
    // object for the reason the identity-access composite is: the composition
    // root proves `PostgresTenancyAdapter extends OutboxEventStore` at compile
    // time, and a nested property could not satisfy that. Its two method names
    // collide with nothing — `insertOutboxEvent` and `readOutboxEventsAfter`
    // are the only members any of the three spread-in composites has that begin
    // with those words.
    ...createOutboxEventStore(transactions),
    // WIN-258 T5. `agents`' two canonical-store ports, SPREAD IN for the reason
    // the identity-access composite is: `PORT_SATISFACTION` in the composition
    // root resolves `Satisfies<PostgresTenancyAdapter, AgentsRepository>` and
    // `Satisfies<PostgresTenancyAdapter, ScaffoldingRepository>` at compile time,
    // and a nested property could not satisfy either. Their method names collide
    // with nothing: the two ports are disjoint from each other by construction —
    // `Macro` and `PostmanTemplate` are the rows a SURFACE writes on its own
    // behalf, and they share no invariant with a version history — and neither
    // has a name in common with tenancy's thirty-one, identity-access's ten
    // store properties, or the outbox's two.
    ...createAgentsRepository(transactions),
    ...createScaffoldingRepository(transactions),
    // WIN-258 T5 (ADR M0.3 §15). The SIXTH owner in this directory, on the same
    // argument every owner above it stands on: `channels`' six rows are in the
    // one PostgreSQL database, behind the one client, so a thirteenth adapter
    // package holding only its repository would be a second home for that client
    // and would make `tenancy-prisma-only` unwritable as a single-home rule. Its
    // seventeen method names are disjoint from tenancy's thirty-one,
    // identity-access's ten store properties, tools' twenty-five, agents'
    // thirty-five, cost-monitoring's twenty-two and the outbox's two, so there is
    // nothing to arbitrate; the spread is what lets `PORT_SATISFACTION` in the
    // composition root resolve `PostgresTenancyAdapter extends ChannelsRepository`
    // at compile time, which a nested property could not.
    ...createChannelsRepository(transactions),
    // WIN-258 T5 (ADR M0.3 §15). The NINTH owner in this directory, on the same
    // argument every owner above it stands on: `providers`' four rows are in the
    // one PostgreSQL database, behind the one client. Its eighteen method names
    // are disjoint from tenancy's thirty-one, identity-access's ten store
    // properties, tools' twenty-five, agents' thirty-five, cost-monitoring's
    // twenty-two, channels' seventeen and the outbox's two, so there is nothing
    // to arbitrate; the spread is what lets `PORT_SATISFACTION` resolve
    // `PostgresTenancyAdapter extends ProvidersRepository` at compile time.
    //
    // Built from the SAME `transactions` as `secrets` above, which is what makes
    // "create the credential, then write the key that points at it" one
    // transaction — and therefore what lets the rule that re-reads the
    // credential from inside the key's INSERT see it.
    ...createProvidersRepository(transactions),
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
