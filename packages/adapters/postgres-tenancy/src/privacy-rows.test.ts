// The mapping and the guards, WITHOUT a database — and that is what makes this
// suite necessary rather than redundant.
//
// A container only ever reads rows THIS binary wrote, so every unreadable-row
// branch in `privacy-rows.ts` is unreachable from an integration suite except
// through a row planted by `prisma db execute`. Two of them cannot even be
// planted: `ErasureOperation.status` is a PostgreSQL ENUM, so a sixth label is a
// value the column itself refuses, and `scopes`/`stores` carry `_json_root`
// CHECKs that refuse a non-array root outright. Those branches exist for the
// binary that runs against a schema a LATER migration widened — an expand phase,
// where the column has grown a label this process has never heard of — and this
// is the only place they can be exercised at all.
//
// THE GUARDS ARE HERE FOR THE OPPOSITE REASON. Every one of them refuses BEFORE a
// statement is sent, so an integration suite can only observe that no row
// appeared; it cannot observe WHICH guard fired, and two guards sharing one code
// would be indistinguishable there. Each is named here by its own code.

import { describe, expect, test } from "vitest";

import type {
  PersistedErasureOperation,
  TombstoneDraft,
} from "@platos/context-privacy/application/ports/index.js";
import { organizationScope } from "@platos/context-privacy/application/ports/index.js";

import {
  guardOperationProgress,
  guardSealBatch,
  guardStorableOperation,
  isStorableWorkStatus,
  PRIVACY_IDENTIFIER_NOT_UUID,
  PRIVACY_INSTANT_NOT_REPRESENTABLE,
  PRIVACY_LEASE_INCOHERENT,
  PRIVACY_OUTCOMES_NOT_ARRAY,
  PRIVACY_PAGE_LIMIT_INVALID,
  PRIVACY_RETRY_COUNT_INVALID,
  PRIVACY_SCOPES_NOT_ARRAY,
  PRIVACY_SEAL_IDS_MISSING,
  PRIVACY_SEAL_SPANS_TENANTS,
  PRIVACY_TOMBSTONE_WINDOW_INVERTED,
  PRIVACY_WORK_STATUS_UNKNOWN,
  PrivacyWriteRefused,
  requirePageLimit,
} from "./privacy-guards.js";
import {
  readOperationRow,
  readTombstoneRow,
  UNKNOWN_WORK_STATUS,
  UNREADABLE_JSON_ARRAY,
  UNREADABLE_TARGET_OUTCOME,
  UNREADABLE_TENANT_SCOPE,
  UnreadablePrivacyRow,
  type OperationRow,
  type TombstoneRow,
} from "./privacy-rows.js";

const ORG = "bbbbbbbb-0001-4000-8000-000000000001";
const OPERATION = "bbbbbbbb-0002-4000-8000-000000000002";
const TOMBSTONE = "bbbbbbbb-0003-4000-8000-000000000003";
const AT = new Date("2026-05-01T09:00:00.000Z");

function row(overrides: Partial<OperationRow> = {}): OperationRow {
  return {
    id: OPERATION,
    organizationId: ORG,
    idempotencyKey: "key-1",
    subjectKeyHash: "d0000abc",
    status: "PENDING",
    scopes: [{ level: "organization", organizationId: ORG }],
    stores: [],
    policyVersion: "privacy/1",
    legalHoldPolicyId: null,
    retryCount: 0,
    nextRetryAt: null,
    leaseToken: null,
    leaseExpiresAt: null,
    requestedAt: AT,
    startedAt: null,
    completedAt: null,
    ...overrides,
  };
}

function tombstoneRow(overrides: Partial<TombstoneRow> = {}): TombstoneRow {
  return {
    id: TOMBSTONE,
    organizationId: ORG,
    aliasHash: "a-external",
    operationId: OPERATION,
    policyVersion: "privacy/1",
    sealedAt: AT,
    expiresAt: new Date("2026-06-01T09:00:00.000Z"),
    ...overrides,
  };
}

