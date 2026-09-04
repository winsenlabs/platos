import type { ErasurePlan, ErasureReceipt } from "@platos/kernel";
import { describe, expect, it } from "vitest";

import {
  ZERO_COUNTS,
  appendNote,
  blockedRowCount,
  combineOutcomes,
  demoteForRollback,
  isTargetSettled,
  isUnproven,
  pendingTarget,
  plannedRowCount,
  preserveVerificationFailure,
  rejectedTarget,
  settleTarget,
  unwiredTarget,
  type TargetOutcome,
} from "./target-outcome.js";

const TARGET = "files";

function plan(items: ErasurePlan["items"]): ErasurePlan {
  return { targetName: TARGET, items };
}

function receipt(items: ErasureReceipt["items"]): ErasureReceipt {
  return { targetName: TARGET, erasedAt: new Date(0), items };
}

const TWO_ROWS = plan([
  { model: "MessageAttachment", method: "delete", rowCount: 1, blockedBy: null },
  { model: "Artifact", method: "delete", rowCount: 1, blockedBy: null },
]);
const CLEAN_REPROBE = plan([
  { model: "MessageAttachment", method: "delete", rowCount: 0, blockedBy: null },
  { model: "Artifact", method: "delete", rowCount: 0, blockedBy: null },
]);

describe("plannedRowCount / blockedRowCount", () => {
  it("totals what a target says it holds", () => {
    expect(plannedRowCount(TWO_ROWS)).toBe(2);
  });

  it("separates the rows a hold or retention rule kept", () => {
    const held = plan([{ model: "Artifact", method: "delete", rowCount: 3, blockedBy: "hold-1" }]);
    expect(plannedRowCount(held)).toBe(3);
    expect(blockedRowCount(held)).toBe(3);
  });
});

describe("settleTarget", () => {
  it("passes only when the post-delete probe finds nothing left", () => {
    const outcome = settleTarget({ plan: TWO_ROWS, receipt: receipt(TWO_ROWS.items), reprobe: CLEAN_REPROBE });
    expect(outcome.status).toBe("done");
    expect(outcome.verification).toBe("passed");
    expect(outcome.discovered).toBe(2);
    expect(outcome.counts.deleted).toBe(2);
  });

  it("FAILS verification when rows survived — positive evidence, not an unknown", () => {
    const survivors = plan([{ model: "Artifact", method: "delete", rowCount: 1, blockedBy: null }]);
    const outcome = settleTarget({ plan: TWO_ROWS, receipt: receipt(TWO_ROWS.items), reprobe: survivors });
    expect(outcome.verification).toBe("failed");
    expect(outcome.note).toContain("1 row(s) survived");
  });

  it("catches a target that reported a receipt and deleted NOTHING", () => {
    // The receipt alone is indistinguishable from a real one. Only the probe
    // separates "we deleted two rows" from "we said we did".
    const outcome = settleTarget({ plan: TWO_ROWS, receipt: receipt(TWO_ROWS.items), reprobe: TWO_ROWS });
    expect(outcome.verification).toBe("failed");
  });

  it("is UNKNOWN when the probe could not be taken, which keeps the operation open", () => {
    const outcome = settleTarget({ plan: TWO_ROWS, receipt: receipt(TWO_ROWS.items), reprobe: null });
    expect(outcome.verification).toBe("unknown");
    expect(isUnproven(outcome)).toBe(true);
    expect(isTargetSettled(outcome)).toBe(false);
  });

  it("does not count rows a hold kept as deleted", () => {
    const held = plan([{ model: "Artifact", method: "anonymize", rowCount: 2, blockedBy: "hold-1" }]);
    const outcome = settleTarget({ plan: held, receipt: receipt(held.items), reprobe: held });
    expect(outcome.counts).toEqual({ ...ZERO_COUNTS, retained: 2 });
    // Every planned row is blocked, so nothing survived that was meant to go.
    expect(outcome.verification).toBe("passed");
  });

  it("splits the counts by the kernel's method rather than totalling them", () => {
    const mixed = plan([
      { model: "A", method: "delete", rowCount: 1, blockedBy: null },
      { model: "B", method: "anonymize", rowCount: 2, blockedBy: null },
      { model: "C", method: "crypto-shred", rowCount: 3, blockedBy: null },
    ]);
    const outcome = settleTarget({ plan: mixed, receipt: receipt(mixed.items), reprobe: CLEAN_REPROBE });
    expect(outcome.counts).toEqual({ deleted: 1, anonymized: 2, cryptoShredded: 3, retained: 0 });
  });

  it("is NOT_PROVISIONED when the target owns no model, and never reads as verified", () => {
    const empty = plan([]);
    const outcome = settleTarget({ plan: empty, receipt: receipt([]), reprobe: empty });
    expect(outcome.status).toBe("not_provisioned");
    expect(outcome.verification).toBe("not_applicable");
    expect(isTargetSettled(outcome)).toBe(true);
  });
});

