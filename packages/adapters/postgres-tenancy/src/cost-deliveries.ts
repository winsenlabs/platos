// The `AlertDelivery` and send-record half of `BudgetRepository` — the outbound
// ledger, and the two writes that decide whether an alert is sent once or twice.
//
// THE CLAIM IS ONE CONDITIONAL WRITE, AND THE PORT SAYS WHY: "an implementation
// that reads the row, decides in application code and then writes has a window
// between the read and the write in which a second dispatcher can claim the same
// row, and both will send." So `claimDelivery` is a single `UPDATE … WHERE`
// whose predicate carries the whole decision — not settled, and the lease has
// expired — and whose `RETURNING` says whether it won. Nothing is read first.
//
// ITS PREDICATE IS SCALAR-ONLY, DELIBERATELY, AND THAT IS THE ONE PLACE THIS
// FILE DOES NOT RE-DERIVE THE SCOPE'S ANCESTRY. Every read below carries the
// organization-project-environment chain as a relation filter, which the driver
// folds into the same SELECT. On the claim it would be folded into a subquery
// the connector is free to satisfy with a separate statement, and a claim that
// became two statements would be a read and a write again — the exact shape the
// port forbids. The claim therefore keys on `id` and `environmentId`, both
// columns of the row, and is one statement by construction. A dispatcher reaches
// a delivery through `listPendingCrossings`, which DOES re-derive the chain, so
// the ancestry is checked once per crossing rather than once per claim.
//
// FINALISATION NAMES THE EXACT CLAIM IT HOLDS. The token, the generation and the
// retry number are all in the predicate, so a dispatcher whose lease expired —
// whose row was re-claimed and already finalised by somebody else — updates zero
// rows and appends NO send record. Returning `null` there is the port's contract
// and the reason a recovered delivery is not reported as a failed one.
//
// THE TWO WRITES OF A FINALISATION ARE ONE TRANSACTION, and the port states the
// failure each half causes alone: "a finalised row with no retry record loses
// the failure reason an operator needs, and a retry record with no finalised row
// leaves the delivery claimable and re-sends". Both resolve through
// `transactions.writer(transaction)`, so they are on the caller's connection and
// roll back together.

import type {
  AlertDelivery,
  AlertDeliveryId,
  AlertDeliveryRetry,
  ClaimToken,
  DeliveryStatus,
  DeliveryTarget,
  EnvironmentScope,
  PendingCrossing,
  Result,
  ThresholdEventId,
  TransactionScope,
} from "@platos/context-cost-monitoring/application/ports/index.js";
import {
  asIdentifier,
  environmentScope,
  err,
  ok,
  repositoryUnavailable,
} from "@platos/context-cost-monitoring/application/ports/index.js";

import { requireUuid } from "./cost-guards.js";
import {
  readBudget,
  readChannel,
  readCrossing,
  readDelivery,
  scopedWhere,
  writeDelivery,
  writeRetry,
} from "./cost-rows.js";
import { readPendingCrossings } from "./cost-pending.js";
import type { TenancyTransactions } from "./transaction.js";

const DELIVERY_COLUMNS = {
  id: true,
  environmentId: true,
  channelId: true,
  budgetThresholdEventId: true,
  kind: true,
  idempotencyKey: true,
  status: true,
  retryCount: true,
  claimGeneration: true,
  claimToken: true,
  availableAt: true,
  lastRetryAt: true,
  deliveredAt: true,
  lastStatusCode: true,
  lastErrorCode: true,
  lastErrorMessage: true,
  createdAt: true,
  updatedAt: true,
} as const;

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

/** The columns a finalisation writes. The five the owner rule freezes are absent. */
function settledColumns(delivery: AlertDelivery): {
  readonly status: DeliveryStatus;
  readonly retryCount: number;
  readonly claimGeneration: number;
  readonly claimToken: string | null;
  readonly availableAt: Date;
  readonly lastRetryAt: Date | null;
  readonly deliveredAt: Date | null;
  readonly lastStatusCode: number | null;
  readonly lastErrorCode: string | null;
  readonly lastErrorMessage: string | null;
  readonly updatedAt: Date;
} {
  const written = writeDelivery(delivery);
  return {
    status: written.status,
    retryCount: written.retryCount,
    claimGeneration: written.claimGeneration,
    claimToken: written.claimToken,
    availableAt: written.availableAt,
    lastRetryAt: written.lastRetryAt,
    deliveredAt: written.deliveredAt,
    lastStatusCode: written.lastStatusCode,
    lastErrorCode: written.lastErrorCode,
    lastErrorMessage: written.lastErrorMessage,
    updatedAt: written.updatedAt,
  };
}

