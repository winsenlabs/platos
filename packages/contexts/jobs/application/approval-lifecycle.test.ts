import { asIdentifier, type JobId as RuntimeJobId } from "@platos/kernel";
import { beforeEach, describe, expect, it } from "vitest";

import type { ApprovalId, RequestDigest } from "../domain/index.js";
import { genericApprovalTimeout, mcpApprovalTimeout, requestApproval } from "./request-approval.js";
import { resolveApproval as decide } from "../domain/index.js";
import { resolveApprovalDecision } from "./resolve-approval.js";
import { sweepAllScopes, sweepExpiredApprovals } from "./sweep-expired-approvals.js";
import {
  anApprovalRequest,
  buildJobsTestContext,
  testEnvironmentScope,
  type JobsTestContext,
} from "./testing/index.js";

const SCOPE = testEnvironmentScope("env-1");
const OTHER_SCOPE = testEnvironmentScope("env-2");
// The kernel's runtime `JobId` uses the optional-brand style rather than
// `Branded`, so `asIdentifier` does not apply to it.
const RUN: RuntimeJobId = "run-1";
const APPROVAL = asIdentifier<ApprovalId>("appr-0001");

describe("requestApproval — creating the row", () => {
  let context: JobsTestContext;

  beforeEach(() => {
    context = buildJobsTestContext();
  });

  it("creates a pending approval", async () => {
    const opened = await requestApproval(context.dependencies, {
      scope: SCOPE,
      request: anApprovalRequest(),
    });
    if (!opened.ok) throw new Error("unreachable");
    expect(opened.value.approval.status).toBe("pending");
    expect(opened.value.deduplicated).toBe(false);
    expect(opened.value.resumeToken).toBeNull();
  });

  it("does NOT park when no run was named", async () => {
    await requestApproval(context.dependencies, { scope: SCOPE, request: anApprovalRequest() });
    expect(context.durableRuntime.suspensions).toHaveLength(0);
  });
});

describe("requestApproval — suspending the waiting run (ADR M0.3 §1)", () => {
  let context: JobsTestContext;

  beforeEach(() => {
    context = buildJobsTestContext();
  });

  it("suspends the named run and returns its resume token", async () => {
    const opened = await requestApproval(context.dependencies, {
      scope: SCOPE,
      request: anApprovalRequest(),
      parkRunId: RUN,
    });
    if (!opened.ok) throw new Error("unreachable");
    expect(context.durableRuntime.suspensions).toHaveLength(1);
    expect(context.durableRuntime.suspensions[0]?.runId).toBe(RUN);
    expect(opened.value.resumeToken).toBe(context.durableRuntime.suspensions[0]?.token);
  });

  it("expires the suspension at the APPROVAL's own deadline", async () => {
    // A later expiry would park a run on a question that already timed out;
    // an earlier one would resume it while a human is still deciding.
    await requestApproval(context.dependencies, {
      scope: SCOPE,
      request: anApprovalRequest({ timeoutSeconds: 120 }),
      parkRunId: RUN,
    });
    const expected = new Date(context.clock.now().getTime() + 120_000);
    expect(context.durableRuntime.suspensions[0]?.expiresAt).toEqual(expected);
  });

  it("WRITES THE ROW BEFORE PARKING, so a park failure leaves a visible approval", async () => {
    context.durableRuntime.failNextSuspend("runtime unreachable");
    const opened = await requestApproval(context.dependencies, {
      scope: SCOPE,
      request: anApprovalRequest(),
      parkRunId: RUN,
    });
    expect(opened.ok).toBe(false);
    if (opened.ok) throw new Error("unreachable");
    expect(opened.error.code).toBe("JOBS_APPROVAL_SUSPENSION_UNAVAILABLE");
    // The recoverable half: the row exists and the park can be retried.
    const stored = await context.approvals.findByApprovalId(SCOPE, APPROVAL);
    if (!stored.ok) throw new Error("unreachable");
    expect(stored.value).not.toBeNull();
  });
});

