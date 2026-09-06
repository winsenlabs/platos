// `OperationRepository` — the `ErasureOperation` row, which IS the receipt.
//
// EVERY READ IS ORGANIZATION-SCOPED, AND THE SCOPE IS IN THE `where` RATHER THAN
// IN A CHECK AFTERWARDS. The port says an implementation "MUST return `null` —
// not another tenant's row — when the id exists elsewhere". A read that fetched
// by primary key and compared the organization in TypeScript would be correct
// and would still have loaded the other tenant's row into this process; the
// predicate below never selects it. `listDueOperations` is the one deliberate
// exception and its own comment says why.
//
// THE LEASE IS A COMPARE-AND-SET, IN ONE STATEMENT. `claimLease`'s port comment
// is explicit: "the check and the claim must be one operation or two resumes
// racing both see a free lease". The free-lease predicate is part of the UPDATE's
// `where`, so PostgreSQL's own row lock decides the winner. A read-then-write
// would have had a window between the two statements exactly as wide as the
// round trip, and every test would still pass.
//
// THE IDEMPOTENCY CONFLICT HAS TWO SHAPES AND THEY ARE NOT THE SAME FACT.
// `findByIdempotencyKey` is what `request-erasure.ts` calls first, so the
// ordinary duplicate never reaches `insertOperation` at all. What reaches it is a
// RACE: the key was free when the caller probed and taken by the time the INSERT
// ran. PostgreSQL raises 23505 and ABORTS the caller's transaction, so the
// statement that would name the winning operation cannot be sent on that
// connection — and the port's required error, `PRIVACY_IDEMPOTENCY_KEY_CONFLICT`,
// carries the winner's id in its details. It is named anyway, from the POOL,
// which is the one read in this package whose port requires it to be OUTSIDE the
// caller's unit of work: the caller's unit of work is aborted, and a read on it
// would fail with 25P02 rather than answer. See `transaction.ts`'s `pool()`.
//
// AND WHEN THE POOL CANNOT NAME IT, THAT IS ITS OWN CODE. A unique violation
// this store did not cause on `(organizationId, idempotencyKey)` — a repeated
// PRIMARY KEY, which is a caller minting an id twice — leaves the probe finding
// nothing, and answering `PRIVACY_IDEMPOTENCY_KEY_CONFLICT` for it would tell a
// caller their key names a different person when it does not.

import type {
  ErasureOperationId,
  IdempotencyKey,
  LeaseToken,
  OperationRepository,
  OperationProgressWrite,
  OrganizationId,
  PersistedErasureOperation,
  Result,
  SubjectKeyHash,
  TransactionScope,
  WorkStatus,
} from "@platos/context-privacy/application/ports/index.js";
import {
  err,
  idempotencyKeyConflict,
  ok,
  operationNotFound,
  operationStoreUnavailable,
} from "@platos/context-privacy/application/ports/index.js";

import { isUniqueViolation, jsonList, type TenancyJsonInput } from "./client.js";
import {
  guardOperationProgress,
  guardStorableOperation,
  requirePageLimit,
  requireUuid,
} from "./privacy-guards.js";
import { refusePrivacy } from "./privacy-refusal.js";
import { OPERATION_COLUMNS, readOperationRow, type OperationRow } from "./privacy-rows.js";
import type { TenancyTransactions } from "./transaction.js";

/**
 * A unique violation on the PRIMARY KEY rather than on the idempotency key.
 *
 * DISTINCT from `PRIVACY_IDEMPOTENCY_KEY_CONFLICT` on purpose. That error names
 * the operation the key is already bound to; this one has no operation to name,
 * because the probe on a clean connection found no row at that key — so what
 * collided was the id the caller minted, and reporting a subject conflict for it
 * would be a false statement about a person.
 */
export const OPERATION_ID_TAKEN = "privacy.write.operation_id_taken";

/**
 * The progress columns one pass advances. `stores` is the outcomes array.
 *
 * The return type is spelled out rather than left as `Record<string, unknown>`,
 * and that is load-bearing rather than tidy: an index signature is INVISIBLE to
 * the generated client's `ErasureOperationCreateManyInput`, so a spread of one
 * compiles while omitting a NOT NULL column. `stores` was exactly that column,
 * and `tsc -b` said so — which it could only do because this shape is declared.
 */
