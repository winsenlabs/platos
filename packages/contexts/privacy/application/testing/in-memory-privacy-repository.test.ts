// The doubles are only useful if they hold the constraints the schema holds.
// These cases pin exactly the behaviours a use-case test would otherwise be
// proving against a permissive fake.

import { asIdentifier, organizationScope, type OrganizationId, type TransactionScope } from "@platos/kernel";
import { beforeEach, describe, expect, it } from "vitest";

import type {
  AliasHash,
  ErasureOperationId,
  ErasureTombstoneId,
  IdempotencyKey,
  LeaseToken,
  PersistedErasureOperation,
  SubjectKeyHash,
  TombstoneDraft,
} from "../../domain/index.js";
import { InMemoryPrivacyRepository } from "./in-memory-privacy-repository.js";
import { TEST_ORGANIZATION } from "./fixtures.js";

const TRANSACTION: TransactionScope = { transactionId: asIdentifier("txn-1") };
const NOW = new Date("2026-01-01T00:00:00.000Z");

function operation(overrides: Partial<PersistedErasureOperation> = {}): PersistedErasureOperation {
  return {
    operationId: asIdentifier<ErasureOperationId>("op-1"),
    organizationId: TEST_ORGANIZATION,
    idempotencyKey: asIdentifier<IdempotencyKey>("key-1"),
    subjectKeyHash: asIdentifier<SubjectKeyHash>("d0000001"),
    workStatus: "PENDING",
    scopes: [organizationScope(TEST_ORGANIZATION)],
    outcomes: [],
    policyVersion: "v",
    legalHoldPolicyId: null,
    retryCount: 0,
    requestedAt: NOW,
    startedAt: null,
    completedAt: null,
    nextRetryAt: NOW,
    leaseToken: null,
    leaseExpiresAt: null,
    ...overrides,
  };
}

function draft(aliasHash: string, expiresAt: Date): TombstoneDraft {
  return {
    organizationId: TEST_ORGANIZATION,
    aliasHash: asIdentifier<AliasHash>(aliasHash),
    operationId: asIdentifier<ErasureOperationId>("op-1"),
    policyVersion: "v",
    sealedAt: NOW,
    expiresAt,
  };
}

describe("the in-memory operation store", () => {
  let repository: InMemoryPrivacyRepository;

  beforeEach(() => {
    repository = new InMemoryPrivacyRepository();
  });

  it("upholds the (organization, idempotencyKey) unique", async () => {
    await repository.insertOperation(operation(), TRANSACTION);
    const raced = await repository.insertOperation(
      operation({ operationId: asIdentifier<ErasureOperationId>("op-2") }),
      TRANSACTION,
    );
    expect(raced.ok).toBe(false);
    if (raced.ok) throw new Error("unreachable");
    expect(raced.error.code).toBe("PRIVACY_IDEMPOTENCY_KEY_CONFLICT");
  });

  it("lets the same key be reused in a DIFFERENT organization", async () => {
    await repository.insertOperation(operation(), TRANSACTION);
    const other = await repository.insertOperation(
      operation({
        operationId: asIdentifier<ErasureOperationId>("op-2"),
        organizationId: asIdentifier<OrganizationId>("org-2"),
      }),
      TRANSACTION,
    );
    expect(other.ok).toBe(true);
  });

  it("does not return another organization's row", async () => {
    await repository.insertOperation(operation(), TRANSACTION);
    const found = await repository.findOperation(asIdentifier<OrganizationId>("org-2"), asIdentifier<ErasureOperationId>("op-1"));
    if (!found.ok) throw new Error("unreachable");
    expect(found.value).toBeNull();
  });

  it("refuses to let a progress write rewrite the identity columns", async () => {
    await repository.insertOperation(operation(), TRANSACTION);
    const written = await repository.updateProgress(
      TEST_ORGANIZATION,
      asIdentifier<ErasureOperationId>("op-1"),
      {
        workStatus: "SUCCEEDED",
        outcomes: [],
        legalHoldPolicyId: null,
        retryCount: 1,
        startedAt: NOW,
        completedAt: NOW,
        nextRetryAt: null,
        leaseToken: null,
        leaseExpiresAt: null,
      },
      TRANSACTION,
    );
    if (!written.ok) throw new Error("unreachable");
    expect(written.value.subjectKeyHash).toBe("d0000001");
    expect(written.value.requestedAt).toEqual(NOW);
    expect(written.value.workStatus).toBe("SUCCEEDED");
  });

  it("claims a free lease and then refuses the next claimant", async () => {
    await repository.insertOperation(operation(), TRANSACTION);
    const lease = { token: asIdentifier<LeaseToken>("lease-1"), expiresAt: new Date(NOW.getTime() + 60_000) };
    const first = await repository.claimLease(TEST_ORGANIZATION, asIdentifier<ErasureOperationId>("op-1"), lease, NOW, TRANSACTION);
    const second = await repository.claimLease(TEST_ORGANIZATION, asIdentifier<ErasureOperationId>("op-1"), lease, NOW, TRANSACTION);
    if (!first.ok || !second.ok) throw new Error("unreachable");
    expect(first.value).toBe(true);
    expect(second.value).toBe(false);
  });

  it("hands an expired lease to the next claimant", async () => {
    await repository.insertOperation(
      operation({ leaseExpiresAt: new Date(NOW.getTime() - 1), leaseToken: asIdentifier<LeaseToken>("stale") }),
      TRANSACTION,
    );
    const claimed = await repository.claimLease(
      TEST_ORGANIZATION,
      asIdentifier<ErasureOperationId>("op-1"),
      { token: asIdentifier<LeaseToken>("lease-2"), expiresAt: new Date(NOW.getTime() + 60_000) },
      NOW,
      TRANSACTION,
    );
    if (!claimed.ok) throw new Error("unreachable");
    expect(claimed.value).toBe(true);
  });

  it("lists due operations oldest first", async () => {
    await repository.insertOperation(
      operation({ operationId: asIdentifier<ErasureOperationId>("op-late"), idempotencyKey: asIdentifier<IdempotencyKey>("k2"), nextRetryAt: new Date(NOW.getTime() + 10) }),
      TRANSACTION,
    );
    await repository.insertOperation(operation(), TRANSACTION);
    const due = await repository.listDueOperations(new Date(NOW.getTime() + 100), 10);
    if (!due.ok) throw new Error("unreachable");
    expect(due.value.map((row) => row.operationId)).toEqual(["op-1", "op-late"]);
  });

  it("does not list an operation that is not due", async () => {
    await repository.insertOperation(operation({ nextRetryAt: null }), TRANSACTION);
    const due = await repository.listDueOperations(NOW, 10);
    if (!due.ok) throw new Error("unreachable");
    expect(due.value).toEqual([]);
  });
});

