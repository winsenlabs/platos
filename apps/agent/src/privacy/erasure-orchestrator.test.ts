import { describe, it, expect } from "vitest";
import { runErasure, retryErasure, EXECUTION_ORDER, type StoreExecutors } from "./erasure-orchestrator";
import { pendingStore, type ErasureReceipt, type StoreOutcome, type StoreName } from "./erasure-receipt";
import type { SubjectKeys } from "./subject-graph";

const subject: SubjectKeys = {
  platosEndUserIds: ["eu1"], legacyUserIds: ["u1"],
  scopes: [{ organizationId: "o", projectId: "p", environmentId: "e" }],
};

const ok = (store: StoreName, deleted = 1): StoreOutcome =>
  ({ ...pendingStore(store), status: "done", verificationStatus: "passed", deleted });

const receipt = (over: Partial<ErasureReceipt> = {}): ErasureReceipt => ({
  operationId: "op1", subjectKeyHash: "h", requestedAt: "t0", status: "pending",
  scopes: [], stores: [], policyVersion: "v1", attempts: 0, ...over,
});

const allOk = (): StoreExecutors => Object.fromEntries(
  EXECUTION_ORDER.map((s) => [s, async () => ok(s)])) as StoreExecutors;

describe("ordering is not arbitrary", () => {
  it("runs MinIO BEFORE Postgres", async () => {
    // Object keys are discovered from attachment metadata; deleting the rows
    // first destroys the only map to the bytes.
    const seen: string[] = [];
    const ex = Object.fromEntries(EXECUTION_ORDER.map((s) => [s,
      async () => { seen.push(s); return ok(s); }])) as StoreExecutors;
    await runErasure(receipt(), subject, ex);
    expect(seen.indexOf("minio")).toBeLessThan(seen.indexOf("postgres"));
  });

  it("runs Postgres last — it holds the identifiers everything else uses", async () => {
    const seen: string[] = [];
    const ex = Object.fromEntries(EXECUTION_ORDER.map((s) => [s,
      async () => { seen.push(s); return ok(s); }])) as StoreExecutors;
    await runErasure(receipt(), subject, ex);
    expect(seen.at(-1)).toBe("postgres");
  });
});

describe("failure semantics", () => {
  it("one store throwing does not stop the others", async () => {
    // A crash in Redis that prevented Postgres running would leave far more
    // personal data in place than it protected.
    const seen: string[] = [];
    const ex: StoreExecutors = {
      minio: async () => { seen.push("minio"); return ok("minio"); },
      redis: async () => { throw new TypeError("boom"); },
      clickhouse: async () => { seen.push("clickhouse"); return ok("clickhouse"); },
      postgres: async () => { seen.push("postgres"); return ok("postgres"); },
    };
    const r = await runErasure(receipt(), subject, ex);
    expect(seen).toContain("postgres");
    expect(r.status).toBe("partial_failure");
  });

  it("a thrown executor is unknown, NOT failed verification", async () => {
    // Failed verification means "we deleted and it is still there" — positive
    // evidence. A crash proves nothing either way and must not claim as much.
    const r = await runErasure(receipt(), subject, {
      ...allOk(), redis: async () => { throw new Error("net"); },
    });
    const redis = r.stores.find((s) => s.store === "redis")!;
    expect(redis.status).toBe("failed");
    expect(redis.verificationStatus).toBe("unknown");
  });

  it("records only the error CLASS, never the message", async () => {
    // Error messages routinely embed the identifiers being erased.
    const r = await runErasure(receipt(), subject, {
      ...allOk(), redis: async () => { throw new Error("failed for user@example.com"); },
    });
    const note = r.stores.find((s) => s.store === "redis")!.note ?? "";
    expect(note).not.toContain("user@example.com");
    expect(note).toContain("Error");
  });

  it("never rolls back a store that succeeded", async () => {
    const r = await runErasure(receipt(), subject, {
      ...allOk(), postgres: async () => ({ ...pendingStore("postgres"), status: "failed", failures: 1 }),
    });
    // MinIO stays deleted. Restoring it for a tidy status would recreate data
    // the subject asked to have destroyed.
    expect(r.stores.find((s) => s.store === "minio")!.deleted).toBe(1);
    expect(r.status).toBe("partial_failure");
  });

  it("an unimplemented store is failed, not clean", async () => {
    const r = await runErasure(receipt(), subject, { postgres: async () => ok("postgres") });
    expect(r.status).toBe("partial_failure");
    expect(r.stores.find((s) => s.store === "redis")!.note).toContain("no executor");
  });
});

