import { describe, expect, it } from "vitest";
import {
  ERASURE_AUDIT_SUBJECT_TYPE, RETENTION_CLASSES,
  assertAuditContentFree, auditEnvironments, finishedAudit, inventoriedAudit,
  refusedAudit, requestedAudit, storeAuditSummary,
  type ErasureAuditActor,
} from "./erasure-audit";
import { pendingStore, type ErasureReceipt, type StoreOutcome } from "./erasure-receipt";

const actor: ErasureAuditActor = {
  credentialId: "credential_1",
  userId: "operator_7",
  environmentId: "env_credential",
  projectId: "project_credential",
};

const store = (o: Partial<StoreOutcome> & { store: StoreOutcome["store"] }): StoreOutcome =>
  ({ ...pendingStore(o.store), ...o });

const receipt = (over: Partial<ErasureReceipt> = {}): ErasureReceipt => ({
  operationId: "op_1",
  subjectKeyHash: "a".repeat(64),
  requestedAt: "2026-08-20T00:00:00.000Z",
  status: "completed",
  scopes: [{ organizationId: "org_1", projectId: "project_1", environmentId: "env_1" }],
  stores: [
    store({ store: "minio", status: "done", verificationStatus: "passed", deleted: 2 }),
    store({ store: "redis", status: "done", verificationStatus: "passed", deleted: 4, retained: 2 }),
    store({ store: "clickhouse", status: "not_provisioned" }),
    store({ store: "postgres", status: "done", verificationStatus: "passed", anonymized: 3 }),
  ],
  policyVersion: "2026-08-11.1",
  retryCount: 1,
  ...over,
});

describe("every erasure action names who did it", () => {
  it("records the intent before anything is destroyed", () => {
    const entry = requestedAudit({
      operationId: "op_1",
      subjectKeyHash: "a".repeat(64),
      policyVersion: "v1",
      cause: "request",
      coverage: "full",
      actor,
      inventory: { resolved: 1, threads: 4 },
      stores: ["minio", "redis", "clickhouse", "postgres"],
      retryCount: 0,
    });

    expect(entry.action).toBe("privacy.erasure.requested");
    expect(entry.subjectType).toBe(ERASURE_AUDIT_SUBJECT_TYPE);
    expect(entry.payload).toMatchObject({
      actor: { credentialId: "credential_1", userId: "operator_7" },
      pass: 1,
      coverage: "full",
      targetStores: ["minio", "redis", "clickhouse", "postgres"],
    });
  });

  it("records the outcome per store, including what was kept and why", () => {
    const entry = finishedAudit({
      receipt: receipt(),
      cause: "request",
      coverage: "full",
      actor,
      nextRetryAt: null,
    });

    expect(entry.payload.status).toBe("completed");
    expect(entry.payload.stores).toEqual(storeAuditSummary(receipt().stores));
    expect(entry.payload.retention).toMatchObject({
      class: RETENTION_CLASSES.evidence,
      retainedIndefinitely: true,
      barrierClass: RETENTION_CLASSES.barrier,
      // The tool-call audits anonymized rather than deleted, and the Redis
      // aggregates retained because they carry no user dimension.
      anonymizedRecords: 3,
      retainedAggregates: 2,
    });
  });

  it("names the retention class on a refusal too", () => {
    const entry = refusedAudit({
      subjectKeyHash: "a".repeat(64),
      reason: "legal hold in force",
      actor,
      operationId: "op_1",
      legalHoldPolicyId: "LH-7",
    });

    expect(entry.action).toBe("privacy.erasure.refused");
    expect(entry.payload).toMatchObject({
      refusal: "legal hold in force",
      legalHoldPolicyId: "LH-7",
      retention: { class: RETENTION_CLASSES.evidence },
    });
  });

  it("records that a subject's footprint was merely read", () => {
    const entry = inventoriedAudit({
      subjectKeyHash: "a".repeat(64),
      policyVersion: "v1",
      actor,
      inventory: { resolved: 1, threads: 4 },
      resolvedEndUsers: 1,
    });

    expect(entry.action).toBe("privacy.erasure.inventoried");
    expect(entry.payload.inventory).toEqual({ resolved: 1, threads: 4 });
  });

  it("carries the queue's next retry so churn is visible in the log", () => {
    const entry = finishedAudit({
      receipt: receipt({ status: "partial_failure", retryCount: 2 }),
      cause: "queue-resume",
      coverage: "locators_only",
      actor,
      nextRetryAt: new Date("2026-08-20T00:02:00.000Z"),
    });

    expect(entry.payload).toMatchObject({
      cause: "queue-resume",
      coverage: "locators_only",
      pass: 2,
      nextRetryAt: "2026-08-20T00:02:00.000Z",
    });
  });
});

