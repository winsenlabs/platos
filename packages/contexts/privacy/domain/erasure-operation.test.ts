import { asIdentifier, organizationScope, type OrganizationId } from "@platos/kernel";
import { describe, expect, it } from "vitest";

import {
  canRetry,
  deriveStatus,
  isEmptySubjectStatus,
  mergeOutcomes,
  projectOperation,
  receiptStatusFor,
  targetsNeedingRetry,
  toWorkStatus,
  type ErasureStatus,
  type PersistedErasureOperation,
  type WorkStatus,
} from "./erasure-operation.js";
import type { ErasureOperationId, IdempotencyKey, SubjectKeyHash } from "./identifiers.js";
import { pendingTarget, type TargetOutcome } from "./target-outcome.js";

const ORGANIZATION: OrganizationId = asIdentifier("org-1");

function outcome(target: string, overrides: Partial<TargetOutcome> = {}): TargetOutcome {
  return { ...pendingTarget(target), ...overrides };
}

const SETTLED = outcome("files", { status: "done", verification: "passed" });
const SURVIVED = outcome("tools", { status: "done", verification: "failed" });
const CRASHED = outcome("tools", { status: "failed", verification: "unknown", failures: 1 });
const UNPROVEN = outcome("tools", { status: "done", verification: "unknown" });
const ABSENT = outcome("memory", { status: "not_provisioned", verification: "not_applicable" });

describe("deriveStatus", () => {
  it("is `pending` until a pass has started, whatever the outcomes say", () => {
    expect(deriveStatus([SETTLED])).toBe("pending");
  });

  it("puts a legal hold above everything, because nothing ran", () => {
    expect(deriveStatus([SURVIVED], { legalHold: true, started: true })).toBe("blocked_legal_hold");
  });

  it("puts a verification failure above a plain failure", () => {
    // Deleting and finding it still there is worse than not having deleted.
    expect(deriveStatus([SURVIVED, CRASHED], { started: true })).toBe("verification_failed");
  });

  it("reports a crashed target as a partial failure", () => {
    expect(deriveStatus([SETTLED, CRASHED], { started: true })).toBe("partial_failure");
  });

  it("keeps an UNPROVEN target open rather than rounding it up to completed", () => {
    expect(deriveStatus([SETTLED, UNPROVEN], { started: true })).toBe("partial_failure");
  });

  it("completes only when every target settled", () => {
    expect(deriveStatus([SETTLED, ABSENT], { started: true })).toBe("completed");
  });

  it("stays `running` while a required target has not reported at all", () => {
    expect(deriveStatus([SETTLED], { started: true, requiredTargets: ["files", "tools"] })).toBe("running");
  });

  it("does not complete on an empty outcome list", () => {
    expect(deriveStatus([], { started: true })).toBe("running");
  });

  it("stays `running` while a target is still pending", () => {
    expect(deriveStatus([SETTLED, outcome("tools", { status: "running" })], { started: true })).toBe("running");
  });
});

describe("the two status vocabularies", () => {
  const cases: readonly (readonly [ErasureStatus, WorkStatus])[] = [
    ["pending", "PENDING"],
    ["running", "ACTIVE"],
    ["completed", "SUCCEEDED"],
    ["blocked_legal_hold", "CANCELLED"],
    ["partial_failure", "FAILED"],
    ["verification_failed", "FAILED"],
  ];

  it("projects every operational status onto the row's WorkStatus column", () => {
    expect(cases.map(([status]) => toWorkStatus(status))).toEqual(cases.map(([, work]) => work));
  });

  it("recovers `verification_failed` from a FAILED column plus its evidence", () => {
    expect(
      receiptStatusFor({ workStatus: "FAILED", legalHoldPolicyId: null, outcomes: [SURVIVED] }),
    ).toBe("verification_failed");
  });

  it("recovers `partial_failure` from the same column with different evidence", () => {
    expect(
      receiptStatusFor({ workStatus: "FAILED", legalHoldPolicyId: null, outcomes: [CRASHED] }),
    ).toBe("partial_failure");
  });

  it("lets a hold reference outrank the column, because CANCELLED does not say why", () => {
    expect(
      receiptStatusFor({ workStatus: "CANCELLED", legalHoldPolicyId: "legal-hold-register#1:abc", outcomes: [] }),
    ).toBe("blocked_legal_hold");
  });

  it("reads a FAILED row with NO outcomes as verification_failed, not as running", () => {
    // The unresolved-subject operation. `deriveStatus` alone would say `running`
    // — inside one pass, "no outcome yet" and "no outcome ever" look the same —
    // but the column has already said this operation is not in flight.
    expect(receiptStatusFor({ workStatus: "FAILED", legalHoldPolicyId: null, outcomes: [] })).toBe(
      "verification_failed",
    );
    expect(deriveStatus([], { started: true })).toBe("running");
  });

  it("round-trips the statuses the column can express on its own", () => {
    for (const status of ["completed", "running", "pending"] as const) {
      expect(
        receiptStatusFor({ workStatus: toWorkStatus(status), legalHoldPolicyId: null, outcomes: [] }),
      ).toBe(status);
    }
  });
});

