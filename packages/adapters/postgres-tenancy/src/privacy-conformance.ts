// One scenario, written once, so this context's in-memory double and this
// adapter can be asked the SAME questions and their answers compared.
//
// Same instrument as `./conformance.ts`, `./identity-conformance.ts`,
// `./governance-conformance.ts` and `./memory-conformance.ts`, and the same
// reason: two independently written suites measure two things and agree by
// coincidence. This module drives one sequence of port calls and records what
// came back; a test runs it twice and compares verbatim. A divergence is then a
// named step with a value on each side.
//
// NOTHING IS NORMALISED, AND THERE IS NOTHING TO NORMALISE. Both stores are
// handed whole aggregates — `PersistedErasureOperation` carries its own
// `requestedAt`, and `TombstoneDraft` its own `sealedAt` and `expiresAt` — so
// unlike `governance`'s five ports there is no instant for a store to mint. The
// one column PostgreSQL decides for itself, `updatedAt`, is `@updatedAt` and has
// no field on the aggregate at all, so it is not in the transcript because it
// cannot be.
//
// THE IDENTIFIERS ARE ALL UUIDS. `buildPrivacyTestContext()` in the context's own
// `application/testing/fixtures.ts` mints `org-1` for the organization and
// `id-0001` for every uuid; both satisfy the double and both are refused by
// `@db.Uuid`. The scenario is handed real ones by its environment, so a
// divergence here is a behaviour difference rather than a shape difference. The
// shape refusals have their own named cases in
// `privacy-constraints.integration.test.ts`.
//
// THREE THINGS ARE DELIBERATELY NOT IN THIS SCENARIO, because on each the double
// is WRONG rather than different, and a conformance run is for comparing answers.
// All three are pinned against the real database instead, and all three are
// reported:
//
//   A CONCURRENT IDEMPOTENCY RACE. `InMemoryPrivacyRepository.insertOperation`
//   SCANS its map before inserting, so it answers `idempotencyKeyConflict`
//   naming the winner for every duplicate. PostgreSQL raises 23505 and aborts the
//   caller's transaction, and the adapter has to name the winner from a
//   connection the failure did not abort. The two paths cannot produce the same
//   transcript because one of them has a rolled-back transaction in it.
//
//   A LEASE CLAIMED BY TWO CALLERS AT ONCE. The double's `claimLease` is a
//   compare-and-set over one map entry in a single-threaded process, so it is
//   unloseable; the adapter's is an UPDATE whose WHERE carries the free-lease
//   predicate and whose loser is decided by a row lock. Both are correct and only
//   one of them can be raced.
//
//   A SUB-MILLISECOND INSTANT. Every instant column is `timestamp(3)`; the double
//   keeps whatever `Date` it was handed. A `sealedAt` with microseconds in it
//   would come back truncated from one store and whole from the other, which is
//   a fact about the column and not about either implementation.

import type {
  ErasureOperationId,
  ErasureTombstoneId,
  OrganizationId,
  PersistedErasureOperation,
  PrivacyRepository,
  Result,
  TombstoneDraft,
  TransactionScope,
} from "@platos/context-privacy/application/ports/index.js";
import { organizationScope } from "@platos/context-privacy/application/ports/index.js";
import type { NotResult } from "@platos/kernel";

/** The uuids both stores are handed, so neither mints one. */
export interface PrivacyConformanceIds {
  readonly organizationId: OrganizationId;
  readonly foreignOrganizationId: OrganizationId;
  /** Four operation ids: two for the subject, one due, one never written. */
  readonly operationIds: readonly string[];
  readonly tombstoneIds: readonly string[];
  /** A uuid of the right SHAPE that names no row, so a miss is a miss. */
  readonly absentId: string;
}

/** One recorded answer. Values only — no store object ever reaches a comparison. */
export type PrivacyObservation = Record<string, unknown>;

const SUBJECT = "d0000abc";
const OTHER_SUBJECT = "d0000def";
const POLICY = "privacy/1";