describe("requestApproval — dedupe by digest", () => {
  let context: JobsTestContext;
  const digest = asIdentifier<RequestDigest>("digest-a");

  beforeEach(() => {
    context = buildJobsTestContext();
  });

  it("collapses two concurrent MCP requests onto ONE approval", async () => {
    const request = anApprovalRequest({ source: "mcp_tool_call", requestDigest: digest });
    const first = await requestApproval(context.dependencies, { scope: SCOPE, request });
    const second = await requestApproval(context.dependencies, {
      scope: SCOPE,
      request: { ...request, approvalId: asIdentifier<ApprovalId>("appr-0002") },
    });
    if (!first.ok || !second.ok) throw new Error("unreachable");
    expect(second.value.deduplicated).toBe(true);
    expect(second.value.approval.approvalId).toBe(first.value.approval.approvalId);
    expect(context.approvals.size()).toBe(1);
  });

  it("does NOT dedupe a request carrying no digest", async () => {
    await requestApproval(context.dependencies, { scope: SCOPE, request: anApprovalRequest() });
    await requestApproval(context.dependencies, {
      scope: SCOPE,
      request: anApprovalRequest({ approvalId: asIdentifier<ApprovalId>("appr-0002") }),
    });
    expect(context.approvals.size()).toBe(2);
  });

  it("does NOT dedupe across environments", async () => {
    const request = anApprovalRequest({ source: "mcp_tool_call", requestDigest: digest });
    await requestApproval(context.dependencies, { scope: SCOPE, request });
    const other = await requestApproval(context.dependencies, { scope: OTHER_SCOPE, request });
    if (!other.ok) throw new Error("unreachable");
    expect(other.value.deduplicated).toBe(false);
  });

  it("does NOT reuse an ELAPSED pending approval", async () => {
    // Reusing one would park the caller on a decision nobody can still make.
    const request = anApprovalRequest({
      source: "mcp_tool_call",
      requestDigest: digest,
      timeoutSeconds: 60,
    });
    await requestApproval(context.dependencies, { scope: SCOPE, request });
    context.clock.advanceSeconds(61);

    const second = await requestApproval(context.dependencies, {
      scope: SCOPE,
      request: { ...request, approvalId: asIdentifier<ApprovalId>("appr-0002") },
    });
    if (!second.ok) throw new Error("unreachable");
    expect(second.value.deduplicated).toBe(false);
    expect(context.approvals.size()).toBe(2);
  });

  it("does NOT dedupe a non-MCP source against an MCP row", async () => {
    await requestApproval(context.dependencies, {
      scope: SCOPE,
      request: anApprovalRequest({ source: "request_approval", requestDigest: digest }),
    });
    const second = await requestApproval(context.dependencies, {
      scope: SCOPE,
      request: anApprovalRequest({
        approvalId: asIdentifier<ApprovalId>("appr-0002"),
        source: "mcp_tool_call",
        requestDigest: digest,
      }),
    });
    if (!second.ok) throw new Error("unreachable");
    expect(second.value.deduplicated).toBe(false);
  });
});

describe("the two timeout clamps differ", () => {
  it("uses floor 1 / default 300 for a generic approval", () => {
    expect(genericApprovalTimeout(null)).toBe(300);
    expect(genericApprovalTimeout(0)).toBe(1);
  });

  it("uses floor 60 / default 3600 for the MCP path", () => {
    expect(mcpApprovalTimeout(null)).toBe(3600);
    expect(mcpApprovalTimeout(5)).toBe(60);
  });
});

describe("resolveApprovalDecision", () => {
  let context: JobsTestContext;

  beforeEach(async () => {
    context = buildJobsTestContext();
    await requestApproval(context.dependencies, { scope: SCOPE, request: anApprovalRequest() });
  });

  it("records the decision", async () => {
    const resolved = await resolveApprovalDecision(context.dependencies, {
      scope: SCOPE,
      approvalId: APPROVAL,
      decision: "approved",
      respondedBy: "operator-1",
    });
    if (!resolved.ok) throw new Error("unreachable");
    expect(resolved.value.approval.status).toBe("approved");
    expect(resolved.value.approval.resolution?.respondedBy).toBe("operator-1");
  });

  it("REFUSES a second decision — the guarded write lets one land", async () => {
    await resolveApprovalDecision(context.dependencies, {
      scope: SCOPE,
      approvalId: APPROVAL,
      decision: "approved",
    });
    const second = await resolveApprovalDecision(context.dependencies, {
      scope: SCOPE,
      approvalId: APPROVAL,
      decision: "rejected",
    });
    expect(second.ok).toBe(false);
    if (second.ok) throw new Error("unreachable");
    expect(second.error.code).toBe("JOBS_APPROVAL_ALREADY_RESOLVED");
  });

  it("REFUSES a decision on an elapsed approval", async () => {
    context.clock.advanceSeconds(301);
    const resolved = await resolveApprovalDecision(context.dependencies, {
      scope: SCOPE,
      approvalId: APPROVAL,
      decision: "approved",
    });
    if (resolved.ok) throw new Error("unreachable");
    expect(resolved.error.code).toBe("JOBS_APPROVAL_ELAPSED");
  });

  it("REFUSES an approval that is not visible in this scope", async () => {
    const resolved = await resolveApprovalDecision(context.dependencies, {
      scope: OTHER_SCOPE,
      approvalId: APPROVAL,
      decision: "approved",
    });
    if (resolved.ok) throw new Error("unreachable");
    expect(resolved.error.code).toBe("JOBS_APPROVAL_NOT_FOUND");
  });

  it("returns the EDITED arguments when a human changed them", async () => {
    const resolved = await resolveApprovalDecision(context.dependencies, {
      scope: SCOPE,
      approvalId: APPROVAL,
      decision: "approved",
      edit: { editedArguments: { path: "/safe" }, editedBy: "operator-1" },
    });
    if (!resolved.ok) throw new Error("unreachable");
    expect(resolved.value.effectiveArguments).toEqual({ path: "/safe" });
  });

  it("returns NO arguments for a rejection", async () => {
    const resolved = await resolveApprovalDecision(context.dependencies, {
      scope: SCOPE,
      approvalId: APPROVAL,
      decision: "rejected",
    });
    if (!resolved.ok) throw new Error("unreachable");
    expect(resolved.value.effectiveArguments).toBeNull();
  });
});

