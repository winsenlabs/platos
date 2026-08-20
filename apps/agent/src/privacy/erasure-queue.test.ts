import { afterEach, describe, expect, it } from "vitest";
import {
  BASE_BACKOFF_MS, DEFAULT_MAX_ATTEMPTS, LEASE_TTL_MS, MAX_BACKOFF_MS,
  backoffMs, buildResumePlan, demoteForCoverage, isExhausted, isLeaseFree,
  leaseUntil, maxAttempts, objectMapLost, preserveVerificationFailure,
  resumePlanFrom, scheduleAfterAttempt, subjectFromResumePlan,
} from "./erasure-queue";
import { pendingStore, type ErasureReceipt, type StoreOutcome } from "./erasure-receipt";
import type { SubjectKeys } from "./subject-graph";

const store = (o: Partial<StoreOutcome> & { store: StoreOutcome["store"] }): StoreOutcome =>
  ({ ...pendingStore(o.store), ...o });

const receipt = (over: Partial<ErasureReceipt> = {}): ErasureReceipt => ({
  operationId: "op1", subjectKeyHash: "h", requestedAt: "t0", status: "partial_failure",
  scopes: [], stores: [], policyVersion: "v1", attempts: 1, ...over,
});

const subject: SubjectKeys = {
  platosEndUserIds: ["eu1"],
  legacyUserIds: ["walle-77"],
  scopes: [{ organizationId: "o", projectId: "p", environmentId: "e" }],
};

const T0 = new Date("2026-08-20T00:00:00.000Z");

afterEach(() => {
  delete process.env.PLATOS_ERASURE_MAX_ATTEMPTS;
});

describe("an unsettled store is scheduled, not abandoned", () => {
  it("backs off exponentially and then stops growing", () => {
    expect(backoffMs(1)).toBe(BASE_BACKOFF_MS);
    expect(backoffMs(2)).toBe(BASE_BACKOFF_MS * 2);
    expect(backoffMs(4)).toBe(BASE_BACKOFF_MS * 8);
    expect(backoffMs(99)).toBe(MAX_BACKOFF_MS);
  });

  it("does not overflow into NaN at absurd attempt counts", () => {
    // 2 ** 1024 is Infinity and Infinity * 0 is NaN; a NaN delay would produce
    // an Invalid Date and silently drop the operation out of the queue.
    expect(Number.isFinite(backoffMs(100_000))).toBe(true);
  });

  it("schedules the next attempt for an operation that did not settle", () => {
    const s = scheduleAfterAttempt(receipt({ attempts: 1 }), T0);
    expect(s.reason).toBe("scheduled");
    expect(s.nextAttemptAt?.toISOString()).toBe("2026-08-20T00:01:00.000Z");
  });

  it("stops scheduling once it settles", () => {
    expect(scheduleAfterAttempt(receipt({ status: "completed" }), T0)).toEqual({
      nextAttemptAt: null, reason: "settled",
    });
  });

  it("never re-drives a held operation", () => {
    // Automatically retrying an erasure a legal hold refused would be the queue
    // quietly overriding the hold.
    expect(scheduleAfterAttempt(receipt({ status: "blocked_legal_hold" }), T0)).toEqual({
      nextAttemptAt: null, reason: "blocked",
    });
  });

  it("hands a repeatedly failing operation to an operator rather than churning", () => {
    const s = scheduleAfterAttempt(receipt({ attempts: DEFAULT_MAX_ATTEMPTS }), T0);
    expect(s).toEqual({ nextAttemptAt: null, reason: "exhausted" });
    // Exhausted is not abandoned: the row keeps its receipt and its plan, and
    // the retry route still works.
    expect(isExhausted(DEFAULT_MAX_ATTEMPTS - 1)).toBe(false);
  });

  it("takes the attempt ceiling from the deployment", () => {
    process.env.PLATOS_ERASURE_MAX_ATTEMPTS = "2";
    expect(maxAttempts()).toBe(2);
    process.env.PLATOS_ERASURE_MAX_ATTEMPTS = "nonsense";
    expect(maxAttempts()).toBe(DEFAULT_MAX_ATTEMPTS);
    process.env.PLATOS_ERASURE_MAX_ATTEMPTS = "0";
    expect(maxAttempts()).toBe(DEFAULT_MAX_ATTEMPTS);
  });
});

describe("leases keep two passes off the same subject", () => {
  it("expires rather than pinning an operation whose process died", () => {
    expect(leaseUntil(T0).getTime() - T0.getTime()).toBe(LEASE_TTL_MS);
    expect(isLeaseFree(leaseUntil(T0), T0)).toBe(false);
    expect(isLeaseFree(leaseUntil(T0), new Date(T0.getTime() + LEASE_TTL_MS + 1))).toBe(true);
  });

  it("treats an unheld lease as free", () => {
    expect(isLeaseFree(null, T0)).toBe(true);
    expect(isLeaseFree(undefined, T0)).toBe(true);
  });
});