export interface AlertDeliveryStore {
  insertDeliveries(
    deliveries: readonly AlertDelivery[],
    transaction: TransactionScope,
  ): Promise<Result<number>>;
  insertDelivery(
    delivery: AlertDelivery,
    transaction: TransactionScope,
  ): Promise<Result<AlertDelivery>>;
  listDeliveriesForEvent(
    scope: EnvironmentScope,
    eventId: ThresholdEventId,
  ): Promise<Result<readonly DeliveryTarget[]>>;
  findDelivery(
    scope: EnvironmentScope,
    deliveryId: AlertDeliveryId,
  ): Promise<Result<DeliveryTarget | null>>;
  claimDelivery(
    scope: EnvironmentScope,
    deliveryId: AlertDeliveryId,
    token: ClaimToken,
    leaseUntil: Date,
    at: Date,
  ): Promise<Result<AlertDelivery | null>>;
  finaliseDelivery(
    delivery: AlertDelivery,
    retry: AlertDeliveryRetry,
    expected: { readonly token: ClaimToken; readonly generation: number; readonly retryNumber: number },
    transaction: TransactionScope,
  ): Promise<Result<AlertDelivery | null>>;
  settleDelivery(
    delivery: AlertDelivery,
    retry: AlertDeliveryRetry,
    transaction: TransactionScope,
  ): Promise<Result<AlertDelivery>>;
  listPendingCrossings(
    statuses: readonly DeliveryStatus[],
    dueAt: Date,
    limit: number,
  ): Promise<Result<readonly PendingCrossing[]>>;
}