describe("isTargetSettled", () => {
  it("requires a proof, not just a finish", () => {
    const done = settleTarget({ plan: TWO_ROWS, receipt: receipt(TWO_ROWS.items), reprobe: CLEAN_REPROBE });
    expect(isTargetSettled(done)).toBe(true);
    expect(isTargetSettled({ ...done, verification: "unknown" })).toBe(false);
  });

  it("never settles a rejected target", () => {
    expect(isTargetSettled(rejectedTarget(TARGET, "TEST_REFUSED"))).toBe(false);
  });

  it("never settles a target the composition root did not wire", () => {
    const unwired = unwiredTarget(TARGET);
    expect(isTargetSettled(unwired)).toBe(false);
    expect(unwired.note).toBe("no target wired for this context");
  });
});

describe("rejectedTarget", () => {
  it("records a CLASS, never a message, because messages embed the erased ids", () => {
    expect(rejectedTarget(TARGET, "FILES_BLOB_DESTRUCTION_FAILED").note).toBe(
      "target rejected (FILES_BLOB_DESTRUCTION_FAILED)",
    );
  });

  it("is verification `unknown`, not `failed`: a throw proves nothing either way", () => {
    expect(rejectedTarget(TARGET, "X").verification).toBe("unknown");
  });
});

describe("preserveVerificationFailure", () => {
  const failed: TargetOutcome = { ...pendingTarget(TARGET), status: "done", verification: "failed" };
  const unknown: TargetOutcome = { ...pendingTarget(TARGET), status: "done", verification: "unknown" };
  const passed: TargetOutcome = { ...pendingTarget(TARGET), status: "done", verification: "passed" };

  it("refuses to let a later `unknown` overwrite positive evidence of survival", () => {
    const kept = preserveVerificationFailure(failed, unknown);
    expect(kept.verification).toBe("failed");
    expect(kept.note).toContain("not refuted by this pass");
  });

  it("lets a genuine `passed` clear it — that is what a retry is for", () => {
    expect(preserveVerificationFailure(failed, passed).verification).toBe("passed");
  });

  it("leaves an outcome alone when there was no earlier failure", () => {
    expect(preserveVerificationFailure(undefined, unknown)).toBe(unknown);
    expect(preserveVerificationFailure(passed, unknown)).toBe(unknown);
  });
});

describe("demoteForRollback", () => {
  it("REFUSES a pass that certified inside a transaction that was discarded", () => {
    const passed = settleTarget({ plan: TWO_ROWS, receipt: receipt(TWO_ROWS.items), reprobe: CLEAN_REPROBE });
    const demoted = demoteForRollback(passed);
    expect(demoted.verification).toBe("unknown");
    expect(demoted.note).toContain("rolled back");
    expect(isTargetSettled(demoted)).toBe(false);
  });

  it("keeps a `failed` verification, which a rollback can only make more true", () => {
    const failed: TargetOutcome = { ...pendingTarget(TARGET), status: "done", verification: "failed" };
    expect(demoteForRollback(failed)).toBe(failed);
  });

  it("leaves a target with no model alone: there is nothing to roll back", () => {
    const empty = settleTarget({ plan: plan([]), receipt: receipt([]), reprobe: plan([]) });
    expect(demoteForRollback(empty).verification).toBe("not_applicable");
  });
});

describe("combineOutcomes", () => {
  const passed = settleTarget({ plan: TWO_ROWS, receipt: receipt(TWO_ROWS.items), reprobe: CLEAN_REPROBE });
  const survived = settleTarget({ plan: TWO_ROWS, receipt: receipt(TWO_ROWS.items), reprobe: TWO_ROWS });

  it("sums the counts across every scope the subject occupies", () => {
    const combined = combineOutcomes(TARGET, [passed, passed]);
    expect(combined.discovered).toBe(4);
    expect(combined.counts.deleted).toBe(4);
  });

  it("takes the WORST verification: three clean scopes do not excuse a fourth", () => {
    expect(combineOutcomes(TARGET, [passed, survived]).verification).toBe("failed");
  });

  it("refuses to pass when any scope could not be probed", () => {
    const unknown = settleTarget({ plan: TWO_ROWS, receipt: receipt(TWO_ROWS.items), reprobe: null });
    expect(combineOutcomes(TARGET, [passed, unknown]).verification).toBe("unknown");
  });

  it("takes the worst status too, and totals the failures", () => {
    const combined = combineOutcomes(TARGET, [passed, rejectedTarget(TARGET, "X")]);
    expect(combined.status).toBe("failed");
    expect(combined.failures).toBe(1);
  });

  it("is `not_provisioned` when a roster names a target that reported about nobody", () => {
    const combined = combineOutcomes(TARGET, []);
    expect(combined.status).toBe("not_provisioned");
    expect(combined.verification).toBe("not_applicable");
  });

  it("keeps every part's note rather than the last one", () => {
    const combined = combineOutcomes(TARGET, [survived, rejectedTarget(TARGET, "X")]);
    expect(combined.note).toContain("survived");
    expect(combined.note).toContain("target rejected (X)");
  });
});

describe("appendNote", () => {
  it("joins rather than replacing, so no reason is lost", () => {
    expect(appendNote("first", "second")).toBe("first; second");
    expect(appendNote(null, "only")).toBe("only");
    expect(appendNote("", "only")).toBe("only");
  });
});