const AT = new Date("2026-05-01T09:00:00.000Z");
const LATER = new Date("2026-05-01T10:00:00.000Z");
/**
 * Between `AT` and `LATER`, and it is load-bearing.
 *
 * `listDueOperations` orders by `nextRetryAt` alone, so two rows sharing that
 * instant have NO defined order — the double's `Array.prototype.sort` is stable
 * and PostgreSQL's is not defined at all, and the transcript would diverge on a
 * tie rather than on a behaviour. Three distinct instants make the page total.
 */
const MIDDLE = new Date("2026-05-01T09:30:00.000Z");
const SEALED_AT = new Date("2026-05-01T09:00:00.000Z");
const EXPIRES_AT = new Date("2026-06-01T09:00:00.000Z");
/** Exactly `EXPIRES_AT`. `isActive` is STRICTLY greater, so this row has lapsed. */
const BOUNDARY = new Date("2026-06-01T09:00:00.000Z");

/**
 * Tag a literal as one of this context's branded identifiers.
 *
 * A local rather than the kernel's `asIdentifier`, because half the values below
 * are branded and half — a `policyVersion`, a target name — are not, and one
 * helper that reads the same at every call site is what keeps the scenario a
 * sequence of port calls rather than a wall of casts.
 */
function id<Brand>(value: string): Brand {
  return value as Brand;
}

/** What both stores are asked to store, built from ids the caller supplies. */
function draft(
  ids: PrivacyConformanceIds,
  operationId: string,
  overrides: Partial<PersistedErasureOperation> = {},
): PersistedErasureOperation {
  return {
    operationId: id<ErasureOperationId>(operationId),
    organizationId: ids.organizationId,
    idempotencyKey: id(`key-${operationId}`),
    subjectKeyHash: id(SUBJECT),
    workStatus: "PENDING",
    scopes: [organizationScope(ids.organizationId)],
    outcomes: [],
    policyVersion: POLICY,
    legalHoldPolicyId: null,
    retryCount: 0,
    requestedAt: AT,
    startedAt: null,
    completedAt: null,
    nextRetryAt: null,
    leaseToken: null,
    leaseExpiresAt: null,
    ...overrides,
  };
}

/** A `Result` reduced to what both stores can be asked for. */
function seen<Value>(result: Result<Value>, project: (value: Value) => unknown): unknown {
  return result.ok ? { ok: true, value: project(result.value) } : { ok: false, code: result.error.code };
}

/** One operation, flattened. Every field is a value one of the two stores wrote. */
function operationShape(operation: PersistedErasureOperation | null): unknown {
  if (operation === null) return null;
  return {
    operationId: String(operation.operationId),
    organizationId: String(operation.organizationId),
    idempotencyKey: String(operation.idempotencyKey),
    subjectKeyHash: String(operation.subjectKeyHash),
    workStatus: operation.workStatus,
    scopeCount: operation.scopes.length,
    scopeLevels: operation.scopes.map((scope) => scope.level),
    outcomes: operation.outcomes.map((outcome) => `${outcome.target}:${outcome.status}:${outcome.verification}`),
    policyVersion: operation.policyVersion,
    legalHoldPolicyId: operation.legalHoldPolicyId,
    retryCount: operation.retryCount,
    requestedAt: operation.requestedAt.toISOString(),
    startedAt: operation.startedAt?.toISOString() ?? null,
    completedAt: operation.completedAt?.toISOString() ?? null,
    nextRetryAt: operation.nextRetryAt?.toISOString() ?? null,
    leaseToken: operation.leaseToken === null ? null : String(operation.leaseToken),
    leaseExpiresAt: operation.leaseExpiresAt?.toISOString() ?? null,
  };
}

/**
 * Drive one store through the whole surface and record what it said.
 *
 * `open` is how the caller supplies a transaction: the double takes any handle
 * and the adapter takes one its own ambient frame minted, and neither store may
 * be asked to invent one — which is exactly the coupling `TransactionScope`
 * exists to keep opaque.
 */