describe("the resume plan carries locators, never the identifier", () => {
  const plan = buildResumePlan({ subject, threadIds: ["t2", "t1", "t1"], attachmentObjects: 3 });

  it("records what the sweep is about to destroy", () => {
    expect(plan).toEqual({
      version: 1,
      platosEndUserIds: ["eu1"],
      threadIds: ["t1", "t2"],
      scopes: subject.scopes,
      attachmentObjects: 3,
    });
  });

  it("does not carry the external id, in any field", () => {
    // The whole reason the queue cannot certify a legacy-keyed store.
    expect(JSON.stringify(plan)).not.toContain("walle-77");
  });

  it("resumes against a subject with no legacy ids, and says so by omission", () => {
    expect(subjectFromResumePlan(plan)).toEqual({
      platosEndUserIds: ["eu1"],
      legacyUserIds: [],
      scopes: subject.scopes,
    });
  });

  it("coerces at the Json boundary rather than trusting the column", () => {
    // A Json? column can hold a bare string, a null, or an older shape. This is
    // a destructive path: a plan that parsed into undefined fields would sweep
    // against an empty subject.
    expect(resumePlanFrom(null)).toBeNull();
    expect(resumePlanFrom("{}")).toBeNull();
    expect(resumePlanFrom([])).toBeNull();
    expect(resumePlanFrom({ version: 2, platosEndUserIds: ["eu1"] })).toBeNull();
    expect(resumePlanFrom({ version: 1 })).toEqual({
      version: 1, platosEndUserIds: [], threadIds: [], scopes: [], attachmentObjects: 0,
    });
  });

  it("drops junk entries instead of passing them to a delete", () => {
    expect(
      resumePlanFrom({
        version: 1,
        platosEndUserIds: ["eu1", null, 7],
        threadIds: "not-an-array",
        scopes: [{ organizationId: "o" }, subject.scopes[0]],
        attachmentObjects: "12",
      }),
    ).toEqual({
      version: 1,
      platosEndUserIds: ["eu1"],
      threadIds: [],
      scopes: [subject.scopes[0]],
      attachmentObjects: 12,
    });
  });
});

describe("a narrowed pass may delete but may not certify", () => {
  it("demotes a verification the pass was not entitled to make", () => {
    // Postgres resumed without the legacy id deletes over a narrower WHERE and
    // would then VERIFY over that same narrower WHERE, find nothing, and report
    // a pass it never earned.
    const passed = store({ store: "postgres", status: "done", verificationStatus: "passed" });
    const demoted = demoteForCoverage(passed, "locators_only");
    expect(demoted.verificationStatus).toBe("unknown");
    expect(demoted.note).toContain("without the subject id");
  });

  it("leaves a full-coverage pass alone", () => {
    const passed = store({ store: "postgres", status: "done", verificationStatus: "passed" });
    expect(demoteForCoverage(passed, "full")).toBe(passed);
  });

  it("does not demote MinIO, which is not addressed by the legacy id", () => {
    const passed = store({ store: "minio", status: "done", verificationStatus: "passed" });
    expect(demoteForCoverage(passed, "locators_only").verificationStatus).toBe("passed");
  });

  it("keeps a failed verification failed", () => {
    // Narrowing can only miss rows, never invent them, so a survivor found by a
    // narrow pass is a real survivor — and the more serious finding.
    const failed = store({ store: "redis", status: "done", verificationStatus: "failed" });
    expect(demoteForCoverage(failed, "locators_only").verificationStatus).toBe("failed");
  });
});

describe("a retry may not soften an earlier verification failure", () => {
  const previouslyFailed = store({
    store: "minio", status: "done", verificationStatus: "failed",
  });

  it("keeps the failure when the retry learned nothing", () => {
    const unknown = store({ store: "minio", status: "failed", verificationStatus: "unknown" });
    const merged = preserveVerificationFailure(previouslyFailed, unknown);
    expect(merged.verificationStatus).toBe("failed");
    expect(merged.note).toContain("not refuted");
  });

  it("accepts a genuine re-verification that proves absence", () => {
    const passed = store({ store: "minio", status: "done", verificationStatus: "passed" });
    expect(preserveVerificationFailure(previouslyFailed, passed).verificationStatus).toBe("passed");
  });

  it("does nothing when there was no earlier failure", () => {
    const unknown = store({ store: "minio", status: "failed", verificationStatus: "unknown" });
    expect(preserveVerificationFailure(undefined, unknown)).toBe(unknown);
  });
});

describe("a lost object-key map is not a clean bucket", () => {
  const plan = buildResumePlan({ subject, threadIds: [], attachmentObjects: 2 });

  it("detects a retry that can no longer address what the first pass saw", () => {
    // Postgres deleted the attachment rows in the same operation, and they were
    // the only map to the object keys.
    expect(objectMapLost(plan, 0)).toBe(true);
  });

  it("stays quiet when the rows are still there", () => {
    expect(objectMapLost(plan, 2)).toBe(false);
  });

  it("stays quiet on a subject that never had attachments", () => {
    expect(objectMapLost(buildResumePlan({ subject, threadIds: [], attachmentObjects: 0 }), 0))
      .toBe(false);
  });

  it("stays quiet on the first pass, which has no plan to contradict", () => {
    expect(objectMapLost(null, 0)).toBe(false);
  });
});
