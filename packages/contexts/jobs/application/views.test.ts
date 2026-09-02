import { asIdentifier } from "@platos/kernel";
import { describe, expect, it } from "vitest";

import { resolveApproval, type JobKey } from "../domain/index.js";
import { aJob, anApproval } from "./testing/builders.js";
import { toApprovalView, toJobSourceView, toJobView } from "./views.js";

const NOW = new Date("2026-01-01T00:00:00.000Z");

function at(offsetMs: number): Date {
  return new Date(NOW.getTime() + offsetMs);
}

describe("toJobView", () => {
  it("OMITS the handler source", () => {
    expect(toJobView(aJob())).not.toHaveProperty("handler");
  });

  it("prefers the registered key for the caller-facing jobId", () => {
    expect(toJobView(aJob()).jobId).toBe("nightly-rollup");
  });

  it("falls back to the row id when no key was registered", () => {
    // The live `publicJob` is `job.externalId ?? job.id`.
    expect(toJobView(aJob({ jobKey: null })).jobId).toBe("job-0001");
  });

  it("always reports the row id separately from the key", () => {
    const view = toJobView(aJob());
    expect(view.id).toBe("job-0001");
    expect(view.id).not.toBe(view.jobId);
  });

  it("flattens the budget onto the view", () => {
    const view = toJobView(aJob({ budget: { timeoutSeconds: 42, maxRetries: 7 } }));
    expect(view.timeoutSeconds).toBe(42);
    expect(view.maxRetries).toBe(7);
  });

  it("reports isActive from the status", () => {
    expect(toJobView(aJob()).isActive).toBe(true);
    expect(toJobView(aJob({ status: "registration-failed" })).isActive).toBe(false);
  });
});

describe("toJobSourceView", () => {
  it("INCLUDES the handler, and is everything the safe view is", () => {
    const source = toJobSourceView(aJob());
    expect(source.handler).toBe(aJob().handler);
    expect(source.jobId).toBe(toJobView(aJob()).jobId);
  });
});

describe("toApprovalView", () => {
  it("reports a deadline while pending", () => {
    const view = toApprovalView(anApproval({ timeoutSeconds: 60 }), NOW);
    expect(view.deadlineAt).toEqual(at(60_000));
    expect(view.secondsRemaining).toBe(60);
    expect(view.expired).toBe(false);
  });

  it("DROPS the deadline once a decision has been made", () => {
    const decided = resolveApproval(anApproval(), "approved", at(1_000));
    if (!decided.ok) throw new Error("unreachable");
    const view = toApprovalView(decided.value, at(2_000));
    expect(view.deadlineAt).toBeNull();
    expect(view.secondsRemaining).toBeNull();
  });

  it("reports expired using the READ-PATH predicate, at the deadline instant", () => {
    const view = toApprovalView(anApproval({ timeoutSeconds: 60 }), at(60_000));
    expect(view.expired).toBe(true);
    expect(view.secondsRemaining).toBeNull();
  });

  it("surfaces the resolution fields", () => {
    const decided = resolveApproval(anApproval(), "approved", at(1_000), {
      respondedBy: "operator-1",
      comment: "fine",
      edit: { editedArguments: { path: "/safe" }, editedBy: "operator-1" },
    });
    if (!decided.ok) throw new Error("unreachable");
    const view = toApprovalView(decided.value, at(2_000));
    expect(view.respondedBy).toBe("operator-1");
    expect(view.comment).toBe("fine");
    expect(view.resolvedAt).toEqual(at(1_000));
    expect(view.editedArguments).toEqual({ path: "/safe" });
    expect(view.editedBy).toBe("operator-1");
  });

  it("nulls the resolution fields while pending", () => {
    const view = toApprovalView(anApproval(), NOW);
    expect(view.respondedBy).toBeNull();
    expect(view.resolvedAt).toBeNull();
    expect(view.editedArguments).toBeNull();
  });

  it("keeps the row id and the business approval id distinct", () => {
    const view = toApprovalView(anApproval(), NOW);
    expect(view.id).toBe("appr-row-0001");
    expect(view.approvalId).toBe("appr-0001");
  });

  it("computes every time-dependent field against the SAME supplied instant", () => {
    const approval = anApproval({ timeoutSeconds: 10 });
    const view = toApprovalView(approval, at(9_999));
    expect(view.expired).toBe(false);
    expect(view.secondsRemaining).toBe(0);
  });
});

describe("a job whose key was never registered", () => {
  it("is still describable", () => {
    const view = toJobView(aJob({ jobKey: null as unknown as JobKey }));
    expect(view.jobId).toBe("job-0001");
  });
});