export async function runPrivacyConformance(
  store: PrivacyRepository,
  ids: PrivacyConformanceIds,
  open: <Value>(work: (transaction: TransactionScope) => Promise<NotResult<Value>>) => Promise<Value>,
): Promise<Record<string, PrivacyObservation | unknown>> {
  const observations: Record<string, unknown> = {};
  const [first, second, due, missing] = ids.operationIds;
  const [tombA, tombB, tombC] = ids.tombstoneIds;

  // --- the operation half -------------------------------------------------
  observations["insert.first"] = await open(async (transaction) =>
    seen(await store.insertOperation(draft(ids, first ?? ""), transaction), operationShape),
  );

  // A SECOND operation for the SAME subject digest, so the per-subject listing
  // has an order to get wrong. Its own key, because the unique index is on
  // (organizationId, idempotencyKey) and a repeat would be testing the conflict.
  observations["insert.second"] = await open(async (transaction) =>
    seen(
      await store.insertOperation(
        draft(ids, second ?? "", { requestedAt: LATER, nextRetryAt: MIDDLE }),
        transaction,
      ),
      operationShape,
    ),
  );

  // A THIRD, due for the queue, in the SAME organization. `listDueOperations` is
  // deliberately not organization-scoped, so a foreign row would make the
  // comparison depend on what else the container holds.
  observations["insert.due"] = await open(async (transaction) =>
    seen(
      await store.insertOperation(
        draft(ids, due ?? "", {
          subjectKeyHash: id(OTHER_SUBJECT),
          workStatus: "ACTIVE",
          nextRetryAt: AT,
          startedAt: AT,
        }),
        transaction,
      ),
      operationShape,
    ),
  );

  observations["findByIdempotencyKey.hit"] = seen(
    await store.findByIdempotencyKey(ids.organizationId, id(`key-${first ?? ""}`)),
    operationShape,
  );
  observations["findByIdempotencyKey.miss"] = seen(
    await store.findByIdempotencyKey(ids.organizationId, id("key-never-issued")),
    operationShape,
  );
  // THE CROSS-TENANT PROBE. The key exists — in another organization — and the
  // port requires `null` rather than the row.
  observations["findByIdempotencyKey.foreign"] = seen(
    await store.findByIdempotencyKey(ids.foreignOrganizationId, id(`key-${first ?? ""}`)),
    operationShape,
  );

  observations["findOperation.hit"] = seen(
    await store.findOperation(ids.organizationId, id(first ?? "")),
    operationShape,
  );
  observations["findOperation.absent"] = seen(
    await store.findOperation(ids.organizationId, id(ids.absentId)),
    operationShape,
  );
  observations["findOperation.foreign"] = seen(
    await store.findOperation(ids.foreignOrganizationId, id(first ?? "")),
    operationShape,
  );

  // The duplicate key. Both stores must refuse and neither may convert the
  // insert into an update — which the following read is what proves.
  observations["insert.duplicateKey"] = await open(async (transaction) =>
    seen(
      await store.insertOperation(
        draft(ids, ids.absentId, { subjectKeyHash: id(OTHER_SUBJECT), idempotencyKey: id(`key-${first ?? ""}`) }),
        transaction,
      ),
      operationShape,
    ),
  );
  observations["insert.duplicateKey.subjectUnchanged"] = seen(
    await store.findOperation(ids.organizationId, id(first ?? "")),
    (operation) => operation?.subjectKeyHash ?? null,
  );

  observations["updateProgress.hit"] = await open(async (transaction) =>
    seen(
      await store.updateProgress(
        ids.organizationId,
        id(first ?? ""),
        {
          workStatus: "FAILED",
          outcomes: [
            {
              target: "memory",
              status: "done",
              verification: "failed",
              discovered: 4,
              counts: { deleted: 3, anonymized: 0, cryptoShredded: 0, retained: 1 },
              failures: 0,
              note: "1 row(s) survived the erasure",
            },
          ],
          legalHoldPolicyId: null,
          retryCount: 1,
          startedAt: AT,
          completedAt: null,
          nextRetryAt: LATER,
          leaseToken: null,
          leaseExpiresAt: null,
        },
        transaction,
      ),
      operationShape,
    ),
  );
  // THE IMMUTABLE HALF. `updateProgress` cannot carry `subjectKeyHash` or
  // `requestedAt` at all, so this asserts they came back unmoved rather than
  // that the store declined to move them.
  observations["updateProgress.identityUnmoved"] = seen(
    await store.findOperation(ids.organizationId, id(first ?? "")),
    (operation) => ({
      subjectKeyHash: operation === null ? null : String(operation.subjectKeyHash),
      requestedAt: operation?.requestedAt.toISOString() ?? null,
    }),
  );
  observations["updateProgress.absent"] = await open(async (transaction) =>
    seen(
      await store.updateProgress(
        ids.organizationId,
        id(missing ?? ""),
        {
          workStatus: "PENDING",
          outcomes: [],
          legalHoldPolicyId: null,
          retryCount: 0,
          startedAt: null,
          completedAt: null,
          nextRetryAt: null,
          leaseToken: null,
          leaseExpiresAt: null,
        },
        transaction,
      ),
      operationShape,
    ),
  );

  observations["claimLease.free"] = await open(async (transaction) =>
    seen(
      await store.claimLease(
        ids.organizationId,
        id(second ?? ""),
        { token: id("lease-1"), expiresAt: LATER },
        AT,
        transaction,
      ),
      (claimed) => claimed,
    ),
  );
  // The SAME operation, at an instant BEFORE the lease expires. Held.
  observations["claimLease.held"] = await open(async (transaction) =>
    seen(
      await store.claimLease(
        ids.organizationId,
        id(second ?? ""),
        { token: id("lease-2"), expiresAt: LATER },
        AT,
        transaction,
      ),
      (claimed) => claimed,
    ),
  );
  // And at exactly the expiry instant. `isLeaseFree` is `<=`, so it is free.
  observations["claimLease.atExpiry"] = await open(async (transaction) =>
    seen(
      await store.claimLease(
        ids.organizationId,
        id(second ?? ""),
        { token: id("lease-3"), expiresAt: LATER },
        LATER,
        transaction,
      ),
      (claimed) => claimed,
    ),
  );
  observations["claimLease.absent"] = await open(async (transaction) =>
    seen(
      await store.claimLease(
        ids.organizationId,
        id(missing ?? ""),
        { token: id("lease-4"), expiresAt: LATER },
        AT,
        transaction,
      ),
      (claimed) => claimed,
    ),
  );

  observations["listDue.atAt"] = seen(await store.listDueOperations(AT, 10), (rows) =>
    rows.map((row) => String(row.operationId)),
  );
  observations["listDue.atLater"] = seen(await store.listDueOperations(LATER, 10), (rows) =>
    rows.map((row) => String(row.operationId)),
  );
  observations["listDue.limited"] = seen(await store.listDueOperations(LATER, 1), (rows) =>
    rows.map((row) => String(row.operationId)),
  );
  observations["listDue.zero"] = seen(await store.listDueOperations(LATER, 0), (rows) => rows.length);

  observations["listForSubject"] = seen(
    await store.listOperationsForSubject(ids.organizationId, id(SUBJECT)),
    (rows) => rows.map((row) => String(row.operationId)),
  );
  observations["listForSubject.foreign"] = seen(
    await store.listOperationsForSubject(ids.foreignOrganizationId, id(SUBJECT)),
    (rows) => rows.length,
  );

  // --- the register half --------------------------------------------------
  const drafts: readonly TombstoneDraft[] = [
    { organizationId: ids.organizationId, aliasHash: id("a-external"), operationId: id<ErasureOperationId>(first ?? ""), policyVersion: POLICY, sealedAt: SEALED_AT, expiresAt: EXPIRES_AT },
    { organizationId: ids.organizationId, aliasHash: id("a-email"), operationId: id<ErasureOperationId>(first ?? ""), policyVersion: POLICY, sealedAt: SEALED_AT, expiresAt: EXPIRES_AT },
  ];
  observations["seal.first"] = await open(async (transaction) =>
    seen(
      await store.sealTombstones(
        drafts,
        [id<ErasureTombstoneId>(tombA ?? ""), id<ErasureTombstoneId>(tombB ?? "")],
        transaction,
      ),
      (outcome) => outcome,
    ),
  );
  observations["seal.empty"] = await open(async (transaction) =>
    seen(await store.sealTombstones([], [], transaction), (outcome) => outcome),
  );
  // A RE-SEAL. Two aliases already sealed and one new, so the split is visible:
  // insert what is missing, extend what exists, delete nothing.
  observations["seal.again"] = await open(async (transaction) =>
    seen(
      await store.sealTombstones(
        [
          ...drafts.map((entry) => ({ ...entry, expiresAt: new Date("2026-07-01T09:00:00.000Z") })),
          {
            organizationId: ids.organizationId,
            aliasHash: id("a-slack"),
            operationId: id<ErasureOperationId>(first ?? ""),
            policyVersion: POLICY,
            sealedAt: SEALED_AT,
            expiresAt: new Date("2026-07-01T09:00:00.000Z"),
          },
        ],
        [
          id<ErasureTombstoneId>(tombA ?? ""),
          id<ErasureTombstoneId>(tombB ?? ""),
          id<ErasureTombstoneId>(tombC ?? ""),
        ],
        transaction,
      ),
      (outcome) => outcome,
    ),
  );

  observations["findActive.hit"] = seen(
    await store.findActiveTombstones(ids.organizationId, [id("a-external"), id("a-email")], AT),
    (rows) => rows.map((row) => String(row.aliasHash)).sort(),
  );
  observations["findActive.empty"] = seen(
    await store.findActiveTombstones(ids.organizationId, [], AT),
    (rows) => rows.length,
  );
  observations["findActive.unsealed"] = seen(
    await store.findActiveTombstones(ids.organizationId, [id("a-never-sealed")], AT),
    (rows) => rows.length,
  );
  // THE CROSS-TENANT PROBE, which cannot match anyway because the digests are
  // organization-salted — and would still be wrong if it did.
  observations["findActive.foreign"] = seen(
    await store.findActiveTombstones(ids.foreignOrganizationId, [id("a-external")], AT),
    (rows) => rows.length,
  );
  observations["findActive.shape"] = seen(
    await store.findActiveTombstones(ids.organizationId, [id("a-external")], AT),
    (rows) =>
      rows.map((row) => ({
        tombstoneId: String(row.tombstoneId),
        organizationId: String(row.organizationId),
        aliasHash: String(row.aliasHash),
        operationId: String(row.operationId),
        policyVersion: row.policyVersion,
        sealedAt: row.sealedAt.toISOString(),
        expiresAt: row.expiresAt.toISOString(),
      })),
  );

  // --- retention, at the boundary instant ---------------------------------
  const lapsing: TombstoneDraft = {
    organizationId: ids.organizationId,
    aliasHash: id("a-lapsing"),
    operationId: id<ErasureOperationId>(first ?? ""),
    policyVersion: POLICY,
    sealedAt: SEALED_AT,
    expiresAt: EXPIRES_AT,
  };
  observations["seal.lapsing"] = await open(async (transaction) =>
    seen(
      await store.sealTombstones([lapsing], [id<ErasureTombstoneId>(ids.absentId)], transaction),
      (outcome) => outcome,
    ),
  );
  // STRICTLY greater: a row whose expiry IS the current instant has elapsed.
  observations["findActive.atBoundary"] = seen(
    await store.findActiveTombstones(ids.organizationId, [id("a-lapsing")], BOUNDARY),
    (rows) => rows.length,
  );
  observations["findActive.beforeBoundary"] = seen(
    await store.findActiveTombstones(
      ids.organizationId,
      [id("a-lapsing")],
      new Date(BOUNDARY.getTime() - 1),
    ),
    (rows) => rows.length,
  );
  // And `purgeExpiredTombstones` deletes precisely the rows `findActive` already
  // refuses — the complement, at the same instant.
  observations["purge.atBoundary"] = await open(async (transaction) =>
    seen(await store.purgeExpiredTombstones(BOUNDARY, transaction), (purged) => purged),
  );
  observations["purge.again"] = await open(async (transaction) =>
    seen(await store.purgeExpiredTombstones(BOUNDARY, transaction), (purged) => purged),
  );
  observations["findActive.afterPurge"] = seen(
    await store.findActiveTombstones(
      ids.organizationId,
      [id("a-lapsing"), id("a-external")],
      AT,
    ),
    (rows) => rows.map((row) => String(row.aliasHash)),
  );

  return observations;
}