describe("the in-memory tombstone register", () => {
  let repository: InMemoryPrivacyRepository;
  const future = new Date(NOW.getTime() + 60_000);

  beforeEach(() => {
    repository = new InMemoryPrivacyRepository();
  });

  it("upholds the (organization, aliasHash) unique by EXTENDING, not duplicating", async () => {
    await repository.sealTombstones([draft("h1", future)], [asIdentifier<ErasureTombstoneId>("t-1")], TRANSACTION);
    const again = await repository.sealTombstones(
      [draft("h1", new Date(future.getTime() + 60_000))],
      [asIdentifier<ErasureTombstoneId>("t-2")],
      TRANSACTION,
    );
    if (!again.ok) throw new Error("unreachable");
    expect(again.value).toEqual({ sealed: 0, extended: 1 });
    expect(repository.allTombstones()).toHaveLength(1);
    expect(repository.allTombstones()[0]?.tombstoneId).toBe("t-1");
  });

  it("applies read-time expiry, so a lapsed row is invisible before it is purged", async () => {
    await repository.sealTombstones([draft("h1", future)], [asIdentifier<ErasureTombstoneId>("t-1")], TRANSACTION);
    const found = await repository.findActiveTombstones(
      TEST_ORGANIZATION,
      [asIdentifier<AliasHash>("h1")],
      new Date(future.getTime() + 1),
    );
    if (!found.ok) throw new Error("unreachable");
    expect(found.value).toEqual([]);
    expect(repository.allTombstones()).toHaveLength(1);
  });

  it("does not match a digest sealed in another organization", async () => {
    await repository.sealTombstones([draft("h1", future)], [asIdentifier<ErasureTombstoneId>("t-1")], TRANSACTION);
    const found = await repository.findActiveTombstones(
      asIdentifier<OrganizationId>("org-2"),
      [asIdentifier<AliasHash>("h1")],
      NOW,
    );
    if (!found.ok) throw new Error("unreachable");
    expect(found.value).toEqual([]);
  });

  it("purges exactly the elapsed rows", async () => {
    await repository.sealTombstones(
      [draft("h1", future), draft("h2", new Date(NOW.getTime() - 1))],
      [asIdentifier<ErasureTombstoneId>("t-1"), asIdentifier<ErasureTombstoneId>("t-2")],
      TRANSACTION,
    );
    const purged = await repository.purgeExpiredTombstones(NOW, TRANSACTION);
    if (!purged.ok) throw new Error("unreachable");
    expect(purged.value).toBe(1);
    expect(repository.allTombstones().map((row) => row.aliasHash)).toEqual(["h1"]);
  });
});