describe("resolveApprovalDecision — resuming the parked run", () => {
  let context: JobsTestContext;

  beforeEach(() => {
    context = buildJobsTestContext();
  });

  it("resumes the suspension the request minted", async () => {
    const opened = await requestApproval(context.dependencies, {
      scope: SCOPE,
      request: anApprovalRequest(),
      parkRunId: RUN,
    });
    if (!opened.ok) throw new Error("unreachable");

    const resolved = await resolveApprovalDecision(context.dependencies, {
      scope: SCOPE,
      approvalId: APPROVAL,
      decision: "approved",
      resumeToken: opened.value.resumeToken,
    });
    if (!resolved.ok) throw new Error("unreachable");
    expect(resolved.value.resume).toBe("resumed");
    expect(context.durableRuntime.resumes[0]?.value).toEqual({ decision: "approved" });
  });

  it("reports `already-resolved` rather than resuming a run twice", async () => {
    const opened = await requestApproval(context.dependencies, {
      scope: SCOPE,
      request: anApprovalRequest(),
      parkRunId: RUN,
    });
    if (!opened.ok) throw new Error("unreachable");
    context.durableRuntime.willResumeWith("already-resolved");

    const resolved = await resolveApprovalDecision(context.dependencies, {
      scope: SCOPE,
      approvalId: APPROVAL,
      decision: "approved",
      resumeToken: opened.value.resumeToken,
    });
    if (!resolved.ok) throw new Error("unreachable");
    expect(resolved.value.resume).toBe("already-resolved");
  });

  it("reports null when nothing was parked", async () => {
    await requestApproval(context.dependencies, { scope: SCOPE, request: anApprovalRequest() });
    const resolved = await resolveApprovalDecision(context.dependencies, {
      scope: SCOPE,
      approvalId: APPROVAL,
      decision: "approved",
    });
    if (!resolved.ok) throw new Error("unreachable");
    expect(resolved.value.resume).toBeNull();
  });

  it("WRITES THE DECISION BEFORE RESUMING, so a resume failure keeps the record", async () => {
    const opened = await requestApproval(context.dependencies, {
      scope: SCOPE,
      request: anApprovalRequest(),
      parkRunId: RUN,
    });
    if (!opened.ok) throw new Error("unreachable");
    context.durableRuntime.failNextResume("runtime unreachable");

    const resolved = await resolveApprovalDecision(context.dependencies, {
      scope: SCOPE,
      approvalId: APPROVAL,
      decision: "approved",
      resumeToken: opened.value.resumeToken,
    });

    // The call reports the resume failure...
    expect(resolved.ok).toBe(false);
    if (resolved.ok) throw new Error("unreachable");
    expect(resolved.error.code).toBe("JOBS_APPROVAL_SUSPENSION_UNAVAILABLE");

    // ...but the human's decision is already durable, so the work is not lost
    // and the resume can be retried. This is the ordering's whole point.
    const stored = await context.approvals.findByApprovalId(SCOPE, APPROVAL);
    if (!stored.ok || stored.value === null) throw new Error("unreachable");
    expect(stored.value.status).toBe("approved");
    expect(stored.value.resolution?.status).toBe("approved");
  });
});