interface OperationProgressColumns {
  readonly status: WorkStatus;
  readonly stores: TenancyJsonInput;
  readonly legalHoldPolicyId: string | null;
  readonly retryCount: number;
  readonly nextRetryAt: Date | null;
  readonly leaseToken: string | null;
  readonly leaseExpiresAt: Date | null;
  readonly startedAt: Date | null;
  readonly completedAt: Date | null;
}

function progressData(progress: OperationProgressWrite): OperationProgressColumns {
  return {
    status: progress.workStatus,
    stores: jsonList(progress.outcomes),
    legalHoldPolicyId: progress.legalHoldPolicyId,
    retryCount: progress.retryCount,
    nextRetryAt: progress.nextRetryAt,
    leaseToken: progress.leaseToken,
    leaseExpiresAt: progress.leaseExpiresAt,
    startedAt: progress.startedAt,
    completedAt: progress.completedAt,
  };
}

export function createPrivacyOperationStore(
  transactions: TenancyTransactions,
): OperationRepository {
  /**
   * Name the operation that already holds this key, on a connection the failed
   * INSERT has not aborted.
   *
   * `pool()` and not `reader()`: inside a transaction `reader()` resolves to the
   * transaction's own client, which is exactly the aborted one.
   */
  async function nameKeyHolder(
    organizationId: string,
    idempotencyKey: string,
  ): Promise<OperationRow | null> {
    return (await transactions.pool().erasureOperation.findUnique({
      where: { organizationId_idempotencyKey: { organizationId, idempotencyKey } },
      select: OPERATION_COLUMNS,
    })) as OperationRow | null;
  }

  return {
    async findByIdempotencyKey(
      organizationId: OrganizationId,
      idempotencyKey: IdempotencyKey,
    ): Promise<Result<PersistedErasureOperation | null>> {
      return refusePrivacy(async () => {
        requireUuid("ErasureOperation.organizationId", organizationId);
        const row = (await transactions.reader().erasureOperation.findUnique({
          where: { organizationId_idempotencyKey: { organizationId, idempotencyKey } },
          select: OPERATION_COLUMNS,
        })) as OperationRow | null;
        return ok(row === null ? null : readOperationRow(row));
      }, "findByIdempotencyKey");
    },

    async findOperation(
      organizationId: OrganizationId,
      operationId: ErasureOperationId,
    ): Promise<Result<PersistedErasureOperation | null>> {
      return refusePrivacy(async () => {
        requireUuid("ErasureOperation.organizationId", organizationId);
        requireUuid("ErasureOperation.id", operationId);
        // `findFirst` and not `findUnique`: the organization is not part of the
        // primary key, and a scope-less `findUnique` followed by a comparison
        // would have loaded another tenant's row before rejecting it.
        const row = (await transactions.reader().erasureOperation.findFirst({
          where: { id: operationId, organizationId },
          select: OPERATION_COLUMNS,
        })) as OperationRow | null;
        return ok(row === null ? null : readOperationRow(row));
      }, "findOperation");
    },

    async insertOperation(
      operation: PersistedErasureOperation,
      transaction: TransactionScope,
    ): Promise<Result<PersistedErasureOperation>> {
      return refusePrivacy(async () => {
        guardStorableOperation(operation);
        const writer = transactions.writer(transaction);
        try {
          const written = (await writer.erasureOperation.createManyAndReturn({
            data: [
              {
                id: operation.operationId,
                organizationId: operation.organizationId,
                idempotencyKey: operation.idempotencyKey,
                subjectKeyHash: operation.subjectKeyHash,
                scopes: jsonList(operation.scopes),
                policyVersion: operation.policyVersion,
                requestedAt: operation.requestedAt,
                ...progressData(operation),
              },
            ],
            select: OPERATION_COLUMNS,
          })) as OperationRow[];
          const [row] = written;
          // `createManyAndReturn` is an INSERT ... RETURNING with no conflict
          // clause, so an empty result would mean the row was written and not
          // returned — which the driver does not do, and which this store must
          // not paper over by returning the aggregate it was handed.
          if (row === undefined) {
            return err(operationStoreUnavailable(`insertOperation:${OPERATION_ID_TAKEN}`));
          }
          return ok(readOperationRow(row));
        } catch (error) {
          if (!isUniqueViolation(error)) throw error;
          const holder = await nameKeyHolder(operation.organizationId, operation.idempotencyKey);
          if (holder === null) {
            return err(
              operationStoreUnavailable(
                `insertOperation:${OPERATION_ID_TAKEN}:${operation.operationId}`,
              ),
            );
          }
          return err(idempotencyKeyConflict(holder.id));
        }
      }, "insertOperation");
    },

    async updateProgress(
      organizationId: OrganizationId,
      operationId: ErasureOperationId,
      progress: OperationProgressWrite,
      transaction: TransactionScope,
    ): Promise<Result<PersistedErasureOperation>> {
      return refusePrivacy(async () => {
        requireUuid("ErasureOperation.organizationId", organizationId);
        requireUuid("ErasureOperation.id", operationId);
        guardOperationProgress(progress);
        // ONE statement, and the scope is in the `where`. `updateManyAndReturn`
        // is an `UPDATE ... RETURNING`, so the row that comes back is the row
        // that was written rather than a re-read that a concurrent pass could
        // have moved in between. The identity columns are not in `data` at all,
        // which is the port's "immutable half" expressed as a statement rather
        // than as a convention.
        const written = (await transactions.writer(transaction).erasureOperation.updateManyAndReturn({
          where: { id: operationId, organizationId },
          data: progressData(progress),
          select: OPERATION_COLUMNS,
        })) as OperationRow[];
        const [row] = written;
        if (row === undefined) return err(operationNotFound(operationId));
        return ok(readOperationRow(row));
      }, "updateProgress");
    },

    async claimLease(
      organizationId: OrganizationId,
      operationId: ErasureOperationId,
      lease: { readonly token: LeaseToken; readonly expiresAt: Date },
      now: Date,
      transaction: TransactionScope,
    ): Promise<Result<boolean>> {
      return refusePrivacy(async () => {
        requireUuid("ErasureOperation.organizationId", organizationId);
        requireUuid("ErasureOperation.id", operationId);
        guardOperationProgress({
          workStatus: "ACTIVE",
          outcomes: [],
          retryCount: 0,
          startedAt: null,
          completedAt: null,
          nextRetryAt: null,
          leaseToken: lease.token,
          leaseExpiresAt: lease.expiresAt,
        });
        const writer = transactions.writer(transaction);
        // The free-lease predicate is `isLeaseFree`'s exact SQL: null, or expired
        // at or before `now`. It is in the `where` of the UPDATE, so the check
        // and the claim are one statement and PostgreSQL's row lock arbitrates.
        const claimed = await writer.erasureOperation.updateMany({
          where: {
            id: operationId,
            organizationId,
            OR: [{ leaseExpiresAt: null }, { leaseExpiresAt: { lte: now } }],
          },
          data: { leaseToken: lease.token, leaseExpiresAt: lease.expiresAt },
        });
        if (claimed.count > 0) return ok(true);
        // Zero rows is two facts — held, or not here — and the port answers them
        // differently: `ok(false)` is a normal outcome and `operationNotFound` is
        // an error. Only the LOSING path pays for the second statement.
        const present = await writer.erasureOperation.findFirst({
          where: { id: operationId, organizationId },
          select: { id: true },
        });
        return present === null ? err(operationNotFound(operationId)) : ok(false);
      }, "claimLease");
    },

    async listDueOperations(
      asOf: Date,
      limit: number,
    ): Promise<Result<readonly PersistedErasureOperation[]>> {
      return refusePrivacy(async () => {
        requirePageLimit(limit);
        // DELIBERATELY NOT ORGANIZATION-SCOPED, and the port says so: this is the
        // QUEUE's page, and a queue that had to be told which tenant to drain
        // would need a tenant list nothing gives it. Every column it returns is
        // already content-free.
        const rows = (await transactions.reader().erasureOperation.findMany({
          where: { nextRetryAt: { lte: asOf } },
          orderBy: { nextRetryAt: "asc" },
          take: limit,
          select: OPERATION_COLUMNS,
        })) as OperationRow[];
        return ok(rows.map(readOperationRow));
      }, "listDueOperations");
    },

    async listOperationsForSubject(
      organizationId: OrganizationId,
      subjectKeyHash: SubjectKeyHash,
    ): Promise<Result<readonly PersistedErasureOperation[]>> {
      return refusePrivacy(async () => {
        requireUuid("ErasureOperation.organizationId", organizationId);
        const rows = (await transactions.reader().erasureOperation.findMany({
          where: { organizationId, subjectKeyHash },
          orderBy: { requestedAt: "desc" },
          select: OPERATION_COLUMNS,
        })) as OperationRow[];
        return ok(rows.map(readOperationRow));
      }, "listOperationsForSubject");
    },
  };
}