function operation(overrides: Partial<PersistedErasureOperation> = {}): PersistedErasureOperation {
  return {
    operationId: OPERATION as PersistedErasureOperation["operationId"],
    organizationId: ORG as PersistedErasureOperation["organizationId"],
    idempotencyKey: "key-1" as PersistedErasureOperation["idempotencyKey"],
    subjectKeyHash: "d0000abc" as PersistedErasureOperation["subjectKeyHash"],
    workStatus: "PENDING",
    scopes: [organizationScope(ORG as PersistedErasureOperation["organizationId"])],
    outcomes: [],
    policyVersion: "privacy/1",
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

function draft(overrides: Partial<TombstoneDraft> = {}): TombstoneDraft {
  return {
    organizationId: ORG as TombstoneDraft["organizationId"],
    aliasHash: "a-external" as TombstoneDraft["aliasHash"],
    operationId: OPERATION as TombstoneDraft["operationId"],
    policyVersion: "privacy/1",
    sealedAt: AT,
    expiresAt: new Date("2026-06-01T09:00:00.000Z"),
    ...overrides,
  };
}

/** The refusal code a thrown guard carries, or a marker that nothing threw. */
function refusalOf(work: () => unknown): string {
  try {
    work();
  } catch (error) {
    if (error instanceof PrivacyWriteRefused) return error.code;
    if (error instanceof UnreadablePrivacyRow) return error.code;
    return `<unexpected:${String(error)}>`;
  }
  return "<nothing was refused>";
}

describe("reading an ErasureOperation row", () => {
  test("a well-formed row round-trips into the aggregate the port declares", () => {
    const read = readOperationRow(
      row({
        status: "FAILED",
        stores: [
          {
            target: "memory",
            status: "done",
            verification: "failed",
            discovered: 4,
            counts: { deleted: 3, anonymized: 0, cryptoShredded: 0, retained: 1 },
            failures: 0,
            note: null,
          },
        ],
        retryCount: 2,
        legalHoldPolicyId: "hold#3/ab12",
        nextRetryAt: new Date("2026-05-01T10:00:00.000Z"),
      }),
    );
    expect(read.operationId).toBe(OPERATION);
    expect(read.workStatus).toBe("FAILED");
    expect(read.outcomes).toHaveLength(1);
    expect(read.outcomes[0]?.verification).toBe("failed");
    expect(read.retryCount).toBe(2);
    expect(read.legalHoldPolicyId).toBe("hold#3/ab12");
    expect(read.scopes[0]?.level).toBe("organization");
  });

  test("a status label this binary has never heard of is REFUSED, not cast past", () => {
    // The whole reason the read validates. `receiptStatusFor` has four branches
    // and a fifth label matches none of them, so a cast would report a finished
    // operation as `pending` — a receipt that says an erasure has not started
    // when it has.
    expect(refusalOf(() => readOperationRow(row({ status: "SUPERSEDED" })))).toBe(UNKNOWN_WORK_STATUS);
  });

  test("all five of the enum's labels are readable, so the refusal is not blanket", () => {
    for (const status of ["PENDING", "ACTIVE", "SUCCEEDED", "FAILED", "CANCELLED"]) {
      expect(readOperationRow(row({ status })).workStatus).toBe(status);
      expect(isStorableWorkStatus(status)).toBe(true);
    }
    expect(isStorableWorkStatus("SUPERSEDED")).toBe(false);
  });

  test("a scopes column whose root is not an array is refused", () => {
    expect(refusalOf(() => readOperationRow(row({ scopes: { level: "organization" } })))).toBe(
      UNREADABLE_JSON_ARRAY,
    );
  });

  test("a scope level outside the kernel's three is refused", () => {
    // `resolvePath` switches on `level`, so a stored fourth level would produce a
    // key addressing the wrong subtree with nothing failing.
    expect(
      refusalOf(() => readOperationRow(row({ scopes: [{ level: "entity", organizationId: ORG }] }))),
    ).toBe(UNREADABLE_TENANT_SCOPE);
  });

  test("a scope level outside the kernel's three is refused EVEN WHEN every id it would need is present", () => {
    // THE CASE ABOVE COULD NOT TELL WHICH CLAUSE FIRED, and the mutation sweep
    // said so. `mutations-privacy.json` M-P14 deletes the level check and that
    // case stayed GREEN, because `{ level: "entity", organizationId }` has no
    // `projectId` and the NEXT clause refuses it under the same code. A guard
    // that another guard's refusal covers is a guard nothing is holding.
    //
    // This witness carries every id a scope of any level could want, so the
    // level check is the only thing left that can refuse it.
    expect(
      refusalOf(() =>
        readOperationRow(
          row({
            scopes: [{ level: "entity", organizationId: ORG, projectId: "p", environmentId: "e" }],
          }),
        ),
      ),
    ).toBe(UNREADABLE_TENANT_SCOPE);
  });

  test("a project scope with no projectId is refused, and so is an environment scope with no environmentId", () => {
    expect(
      refusalOf(() => readOperationRow(row({ scopes: [{ level: "project", organizationId: ORG }] }))),
    ).toBe(UNREADABLE_TENANT_SCOPE);
    expect(
      refusalOf(() =>
        readOperationRow(
          row({ scopes: [{ level: "environment", organizationId: ORG, projectId: "p" }] }),
        ),
      ),
    ).toBe(UNREADABLE_TENANT_SCOPE);
  });

  test("a stores element with no target name is refused", () => {
    // `mergeOutcomes` and `targetsNeedingRetry` both KEY on `target`, so an
    // outcome without one silently collapses into whichever other outcome shares
    // its `undefined`.
    expect(refusalOf(() => readOperationRow(row({ stores: [{ status: "done" }] })))).toBe(
      UNREADABLE_TARGET_OUTCOME,
    );
    expect(refusalOf(() => readOperationRow(row({ stores: [{ target: "" }] })))).toBe(
      UNREADABLE_TARGET_OUTCOME,
    );
  });

  test("an outcome VOCABULARY this binary has not heard of is READ, deliberately", () => {
    // The counterpart to the refusals above, and the reason `privacy-rows.ts`
    // checks only `target` on an outcome. `deriveStatus` treats an unrecognised
    // status as not settled, which keeps the operation OPEN — the safe direction —
    // so refusing the row would turn a readable receipt into an outage for no
    // gain. The status columns are different: a wrong reading there says an
    // erasure finished.
    const read = readOperationRow(row({ stores: [{ target: "files", status: "quarantined" }] }));
    expect(read.outcomes[0]?.target).toBe("files");
  });
});

describe("reading an ErasureTombstone row", () => {
  test("a well-formed row round-trips, carrying the operation that sealed it", () => {
    const read = readTombstoneRow(tombstoneRow());
    expect(read.tombstoneId).toBe(TOMBSTONE);
    expect(read.aliasHash).toBe("a-external");
    expect(read.operationId).toBe(OPERATION);
    expect(read.expiresAt.toISOString()).toBe("2026-06-01T09:00:00.000Z");
  });

  test("an operationId naming no operation is READ, because the schema permits it", () => {
    // REPORTED RATHER THAN GUARDED. `ErasureTombstone.operationId` is `@db.Uuid`
    // with NO foreign key to `ErasureOperation` — the only reference either of
    // this context's tables carries that the database does not enforce. The
    // port's own comment calls it "the operation that sealed it, so a barrier can
    // be traced to its cause", and that trace is a convention here rather than a
    // constraint. A read that refused an unresolvable one would be inventing an
    // integrity rule the schema does not have.
    const read = readTombstoneRow(tombstoneRow({ operationId: "bbbbbbbb-9999-4000-8000-000000009999" }));
    expect(read.operationId).toBe("bbbbbbbb-9999-4000-8000-000000009999");
  });
});

describe("what the schema will not hold, refused before any statement", () => {
  test("the id the context's own fixtures mint is refused for a @db.Uuid column", () => {
    // `SequenceIdGenerator` mints `id-0001` and `TEST_ORGANIZATION` is `org-1`.
    // Both are accepted by `InMemoryPrivacyRepository`, both are refused by
    // PostgreSQL, and every use-case suite in the context passes with them.
    expect(refusalOf(() => guardStorableOperation(operation({ operationId: "id-0001" as never })))).toBe(
      PRIVACY_IDENTIFIER_NOT_UUID,
    );
    expect(refusalOf(() => guardStorableOperation(operation({ organizationId: "org-1" as never })))).toBe(
      PRIVACY_IDENTIFIER_NOT_UUID,
    );
  });

  test("a scope whose organizationId is not a uuid is refused, though it is JSON", () => {
    // `scopes` is a JSONB column, so PostgreSQL would store this happily — and
    // then `resolvePath` would produce a key naming an organization that cannot
    // exist. The guard is about the VALUE being a tenant reference, not about the
    // column's type.
    expect(
      refusalOf(() =>
        guardStorableOperation(operation({ scopes: [organizationScope("org-1" as never)] })),
      ),
    ).toBe(PRIVACY_IDENTIFIER_NOT_UUID);
  });

  test("a scopes or stores value whose root is not an array is refused, per CHECK", () => {
    expect(refusalOf(() => guardStorableOperation(operation({ scopes: {} as never })))).toBe(
      PRIVACY_SCOPES_NOT_ARRAY,
    );
    expect(refusalOf(() => guardStorableOperation(operation({ outcomes: {} as never })))).toBe(
      PRIVACY_OUTCOMES_NOT_ARRAY,
    );
  });

  test("a workStatus outside the enum's five labels is refused", () => {
    expect(refusalOf(() => guardStorableOperation(operation({ workStatus: "SUPERSEDED" as never })))).toBe(
      PRIVACY_WORK_STATUS_UNKNOWN,
    );
  });

  test("a retryCount that is not a non-negative int32 is refused", () => {
    for (const retryCount of [-1, 1.5, 2_147_483_648, Number.NaN]) {
      expect(refusalOf(() => guardStorableOperation(operation({ retryCount })))).toBe(
        PRIVACY_RETRY_COUNT_INVALID,
      );
    }
    expect(refusalOf(() => guardStorableOperation(operation({ retryCount: 0 })))).toBe(
      "<nothing was refused>",
    );
  });

  test("an Invalid Date is refused on every instant column", () => {
    // `backoffMs` caps its exponent precisely so `nextRetryAt` never becomes one
    // — `2 ** 1024` is `Infinity` and `Infinity * 0` is `NaN`. This guard is what
    // keeps that domain rule from being silently discarded by a caller that did
    // not go through it.
    const invalid = new Date(Number.NaN);
    expect(refusalOf(() => guardStorableOperation(operation({ requestedAt: invalid })))).toBe(
      PRIVACY_INSTANT_NOT_REPRESENTABLE,
    );
    expect(refusalOf(() => guardStorableOperation(operation({ nextRetryAt: invalid })))).toBe(
      PRIVACY_INSTANT_NOT_REPRESENTABLE,
    );
    expect(refusalOf(() => guardStorableOperation(operation({ startedAt: invalid })))).toBe(
      PRIVACY_INSTANT_NOT_REPRESENTABLE,
    );
    expect(refusalOf(() => guardStorableOperation(operation({ completedAt: invalid })))).toBe(
      PRIVACY_INSTANT_NOT_REPRESENTABLE,
    );
  });

  test("half a lease is refused in both directions", () => {
    // Neither column is NOT NULL, so the database holds either half happily. A
    // token with no expiry can never be reclaimed by `claimLease`'s free-lease
    // predicate; an expiry with no token names no holder.
    expect(
      refusalOf(() => guardStorableOperation(operation({ leaseToken: "lease-1" as never }))),
    ).toBe(PRIVACY_LEASE_INCOHERENT);
    expect(refusalOf(() => guardStorableOperation(operation({ leaseExpiresAt: AT })))).toBe(
      PRIVACY_LEASE_INCOHERENT,
    );
    expect(
      refusalOf(() =>
        guardStorableOperation(operation({ leaseToken: "lease-1" as never, leaseExpiresAt: AT })),
      ),
    ).toBe("<nothing was refused>");
  });

  test("the progress guard does NOT demand the identity columns", () => {
    // `updateProgress` writes only the progress half — the port makes the
    // identity columns unwritable by construction — so a guard that asked for
    // them would be demanding values a caller is deliberately not allowed to
    // supply. `guardOperationProgress` is what `updateProgress` and `claimLease`
    // run, and it accepts a value with no id on it at all.
    expect(
      refusalOf(() =>
        guardOperationProgress({
          workStatus: "ACTIVE",
          outcomes: [],
          retryCount: 0,
          startedAt: null,
          completedAt: null,
          nextRetryAt: null,
          leaseToken: null,
          leaseExpiresAt: null,
        }),
      ),
    ).toBe("<nothing was refused>");
  });

  test("a negative page limit is REFUSED rather than clamped", () => {
    // The double clamps with `Math.max(0, limit)`. Prisma REVERSES the order on a
    // negative `take` and returns rows, so a clamped-in-the-double queue would
    // re-drive the furthest FUTURE operations first with nothing failing.
    expect(refusalOf(() => requirePageLimit(-1))).toBe(PRIVACY_PAGE_LIMIT_INVALID);
    expect(refusalOf(() => requirePageLimit(1.5))).toBe(PRIVACY_PAGE_LIMIT_INVALID);
    expect(refusalOf(() => requirePageLimit(0))).toBe("<nothing was refused>");
  });
});

describe("what one seal will not hold", () => {
  test("a batch spanning two organizations is refused", () => {
    // Unreachable from `draftTombstones`, which builds every draft from one
    // organization — and the one shape that would make this store's scoped
    // read-then-split unsound, because the read is scoped to the FIRST draft's
    // organization and would then classify the others as missing.
    const other = "bbbbbbbb-0004-4000-8000-000000000004";
    expect(
      refusalOf(() =>
        guardSealBatch([draft(), draft({ organizationId: other as never })], [TOMBSTONE, TOMBSTONE]),
      ),
    ).toBe(PRIVACY_SEAL_SPANS_TENANTS);
  });

  test("a retention window that ends before it begins is refused", () => {
    expect(
      refusalOf(() =>
        guardSealBatch([draft({ expiresAt: new Date(AT.getTime() - 1) })], [TOMBSTONE]),
      ),
    ).toBe(PRIVACY_TOMBSTONE_WINDOW_INVERTED);
    // Exactly equal is permitted: a zero-length window is a tombstone that has
    // already lapsed, which `findActiveTombstones` refuses to return and
    // `purgeExpiredTombstones` collects. It is pointless, not malformed.
    expect(refusalOf(() => guardSealBatch([draft({ expiresAt: AT })], [TOMBSTONE]))).toBe(
      "<nothing was refused>",
    );
  });

  test("fewer minted ids than drafts is refused rather than silently dropping a row", () => {
    // `InMemoryPrivacyRepository` `continue`s past a draft with no id, so an
    // alias goes UNSEALED and the reported `sealed` count is short with no error
    // — which on this port means the barrier has a hole in it exactly where the
    // caller thinks it does not.
    expect(refusalOf(() => guardSealBatch([draft(), draft({ aliasHash: "a-2" as never })], [TOMBSTONE]))).toBe(
      PRIVACY_SEAL_IDS_MISSING,
    );
  });

  test("a malformed tombstone id or operationId is refused", () => {
    expect(refusalOf(() => guardSealBatch([draft()], ["tomb-1"]))).toBe(PRIVACY_IDENTIFIER_NOT_UUID);
    expect(
      refusalOf(() => guardSealBatch([draft({ operationId: "id-0001" as never })], [TOMBSTONE])),
    ).toBe(PRIVACY_IDENTIFIER_NOT_UUID);
  });

  test("a well-formed batch returns the organization every draft shares", () => {
    expect(guardSealBatch([draft(), draft({ aliasHash: "a-2" as never })], [TOMBSTONE, TOMBSTONE])).toBe(
      ORG,
    );
  });
});
