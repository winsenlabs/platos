import { describe, it, expect } from "vitest";
import {
  deriveStatus, isStoreSettled, isUnproven, canRetry, storesNeedingRetry,
  pendingStore, assertContentFree, REQUIRED_STORES,
  type StoreOutcome, type ErasureReceipt,
} from "./erasure-receipt";

const store = (o: Partial<StoreOutcome> & { store: StoreOutcome["store"] }): StoreOutcome =>
  ({ ...pendingStore(o.store), ...o });

const allGood = REQUIRED_STORES.map((s) =>
  store({ store: s, status: "done", verificationStatus: "passed", deleted: 3 }));

const receipt = (over: Partial<ErasureReceipt> = {}): ErasureReceipt => ({
  operationId: "op1", subjectKeyHash: "abc", requestedAt: "t", status: "running",
  scopes: [], stores: allGood, policyVersion: "v1", attempts: 1, ...over,
});

describe("unknown is never success", () => {
  it("a done store with no verification keeps the operation open", () => {
    const s = [...allGood.slice(1), store({ store: "postgres", status: "done", verificationStatus: "unknown" })];
    expect(deriveStatus(s, { started: true })).toBe("partial_failure");
  });

  it("an in-flight mutation is not completion", () => {
    // A ClickHouse mutation still running cannot support a legal statement.
    const s = [...allGood.slice(1), store({ store: "clickhouse", status: "done", verificationStatus: "pending" })];
    expect(deriveStatus(s, { started: true })).toBe("partial_failure");
    expect(isUnproven(s.at(-1)!)).toBe(true);
  });

  it("verification that FAILED outranks a plain failure", () => {
    // Deleted-but-still-there is worse than never-deleted, and must be visible.
    const s = [
      store({ store: "postgres", status: "done", verificationStatus: "failed" }),
      store({ store: "redis", status: "failed", failures: 1 }),
      ...allGood.slice(2),
    ];
    expect(deriveStatus(s, { started: true })).toBe("verification_failed");
  });

  it("completes only when every required store is settled", () => {
    expect(deriveStatus(allGood, { started: true })).toBe("completed");
  });

  it("is running until every required store has reported", () => {
    expect(deriveStatus(allGood.slice(0, 2), { started: true })).toBe("running");
  });

  it("is pending before it starts", () => {
    expect(deriveStatus(allGood, { started: false })).toBe("pending");
  });
});

describe("not_provisioned is settled but not verified", () => {
  it("does not block completion", () => {
    // Measured: ClickHouse has zero user tables on this deployment.
    const s = [...allGood.slice(1), store({ store: "clickhouse", status: "not_provisioned" })];
    expect(deriveStatus(s, { started: true })).toBe("completed");
  });

  it("is reported distinctly so it can never read as verified", () => {
    const s = store({ store: "clickhouse", status: "not_provisioned" });
    expect(isStoreSettled(s)).toBe(true);
    expect(s.verificationStatus).not.toBe("passed");
  });
});

describe("legal hold", () => {
  it("outranks every other signal", () => {
    const bad = [store({ store: "postgres", status: "failed", failures: 9 }), ...allGood.slice(1)];
    expect(deriveStatus(bad, { started: true, legalHold: true })).toBe("blocked_legal_hold");
  });

  it("blocks retry until released", () => {
    const r = canRetry(receipt({ status: "blocked_legal_hold" }));
    expect(r.allowed).toBe(false);
    expect(r.reason).toContain("legal hold");
  });
});

describe("retry semantics", () => {
  it("re-runs only the stores that did not settle", () => {
    const r = receipt({ status: "partial_failure", stores: [
      store({ store: "postgres", status: "done", verificationStatus: "passed" }),
      store({ store: "redis", status: "failed", failures: 1 }),
      store({ store: "clickhouse", status: "done", verificationStatus: "unknown" }),
      store({ store: "minio", status: "not_provisioned" }),
    ]});
    // postgres settled, minio absent -> untouched. redis failed, clickhouse unproven -> retry.
    expect(storesNeedingRetry(r)).toEqual(["redis", "clickhouse"]);
  });

  it("treats a missing store record as needing a retry", () => {
    expect(storesNeedingRetry(receipt({ stores: [] }))).toEqual(REQUIRED_STORES);
  });

  it("refuses to retry a completed operation", () => {
    expect(canRetry(receipt({ status: "completed" })).allowed).toBe(false);
  });

  it("never asks a settled store to delete again", () => {
    // Re-reporting fresh "deleted" counts for work finished an hour ago
    // misleads whoever reads the receipt.
    const r = receipt({ status: "partial_failure" });
    expect(storesNeedingRetry(r)).toEqual([]);
  });
});

describe("receipts must not recreate the personal data", () => {
  it("refuses to persist a receipt containing a subject identifier", () => {
    const leaky = receipt({ stores: [
      store({ store: "postgres", status: "done", verificationStatus: "passed",
              note: "purged rows for user@example.com" }),
      ...allGood.slice(1),
    ]});
    expect(() => assertContentFree(leaky, ["user@example.com"]))
      .toThrow(/would leak a subject identifier/);
  });

  it("permits content-free operational notes", () => {
    const ok = receipt({ stores: [
      store({ store: "clickhouse", status: "done", verificationStatus: "passed",
              note: "mutation_id=0123 status=done; 0 identifying rows remain" }),
      ...allGood.slice(1),
    ]});
    expect(() => assertContentFree(ok, ["user@example.com"])).not.toThrow();
  });

  it("ignores empty needles rather than matching everything", () => {
    expect(() => assertContentFree(receipt(), ["", ""])).not.toThrow();
  });
});