describe("canRetry", () => {
  it("refuses a completed operation, because a retry would be a no-op", () => {
    expect(canRetry({ status: "completed" })).toEqual({
      allowed: false,
      reason: "already completed; retry would be a no-op",
    });
  });

  it("refuses a held operation until the hold is released", () => {
    expect(canRetry({ status: "blocked_legal_hold" }).allowed).toBe(false);
  });

  it("permits every open status", () => {
    for (const status of ["pending", "running", "partial_failure", "verification_failed"] as const) {
      expect(canRetry({ status }).allowed).toBe(true);
    }
  });
});

describe("targetsNeedingRetry", () => {
  it("re-runs only what did not settle", () => {
    expect(targetsNeedingRetry({ outcomes: [SETTLED, CRASHED] }, ["files", "tools"])).toEqual(["tools"]);
  });

  it("includes a roster name that never reported at all", () => {
    expect(targetsNeedingRetry({ outcomes: [SETTLED] }, ["files", "memory"])).toEqual(["memory"]);
  });

  it("does not re-run a target with no model to erase", () => {
    expect(targetsNeedingRetry({ outcomes: [ABSENT] }, ["memory"])).toEqual([]);
  });
});

describe("mergeOutcomes", () => {
  it("lets this pass replace a target's earlier outcome", () => {
    const merged = mergeOutcomes([CRASHED], [outcome("tools", { status: "done", verification: "passed" })]);
    expect(merged).toHaveLength(1);
    expect(merged[0]?.verification).toBe("passed");
  });

  it("keeps outcomes for targets this pass did not run", () => {
    expect(mergeOutcomes([SETTLED], [CRASHED]).map((entry) => entry.target)).toEqual(["files", "tools"]);
  });
});

describe("projectOperation", () => {
  const row: PersistedErasureOperation = {
    operationId: asIdentifier<ErasureOperationId>("op-1"),
    organizationId: ORGANIZATION,
    idempotencyKey: asIdentifier<IdempotencyKey>("key-1"),
    subjectKeyHash: asIdentifier<SubjectKeyHash>("d0000001"),
    workStatus: "FAILED",
    scopes: [organizationScope(ORGANIZATION)],
    outcomes: [SURVIVED],
    policyVersion: "2026-08-11.1",
    legalHoldPolicyId: null,
    retryCount: 2,
    requestedAt: new Date("2026-01-01T00:00:00.000Z"),
    startedAt: new Date("2026-01-01T00:00:01.000Z"),
    completedAt: null,
    nextRetryAt: new Date("2026-01-01T00:01:00.000Z"),
    leaseToken: null,
    leaseExpiresAt: null,
  };

  it("replaces the lossy column with the status its evidence supports", () => {
    expect(projectOperation(row).status).toBe("verification_failed");
  });

  it("carries every other column through untouched", () => {
    const record = projectOperation(row);
    expect(record.operationId).toBe(row.operationId);
    expect(record.retryCount).toBe(2);
    expect(record.scopes).toEqual(row.scopes);
    expect("workStatus" in record).toBe(false);
  });

  it("applies the required roster, so a missing target reads as still running", () => {
    expect(projectOperation({ ...row, outcomes: [SETTLED], workStatus: "FAILED" }, ["files", "tools"]).status).toBe(
      "running",
    );
  });
});

describe("an unresolved subject", () => {
  it("lands at verification_failed — we destroyed nothing and cannot prove it is gone", () => {
    expect(isEmptySubjectStatus()).toBe("verification_failed");
    expect(toWorkStatus(isEmptySubjectStatus())).toBe("FAILED");
  });
});