// THE RACE THE CONDITIONAL WRITE DEFENDS AGAINST.
//
// Two dashboards click Approve at the same instant. Both read a pending row,
// both build a valid resolution, and the repository's guarded update lets
// exactly one land. The loser must be told; it must NOT be handed `ok` and it
// must not resume the parked run with its own decision.
//
// Nothing reached this branch. Resolving twice through the use case cannot: the
// second call re-reads a row that is no longer pending and the domain refuses it
// before any write. The rival's write has to land BETWEEN our read and our
// write, which is what `beforeNextResolve` arranges.
describe("resolveApprovalDecision — the loser of a concurrent decision", () => {
  let context: JobsTestContext;

  beforeEach(async () => {
    context = buildJobsTestContext();
    await requestApproval(context.dependencies, { scope: SCOPE, request: anApprovalRequest() });
  });

  async function rivalRejectsFirst(): Promise<void> {
    const stored = await context.approvals.findByApprovalId(SCOPE, APPROVAL);
    if (!stored.ok || stored.value === null) throw new Error("unreachable");
    const rival = decide(stored.value, "rejected", context.clock.now(), {
      respondedBy: "the-other-dashboard",
      comment: null,
      edit: null,
    });
    if (!rival.ok) throw new Error("unreachable");
    context.approvals.beforeNextResolve(() => context.approvals.forceStored(SCOPE, rival.value));
  }

  it("is REFUSED as already resolved, not told its decision landed", async () => {
    await rivalRejectsFirst();
    const loser = await resolveApprovalDecision(context.dependencies, {
      scope: SCOPE,
      approvalId: APPROVAL,
      decision: "approved",
    });
    expect(loser.ok).toBe(false);
    if (loser.ok) throw new Error("unreachable");
    expect(loser.error.code).toBe("JOBS_APPROVAL_ALREADY_RESOLVED");
    // The winner's decision stands.
    const stored = await context.approvals.findByApprovalId(SCOPE, APPROVAL);
    if (!stored.ok || stored.value === null) throw new Error("unreachable");
    expect(stored.value.status).toBe("rejected");
  });

  it("does NOT resume the parked run with the loser's decision", async () => {
    const opened = await requestApproval(context.dependencies, {
      scope: SCOPE,
      request: anApprovalRequest({ approvalId: asIdentifier<ApprovalId>("appr-0002") }),
      parkRunId: RUN,
    });
    if (!opened.ok) throw new Error("unreachable");
    const stored = opened.value.approval;
    const rival = decide(stored, "rejected", context.clock.now(), {
      respondedBy: "the-other-dashboard",
      comment: null,
      edit: null,
    });
    if (!rival.ok) throw new Error("unreachable");
    context.approvals.beforeNextResolve(() => context.approvals.forceStored(SCOPE, rival.value));

    const loser = await resolveApprovalDecision(context.dependencies, {
      scope: SCOPE,
      approvalId: asIdentifier<ApprovalId>("appr-0002"),
      decision: "approved",
      resumeToken: opened.value.resumeToken,
    });

    expect(loser.ok).toBe(false);
    // The run is still parked on the WINNER's decision, which some other caller
    // will deliver. Resuming here would continue the run on a rejection's
    // opposite.
    expect(context.durableRuntime.resumes).toHaveLength(0);
  });
});

