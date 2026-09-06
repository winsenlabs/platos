// The `AlertChannel` and `AlertChannelConfiguration` half of `BudgetRepository`.
//
// ONE AGGREGATE OVER TWO TABLES, AND THE WRITES ARE TWO STATEMENTS ON PURPOSE.
// A nested Prisma write would have produced the same two INSERTs and hidden
// both: the sole-writer lint reads `X.<delegate>.<mutator>()` one file at a
// time, so a configuration created as a child of a channel is a write to
// `AlertChannelConfiguration` that no gate can see and no ownership rule can
// judge. Spelling them out puts both rows in front of the lint, and it is what
// lets `cost-transaction.integration.test.ts` fail the SECOND of the two against
// a real database and then look for the first.
//
// THEY ARE STILL ATOMIC. Both resolve through `transactions.writer(transaction)`,
// so they run on the connection holding the caller's open transaction and
// disappear together. That ordering is not optional either: the configuration's
// foreign key is `(channelId, environmentId, type)` against the channel's own
// unique index, so the channel row has to exist before its configuration can.
//
// `deletedAt` IS READ AND CANNOT BE WRITTEN, AND THAT IS A GAP IN THE PORT
// RATHER THAN IN THIS FILE. `AlertChannel` carries a `deletedAt` column and the
// listing index leads with it, but `domain/alert-channel.ts`'s `retireChannel`
// sets `enabled: false` and clears the deduplication key WITHOUT a tombstone,
// and `BudgetRepository` publishes no method that could set one — there is an
// `insertAlertChannel` and an `updateAlertChannel` and nothing else. So every
// row this adapter creates has `deletedAt` null forever, and the filter below
// exists for the rows an OLDER surface tombstoned: without it a channel that
// surface deleted would reappear in an operator's list and would still be
// counted as holding its credential, which is the exact question
// `countChannelsUsingCredential` is asked before a vault revoke.
//
// THE DEDUPLICATION KEY'S UNIQUE INDEX COUNTS TOMBSTONED ROWS. `@@unique([
// environmentId, deduplicationKey])` is not partial, so a retired channel that
// kept its key would hold it against every rebuild under the same name. That is
// why `retireChannel` nulls the key, and why this adapter writes the null
// through rather than treating the field as unchanged.

import type {
  AlertChannel,
  AlertChannelId,
  AlertChannelQuery,
  EnvironmentScope,
  Result,
  TransactionScope,
} from "@platos/context-cost-monitoring/application/ports/index.js";
import { err, ok, repositoryUnavailable } from "@platos/context-cost-monitoring/application/ports/index.js";

import { readChannel, scopedWhere, writeChannel, writeConfiguration } from "./cost-rows.js";
import type { TenancyTransactions } from "./transaction.js";

/**
 * The columns a channel read selects, its configuration included.
 *
 * A `select` rather than an `include` so the two columns this context does not
 * model — `integrationProvider` and `externalOrganizationId`, both written by an
 * older surface — are never read. A row that has them keeps them, because no
 * write below names them either.
 */
const CHANNEL_COLUMNS = {
  id: true,
  environmentId: true,
  type: true,
  name: true,
  enabled: true,
  alertTypes: true,
  deduplicationKey: true,
  userProvidedDeduplicationKey: true,
  createdAt: true,
  updatedAt: true,
  configuration: {
    select: {
      email: true,
      webhookUrl: true,
      slackChannelId: true,
      slackChannelName: true,
      integrationId: true,
      credentialId: true,
    },
  },
} as const;

/** `AlertChannelConfiguration.credentialId` is `@db.Uuid`; nothing else fits. */
const UUID = /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/u;

export interface AlertChannelStore {
  listAlertChannels(
    scope: EnvironmentScope,
    query: AlertChannelQuery,
  ): Promise<Result<readonly AlertChannel[]>>;
  findAlertChannel(
    scope: EnvironmentScope,
    channelId: AlertChannelId,
  ): Promise<Result<AlertChannel | null>>;
  insertAlertChannel(
    channel: AlertChannel,
    transaction: TransactionScope,
  ): Promise<Result<AlertChannel>>;
  updateAlertChannel(
    channel: AlertChannel,
    transaction: TransactionScope,
  ): Promise<Result<AlertChannel>>;
  countChannelsUsingCredential(
    scope: EnvironmentScope,
    credential: string,
  ): Promise<Result<number>>;
}