describe("discovery finding nothing is not success", () => {
  it("refuses to complete when the subject resolved to no keys", async () => {
    // Usually means the subject was resolved by the wrong key — the exact
    // defect this work exists to fix. "completed, 0 deleted" would certify an
    // erasure that never looked in the right place.
    const r = await runErasure(receipt(),
      { platosEndUserIds: [], legacyUserIds: [], scopes: [] }, allOk());
    expect(r.status).toBe("verification_failed");
  });
});

describe("legal hold", () => {
  it("blocks before any store runs", async () => {
    let ran = false;
    const r = await runErasure(receipt(), subject,
      { ...allOk(), postgres: async () => { ran = true; return ok("postgres"); } },
      { legalHold: { policyId: "LH-7" } });
    expect(ran).toBe(false);
    expect(r.status).toBe("blocked_legal_hold");
    expect(r.legalHoldPolicyId).toBe("LH-7");
  });
});

describe("retry", () => {
  it("re-runs only unsettled stores", async () => {
    const start = receipt({ status: "partial_failure", stores: [
      ok("postgres"), ok("minio"), ok("clickhouse"),
      { ...pendingStore("redis"), status: "failed", failures: 1 },
    ]});
    const ran: string[] = [];
    const ex = Object.fromEntries(EXECUTION_ORDER.map((s) => [s,
      async () => { ran.push(s); return ok(s); }])) as StoreExecutors;
    const r = await retryErasure(start, subject, ex);
    expect(ran).toEqual(["redis"]);
    expect(r.status).toBe("completed");
  });

  it("is a no-op when everything already settled", async () => {
    const done = receipt({ status: "completed", stores: EXECUTION_ORDER.map((s) => ok(s)), attempts: 1 });
    const r = await retryErasure(done, subject, allOk());
    expect(r.attempts).toBe(1);
  });

  it("increments attempts so operators can see churn", async () => {
    const r = await runErasure(receipt({ attempts: 2 }), subject, allOk());
    expect(r.attempts).toBe(3);
  });
});

describe("coverage", () => {
  it("refuses to let a narrowed pass certify a legacy-keyed store", async () => {
    // A resume driven from the persisted plan deletes over a narrower WHERE and
    // would then verify over that same narrower WHERE — finding no survivors and
    // reporting a pass it never earned.
    const r = await runErasure(receipt(), subject, allOk(), { coverage: "locators_only" });
    expect(r.stores.find((s) => s.store === "postgres")!.verificationStatus).toBe("unknown");
    // MinIO is addressed only by endUserId, so its verification still stands.
    expect(r.stores.find((s) => s.store === "minio")!.verificationStatus).toBe("passed");
    expect(r.status).toBe("partial_failure");
  });

  it("leaves a full-coverage pass exactly as the executors reported it", async () => {
    const r = await runErasure(receipt(), subject, allOk(), { coverage: "full" });
    expect(r.status).toBe("completed");
  });

  it("does not let a retry soften an earlier verification failure", async () => {
    // "We deleted and it is still there" is evidence. A later pass that comes
    // back unknown has not refuted it, it has failed to gather any.
    const start = receipt({ status: "verification_failed", stores: [
      ...EXECUTION_ORDER.filter((s) => s !== "minio").map((s) => ok(s)),
      { ...pendingStore("minio"), status: "done", verificationStatus: "failed" },
    ]});
    const r = await retryErasure(start, subject, {
      ...allOk(),
      minio: async () => ({ ...pendingStore("minio"), status: "failed", failures: 1,
                            verificationStatus: "unknown" }),
    });
    expect(r.stores.find((s) => s.store === "minio")!.verificationStatus).toBe("failed");
    expect(r.status).toBe("verification_failed");
  });
});

describe("completion", () => {
  it("stamps completedAt only when genuinely complete", async () => {
    const good = await runErasure(receipt(), subject, allOk(), { now: () => "T1" });
    expect(good.status).toBe("completed");
    expect(good.completedAt).toBe("T1");

    const bad = await runErasure(receipt(), subject,
      { ...allOk(), redis: async () => ({ ...pendingStore("redis"), status: "failed", failures: 1 }) });
    expect(bad.completedAt).toBeUndefined();
  });
});