describe("sweepExpiredApprovals", () => {
  let context: JobsTestContext;

  beforeEach(async () => {
    context = buildJobsTestContext();
    await requestApproval(context.dependencies, {
      scope: SCOPE,
      request: anApprovalRequest({ timeoutSeconds: 60 }),
    });
  });

  it("leaves a pending approval alone before its deadline", async () => {
    context.clock.advanceSeconds(59);
    const report = await sweepExpiredApprovals(context.dependencies, SCOPE);
    if (!report.ok) throw new Error("unreachable");
    expect(report.value.timedOut).toBe(0);
  });

  it("uses the STRICT predicate: nothing is swept AT the deadline", async () => {
    // The read path reports it as expired at this instant; the sweep does not.
    context.clock.advanceSeconds(60);
    const report = await sweepExpiredApprovals(context.dependencies, SCOPE);
    if (!report.ok) throw new Error("unreachable");
    expect(report.value.timedOut).toBe(0);
  });

  it("sweeps one millisecond past the deadline", async () => {
    context.clock.advanceSeconds(60);
    context.clock.advanceMilliseconds(1);
    const report = await sweepExpiredApprovals(context.dependencies, SCOPE);
    if (!report.ok) throw new Error("unreachable");
    expect(report.value.timedOut).toBe(1);
    const stored = await context.approvals.findByApprovalId(SCOPE, APPROVAL);
    if (!stored.ok || stored.value === null) throw new Error("unreachable");
    expect(stored.value.status).toBe("timed_out");
  });

  it("does NOT count a row a human decided first as a failure", async () => {
    await resolveApprovalDecision(context.dependencies, {
      scope: SCOPE,
      approvalId: APPROVAL,
      decision: "approved",
    });
    context.clock.advanceSeconds(120);
    const report = await sweepExpiredApprovals(context.dependencies, SCOPE);
    if (!report.ok) throw new Error("unreachable");
    expect(report.value.timedOut).toBe(0);
    expect(report.value.retained).toHaveLength(0);
  });

  // THE `retained` DIAGNOSTIC CHANNEL WAS DEAD. Only the scope-level failure in
  // `sweepAllScopes` ever populated it; the per-ROW push had no caller, so
  // deleting it left 354 green and a row the sweep could not take vanished from
  // the report entirely. That is the one thing this report exists to say: the
  // pass deliberately continues past a failure, so a failure it does not name is
  // a row nobody will ever look at.
  it("NAMES a sweepable row it could not take, with the reason", async () => {
    context.clock.advanceSeconds(61);
    context.approvals.failNextResolve("write conflict");
    const report = await sweepExpiredApprovals(context.dependencies, SCOPE);
    if (!report.ok) throw new Error("unreachable");
    expect(report.value.examined).toBe(1);
    expect(report.value.timedOut).toBe(0);
    expect(report.value.retained).toEqual([
      { approvalId: APPROVAL, reason: "JOBS_REPOSITORY_UNAVAILABLE" },
    ]);
  });

  it("carries that row through to the all-scopes report rather than losing it", async () => {
    context.clock.advanceSeconds(61);
    context.approvals.failNextResolve("write conflict");
    const report = await sweepAllScopes(context.dependencies);
    if (!report.ok) throw new Error("unreachable");
    expect(report.value.totalTimedOut).toBe(0);
    expect(report.value.perScope[0]?.retained).toEqual([
      { approvalId: APPROVAL, reason: "JOBS_REPOSITORY_UNAVAILABLE" },
    ]);
  });
});

describe("sweepAllScopes", () => {
  it("visits every scope holding a pending approval", async () => {
    const context = buildJobsTestContext();
    await requestApproval(context.dependencies, {
      scope: SCOPE,
      request: anApprovalRequest({ timeoutSeconds: 60 }),
    });
    await requestApproval(context.dependencies, {
      scope: OTHER_SCOPE,
      request: anApprovalRequest({ approvalId: asIdentifier<ApprovalId>("appr-0002"), timeoutSeconds: 60 }),
    });
    context.clock.advanceSeconds(120);

    const report = await sweepAllScopes(context.dependencies);
    if (!report.ok) throw new Error("unreachable");
    expect(report.value.scopesScanned).toBe(2);
    expect(report.value.totalTimedOut).toBe(2);
  });

  it("reports nothing to do when no approval is pending", async () => {
    const context = buildJobsTestContext();
    const report = await sweepAllScopes(context.dependencies);
    if (!report.ok) throw new Error("unreachable");
    expect(report.value).toEqual({ scopesScanned: 0, totalTimedOut: 0, perScope: [] });
  });

  it("continues past a scope that fails, recording it rather than aborting the pass", async () => {
    const context = buildJobsTestContext();
    await requestApproval(context.dependencies, {
      scope: SCOPE,
      request: anApprovalRequest({ timeoutSeconds: 60 }),
    });
    await requestApproval(context.dependencies, {
      scope: OTHER_SCOPE,
      request: anApprovalRequest({ approvalId: asIdentifier<ApprovalId>("appr-0002"), timeoutSeconds: 60 }),
    });
    context.clock.advanceSeconds(120);
    context.approvals.failNextFindPending("blip");

    const report = await sweepAllScopes(context.dependencies);
    if (!report.ok) throw new Error("unreachable");
    // Two scopes visited; the healthy one still swept.
    expect(report.value.scopesScanned).toBe(2);
    expect(report.value.totalTimedOut).toBe(1);
    expect(report.value.perScope.some((entry) => entry.retained.length > 0)).toBe(true);
  });

  it("FAILS CLOSED when the scope enumeration itself fails", async () => {
    // Nothing to iterate means nothing can be judged; reporting success would
    // claim a sweep happened.
    const context = buildJobsTestContext();
    context.approvals.failNext("enumeration down");
    const report = await sweepAllScopes(context.dependencies);
    expect(report.ok).toBe(false);
  });
});