export function createAlertDeliveryStore(transactions: TenancyTransactions): AlertDeliveryStore {
  return {
    async insertDeliveries(
      deliveries: readonly AlertDelivery[],
      transaction: TransactionScope,
    ): Promise<Result<number>> {
      const client = transactions.writer(transaction);
      // ONE statement for the whole fan-out, and the skip is the DATABASE's.
      // `@@unique([environmentId, idempotencyKey])` is what makes a re-fan-out
      // of one crossing write nothing; deciding it in application code would
      // need a read per recipient and would still race two dispatchers.
      const outcome = await client.alertDelivery.createMany({
        data: deliveries.map(writeDelivery),
        skipDuplicates: true,
      });
      return ok(outcome.count);
    },

    async insertDelivery(
      delivery: AlertDelivery,
      transaction: TransactionScope,
    ): Promise<Result<AlertDelivery>> {
      const client = transactions.writer(transaction);
      // `createMany` again, and for the same reason `insertDeliveries` uses it:
      // a raised uniqueness violation would abort the caller's transaction, and
      // a test send is issued inside one that goes on to record its result.
      const created = await client.alertDelivery.createMany({
        data: [writeDelivery(delivery)],
        skipDuplicates: true,
      });
      if (created.count === 0) {
        return err(repositoryUnavailable("delivery idempotency key already used"));
      }
      return ok(delivery);
    },

    async listDeliveriesForEvent(
      scope: EnvironmentScope,
      eventId: ThresholdEventId,
    ): Promise<Result<readonly DeliveryTarget[]>> {
      const rows = await transactions.reader().alertDelivery.findMany({
        where: { budgetThresholdEventId: eventId, ...scopedWhere(scope) },
        select: { ...DELIVERY_COLUMNS, channel: { select: CHANNEL_COLUMNS } },
        orderBy: { createdAt: "asc" },
      });
      return ok(
        rows.map((row) => ({ delivery: readDelivery(row), channel: readChannel(row.channel) })),
      );
    },

    async findDelivery(
      scope: EnvironmentScope,
      deliveryId: AlertDeliveryId,
    ): Promise<Result<DeliveryTarget | null>> {
      const row = await transactions.reader().alertDelivery.findFirst({
        where: { id: deliveryId, ...scopedWhere(scope) },
        select: { ...DELIVERY_COLUMNS, channel: { select: CHANNEL_COLUMNS } },
      });
      if (row === null) return ok(null);
      return ok({ delivery: readDelivery(row), channel: readChannel(row.channel) });
    },

    async claimDelivery(
      scope: EnvironmentScope,
      deliveryId: AlertDeliveryId,
      token: ClaimToken,
      leaseUntil: Date,
      at: Date,
    ): Promise<Result<AlertDelivery | null>> {
      const claimToken = requireUuid("AlertDelivery.claimToken", token);
      // `atomic` rather than `writer`, because this method takes no
      // `TransactionScope` — the port's dispatcher claims outside any unit of
      // work. It resolves through `writer()` all the same, so a claim issued
      // inside somebody else's open transaction JOINS it rather than opening a
      // second one and deadlocking against the row that transaction holds.
      const rows = await transactions.atomic((client) =>
        client.alertDelivery.updateManyAndReturn({
          where: {
            id: deliveryId,
            environmentId: scope.environmentId,
            // SUCCEEDED is terminal and is skipped before any claim is written;
            // PROCESSING is claimable once its lease has expired, which is what
            // recovers a delivery whose dispatcher died. Both are one predicate
            // because `availableAt` carries the lease expiry and the retry
            // backoff in the same column.
            status: { not: "SUCCEEDED" },
            availableAt: { lte: at },
          },
          data: {
            status: "PROCESSING",
            claimToken,
            claimGeneration: { increment: 1 },
            // Incremented AT CLAIM TIME, not at finalisation. A dispatcher that
            // claims and then vanishes has still consumed a retry, so a channel
            // whose transport hangs cannot be retried without limit while
            // appearing never to have been tried at all.
            retryCount: { increment: 1 },
            availableAt: leaseUntil,
            lastRetryAt: at,
            updatedAt: at,
          },
          select: DELIVERY_COLUMNS,
        }),
      );
      const claimed = rows[0];
      return ok(claimed === undefined ? null : readDelivery(claimed));
    },

    async finaliseDelivery(
      delivery: AlertDelivery,
      retry: AlertDeliveryRetry,
      expected: {
        readonly token: ClaimToken;
        readonly generation: number;
        readonly retryNumber: number;
      },
      transaction: TransactionScope,
    ): Promise<Result<AlertDelivery | null>> {
      const client = transactions.writer(transaction);
      const written = writeDelivery(delivery);
      const record = writeRetry(retry);
      const outcome = await client.alertDelivery.updateMany({
        where: {
          id: written.id,
          environmentId: written.environmentId,
          // The whole proof, in the predicate. Deciding it after a read would
          // let a stale dispatcher's FAILED overwrite a fresh one's SUCCEEDED,
          // and the alert would go out a third time.
          status: "PROCESSING",
          claimToken: requireUuid("AlertDelivery.claimToken", expected.token),
          claimGeneration: expected.generation,
          retryCount: expected.retryNumber,
        },
        data: settledColumns(delivery),
      });
      // NOTHING is written when the claim is stale — not the row, and not the
      // send record. Appending the record anyway would leave a history entry for
      // a send whose result was discarded.
      if (outcome.count === 0) return ok(null);
      await client.alertDeliveryRetry.create({ data: record });
      return ok(delivery);
    },

    async settleDelivery(
      delivery: AlertDelivery,
      retry: AlertDeliveryRetry,
      transaction: TransactionScope,
    ): Promise<Result<AlertDelivery>> {
      const client = transactions.writer(transaction);
      const written = writeDelivery(delivery);
      const record = writeRetry(retry);
      // NO CLAIM IS NAMED, which is what makes this the synchronous path. The
      // port calls it "a delivery nobody claimed — a synchronous test send", and
      // `domain/alert-delivery.ts` refuses it for a `BUDGET` row precisely
      // because a fan-out has concurrent dispatchers and this predicate would
      // not tell them apart.
      const outcome = await client.alertDelivery.updateMany({
        where: { id: written.id, environmentId: written.environmentId },
        data: settledColumns(delivery),
      });
      if (outcome.count === 0) return err(repositoryUnavailable("no such delivery"));
      await client.alertDeliveryRetry.create({ data: record });
      return ok(delivery);
    },

    async listPendingCrossings(
      statuses: readonly DeliveryStatus[],
      dueAt: Date,
      limit: number,
    ): Promise<Result<readonly PendingCrossing[]>> {
      const rows = await readPendingCrossings(transactions, statuses, dueAt, limit);
      return ok(
        rows.map((row) => ({
          // RE-DERIVED, not reconstructed. This sweep is installation-wide and
          // has no request scope of its own, so the chain comes back from the
          // same join that found the crossing, through the kernel's own
          // constructor rather than an object literal this file assembles.
          scope: environmentScope(
            asIdentifier(row.organizationId),
            asIdentifier(row.projectId),
            asIdentifier(row.environmentId),
          ),
          event: readCrossing(row.event),
          budget: readBudget(row.budget),
        })),
      );
    },
  };
}