export function createAlertChannelStore(transactions: TenancyTransactions): AlertChannelStore {
  return {
    async listAlertChannels(
      scope: EnvironmentScope,
      query: AlertChannelQuery,
    ): Promise<Result<readonly AlertChannel[]>> {
      // Newest first, and `take` is applied by the database rather than after
      // the read: this listing is bounded by an operator's page size and the
      // ordering key is a real column, so unlike the cap listing there is
      // nothing here the store cannot sort on.
      const rows = await transactions.reader().alertChannel.findMany({
        where: {
          ...scopedWhere(scope),
          deletedAt: null,
          // Null means "do not filter", which is the port's own spelling. A
          // `kind: undefined` would read the same to Prisma; it is written as an
          // explicit spread so a future editor cannot make the two disagree.
          ...(query.kind === null ? {} : { type: query.kind }),
          ...(query.enabled === null ? {} : { enabled: query.enabled }),
        },
        select: CHANNEL_COLUMNS,
        orderBy: { createdAt: "desc" },
        take: query.limit,
      });
      return ok(rows.map(readChannel));
    },

    async findAlertChannel(
      scope: EnvironmentScope,
      channelId: AlertChannelId,
    ): Promise<Result<AlertChannel | null>> {
      const row = await transactions.reader().alertChannel.findFirst({
        where: { id: channelId, ...scopedWhere(scope), deletedAt: null },
        select: CHANNEL_COLUMNS,
      });
      return ok(row === null ? null : readChannel(row));
    },

    async insertAlertChannel(
      channel: AlertChannel,
      transaction: TransactionScope,
    ): Promise<Result<AlertChannel>> {
      const client = transactions.writer(transaction);
      const written = writeChannel(channel);
      const configuration = writeConfiguration(channel.configuration);
      // `createMany` with `skipDuplicates` — `ON CONFLICT DO NOTHING` — rather
      // than `create`. A raised 23505 would ABORT the caller's transaction, and
      // the port answers a clash with a `Result` the caller is entitled to act
      // on; handing back a refusal and a transaction in which nothing further
      // can be written is not an answer. `cost-budgets.ts`'s header carries the
      // whole finding.
      //
      // `alertTypes` is copied into a mutable array because the generated input
      // type asks for one. The guard that proved it non-empty ran in
      // `writeChannel`, so the copy cannot smuggle an empty list past it.
      const created = await client.alertChannel.createMany({
        data: [{ ...written, alertTypes: [...written.alertTypes] }],
        skipDuplicates: true,
      });
      if (created.count === 0) {
        // THREE unique indexes on this table can refuse, and they are different
        // facts: the primary key, `(id, environmentId, type)` and
        // `(environmentId, deduplicationKey)`. The port has one failure channel
        // and the in-memory double reports only the deduplication clash, so the
        // message names the constraint an operator can act on. A minted-id clash
        // is a caller defect and reads the same here, which is a genuine loss of
        // resolution and is recorded rather than papered over.
        return err(repositoryUnavailable("deduplication key already used"));
      }
      await client.alertChannelConfiguration.create({
        data: {
          channelId: written.id,
          environmentId: written.environmentId,
          type: written.type,
          ...configuration,
        },
      });
      return ok(channel);
    },

    async updateAlertChannel(
      channel: AlertChannel,
      transaction: TransactionScope,
    ): Promise<Result<AlertChannel>> {
      const client = transactions.writer(transaction);
      const written = writeChannel(channel);
      // Keyed on BOTH id and environmentId. `AlertChannel_owner_immutable`
      // already refuses a change of `environmentId` or `type` on this row, but
      // it compares OLD against NEW: it stops a channel being moved, and does
      // not stop a caller in tenant A editing tenant B's channel in place. The
      // predicate does.
      const outcome = await client.alertChannel.updateMany({
        where: { id: written.id, environmentId: written.environmentId, deletedAt: null },
        data: {
          name: written.name,
          enabled: written.enabled,
          alertTypes: [...written.alertTypes],
          deduplicationKey: written.deduplicationKey,
          userProvidedDeduplicationKey: written.userProvidedDeduplicationKey,
          updatedAt: written.updatedAt,
        },
      });
      if (outcome.count === 0) return err(repositoryUnavailable("no such channel"));
      await client.alertChannelConfiguration.updateMany({
        where: { channelId: written.id, environmentId: written.environmentId },
        data: writeConfiguration(channel.configuration),
      });
      return ok(channel);
    },

    async countChannelsUsingCredential(
      scope: EnvironmentScope,
      credential: string,
    ): Promise<Result<number>> {
      // A reference that is not a uuid names no `Credential` row, because the
      // column that would hold it is `@db.Uuid`. Answering zero is the true
      // count; sending the value to the database would raise 22P02 on the
      // comparison and turn a question with an answer into a driver error.
      if (!UUID.test(credential)) return ok(0);
      // LIVE means not tombstoned and not switched off, which is the double's
      // rule and the source's: an operator disabling a channel is why the vault
      // is asked before it revokes, and a second channel still switched on is
      // the one the revoke would break.
      const count = await transactions.reader().alertChannel.count({
        where: {
          ...scopedWhere(scope),
          deletedAt: null,
          enabled: true,
          configuration: { credentialId: credential },
        },
      });
      return ok(count);
    },
  };
}