describe("the audit trail must not recreate the data it documents", () => {
  it("refuses an entry containing a subject identifier", () => {
    const leaky = finishedAudit({
      receipt: receipt({
        stores: [
          store({
            store: "postgres", status: "done", verificationStatus: "passed",
            note: "purged rows for walle-77",
          }),
        ],
      }),
      cause: "request",
      coverage: "full",
      actor,
      nextRetryAt: null,
    });

    expect(() => assertAuditContentFree(leaky, ["walle-77"]))
      .toThrow(/would leak a subject identifier/);
  });

  it("scans the whole entry, not a chosen subset of it", () => {
    // The receipt guard checks only store notes because a receipt is assembled
    // in one place. An audit payload is assembled from an inventory, an actor
    // and a set of outcomes, and the leak arrives through whichever a later
    // change touches.
    const leaky = refusedAudit({
      subjectKeyHash: "a".repeat(64),
      reason: "idempotency key already bound to walle-77",
      actor,
    });
    expect(() => assertAuditContentFree(leaky, ["walle-77"])).toThrow();
  });

  it("keeps only numeric inventory fields, dropping the scope tuples", () => {
    const entry = inventoriedAudit({
      subjectKeyHash: "a".repeat(64),
      policyVersion: "v1",
      actor,
      inventory: {
        resolved: 2,
        threads: 1,
        scopes: [{ organizationId: "org_1", projectId: "project_1", environmentId: "env_1" }],
      },
      resolvedEndUsers: 1,
    });
    expect(entry.payload.inventory).toEqual({ resolved: 2, threads: 1 });
  });

  it("identifies the subject only by the salted hash", () => {
    const entry = requestedAudit({
      operationId: "op_1",
      subjectKeyHash: "a".repeat(64),
      policyVersion: "v1",
      cause: "request",
      coverage: "full",
      actor,
      stores: ["postgres"],
      retryCount: 0,
    });
    expect(entry.subjectId).toBe("a".repeat(64));
    expect(() => assertAuditContentFree(entry, ["walle-77", "alice@example.com"])).not.toThrow();
  });

  it("ignores empty needles rather than matching everything", () => {
    const entry = refusedAudit({ subjectKeyHash: "h", reason: "no", actor });
    expect(() => assertAuditContentFree(entry, ["", ""])).not.toThrow();
  });
});

describe("an erasure lands in the admin log of every environment it touched", () => {
  it("writes one row per environment the subject appeared in", () => {
    expect(
      auditEnvironments(
        [{ environmentId: "env_2" }, { environmentId: "env_1" }, { environmentId: "env_1" }],
        "env_credential",
      ),
    ).toEqual(["env_1", "env_2"]);
  });

  it("falls back to the acting credential when the subject resolved nowhere", () => {
    // The entries with no subject scopes are precisely the ones worth keeping:
    // an erasure that resolved nobody, or a refusal that never reached
    // discovery. AdminAudit demands a non-null environment for both.
    expect(auditEnvironments([], "env_credential")).toEqual(["env_credential"]);
  });

  it("returns nothing rather than inventing an environment", () => {
    expect(auditEnvironments([], null)).toEqual([]);
  });
});
