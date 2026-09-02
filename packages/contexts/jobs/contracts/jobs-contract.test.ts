// The published surface, exercised end to end through `createJobsContract`.
//
// These tests go through the CONTRACT rather than the use cases, because the
// contract is the only thing another context may call and its command shapes are
// a translation layer that can drift from the use cases beneath it.

import { asIdentifier, type JobId as RuntimeJobId } from "@platos/kernel";
import { beforeEach, describe, expect, it } from "vitest";

import { createJobsContract } from "../application/jobs-contract.js";
import {
  buildJobsTestContext,
  testEnvironmentScope,
  type JobsTestContext,
} from "../application/testing/index.js";
import type { ApprovalId, JobId, JobKey } from "../domain/index.js";
import type { JobsContract } from "./index.js";

const SCOPE = testEnvironmentScope("env-1");
const APPROVAL = asIdentifier<ApprovalId>("appr-1");

const REGISTER = {
  scope: SCOPE,
  jobKey: "nightly-rollup",
  displayName: "Nightly rollup",
  handler: "async function run(payload, ctx) { return 1; }",
  createdBy: "user-1",
};

describe("createJobsContract", () => {
  let context: JobsTestContext;
  let contract: JobsContract;

  beforeEach(() => {
    context = buildJobsTestContext();
    contract = createJobsContract(context.dependencies);
  });

  it("names itself", () => {
    expect(contract.name).toBe("jobs");
  });

  it("registers a job and returns the SAFE projection", async () => {
    const registered = await contract.registerJob(REGISTER);
    if (!registered.ok) throw new Error("unreachable");
    expect(registered.value.job.jobId).toBe("nightly-rollup");
    expect(registered.value.job.isActive).toBe(true);
    // The handler is NOT in the default projection.
    expect(registered.value.job).not.toHaveProperty("handler");
  });

  it("exposes the handler only through the explicit source read", async () => {
    const registered = await contract.registerJob(REGISTER);
    if (!registered.ok) throw new Error("unreachable");
    const source = await contract.readJobSource({
      scope: SCOPE,
      jobId: asIdentifier<JobId>(registered.value.job.id),
    });
    if (!source.ok) throw new Error("unreachable");
    expect(source.value.handler).toBe(REGISTER.handler);
  });

  it("describes a job by key", async () => {
    await contract.registerJob(REGISTER);
    const described = await contract.describeJobByKey({
      scope: SCOPE,
      jobKey: asIdentifier<JobKey>("nightly-rollup"),
    });
    if (!described.ok) throw new Error("unreachable");
    expect(described.value.displayName).toBe("Nightly rollup");
  });

  it("lists jobs in the scope", async () => {
    await contract.registerJob(REGISTER);
    const listed = await contract.listJobs(SCOPE);
    if (!listed.ok) throw new Error("unreachable");
    expect(listed.value).toHaveLength(1);
  });

  it("reports a missing job rather than returning null", async () => {
    const described = await contract.describeJob({ scope: SCOPE, jobId: asIdentifier<JobId>("nope") });
    expect(described.ok).toBe(false);
    if (described.ok) throw new Error("unreachable");
    expect(described.error.code).toBe("JOBS_JOB_NOT_FOUND");
  });

  it("ADMITS the execution body itself rather than trusting a parsed one", async () => {
    const registered = await contract.registerJob(REGISTER);
    if (!registered.ok) throw new Error("unreachable");
    const refused = await contract.execute({
      scope: SCOPE,
      body: { requestId: "req-1", jobId: registered.value.job.id, unexpected: true },
    });
    expect(refused.ok).toBe(false);
    if (refused.ok) throw new Error("unreachable");
    expect(refused.error.code).toBe("INVALID_REQUEST");
  });

  it("executes a job through the published surface", async () => {
    const registered = await contract.registerJob(REGISTER);
    if (!registered.ok) throw new Error("unreachable");
    context.handlers.willReturn({ kind: "completed", value: { rows: 2 } });

    const executed = await contract.execute({
      scope: SCOPE,
      body: {
        requestId: "req-1",
        jobId: registered.value.job.id,
        payload: {},
        scope: { organizationId: "org-1", projectId: "proj-1", environmentId: "env-1" },
        invokedBy: "manual",
      },
    });
    expect(executed).toEqual({ ok: true, value: { value: { rows: 2 }, replayed: false } });
  });

  it("opens an approval and parks the named run", async () => {
    const opened = await contract.requestApproval({
      scope: SCOPE,
      approvalId: APPROVAL,
      source: "mcp_tool_call",
      action: "Delete everything",
      parkRunId: "run-1" as RuntimeJobId,
    });
    if (!opened.ok) throw new Error("unreachable");
    expect(opened.value.approval.status).toBe("pending");
    expect(opened.value.resumeToken).not.toBeNull();
    expect(context.durableRuntime.suspensions).toHaveLength(1);
  });

  it("dedupes two identical MCP requests through the contract's digest", async () => {
    const request = {
      scope: SCOPE,
      approvalId: APPROVAL,
      source: "mcp_tool_call",
      action: "Delete everything",
      deduplicateOn: { toolName: "fs.delete", arguments: { path: "/tmp" } },
    };
    await contract.requestApproval(request);
    const second = await contract.requestApproval({
      ...request,
      approvalId: asIdentifier<ApprovalId>("appr-2"),
    });
    if (!second.ok) throw new Error("unreachable");
    expect(second.value.deduplicated).toBe(true);
  });

  it("does NOT dedupe when the arguments differ", async () => {
    const base = {
      scope: SCOPE,
      approvalId: APPROVAL,
      source: "mcp_tool_call",
      action: "Delete everything",
    };
    await contract.requestApproval({
      ...base,
      deduplicateOn: { toolName: "fs.delete", arguments: { path: "/tmp" } },
    });
    const second = await contract.requestApproval({
      ...base,
      approvalId: asIdentifier<ApprovalId>("appr-2"),
      deduplicateOn: { toolName: "fs.delete", arguments: { path: "/etc" } },
    });
    if (!second.ok) throw new Error("unreachable");
    expect(second.value.deduplicated).toBe(false);
  });

  it("resolves an approval and reports the effective arguments", async () => {
    await contract.requestApproval({
      scope: SCOPE,
      approvalId: APPROVAL,
      source: "request_approval",
      action: "Delete everything",
      arguments: { path: "/tmp" },
    });

    const resolved = await contract.resolveApproval({
      scope: SCOPE,
      approvalId: APPROVAL,
      decision: "approved",
      respondedBy: "operator-1",
      editedArguments: { path: "/safe" },
    });
    if (!resolved.ok) throw new Error("unreachable");
    expect(resolved.value.approval.status).toBe("approved");
    expect(resolved.value.effectiveArguments).toEqual({ path: "/safe" });
    expect(resolved.value.approval.editedBy).toBe("operator-1");
  });

  it("lists approvals with the clamped page", async () => {
    await contract.requestApproval({
      scope: SCOPE,
      approvalId: APPROVAL,
      source: "request_approval",
      action: "Delete everything",
    });
    const listed = await contract.listApprovals({ scope: SCOPE, limit: 5000 });
    if (!listed.ok) throw new Error("unreachable");
    expect(listed.value.limit).toBe(200);
    expect(listed.value.total).toBe(1);
    expect(listed.value.pendingCount).toBe(1);
  });

  it("describes one approval", async () => {
    await contract.requestApproval({
      scope: SCOPE,
      approvalId: APPROVAL,
      source: "request_approval",
      action: "Delete everything",
    });
    const described = await contract.describeApproval(SCOPE, APPROVAL);
    if (!described.ok) throw new Error("unreachable");
    expect(described.value.approvalId).toBe(APPROVAL);
  });

  it("records that an approved call was carried out", async () => {
    await contract.requestApproval({
      scope: SCOPE,
      approvalId: APPROVAL,
      source: "mcp_tool_call",
      action: "Delete everything",
    });
    const marked = await contract.markApprovalConsumed({
      scope: SCOPE,
      approvalId: APPROVAL,
      outcome: { deleted: 3 },
    });
    expect(marked).toEqual({ ok: true, value: true });

    const described = await contract.describeApproval(SCOPE, APPROVAL);
    if (!described.ok) throw new Error("unreachable");
    expect(described.value.consumedAt).toEqual(context.clock.now());
    expect(described.value.outcome).toEqual({ deleted: 3 });
  });

  it("sweeps one scope and every scope", async () => {
    await contract.requestApproval({
      scope: SCOPE,
      approvalId: APPROVAL,
      source: "request_approval",
      action: "Delete everything",
      timeoutSeconds: 60,
    });
    context.clock.advanceSeconds(3700);

    const one = await contract.sweepApprovals(SCOPE);
    if (!one.ok) throw new Error("unreachable");
    expect(one.value.timedOut).toBe(1);

    const all = await contract.sweepAllApprovals();
    if (!all.ok) throw new Error("unreachable");
    expect(all.value.totalTimedOut).toBe(0);
  });

  it("publishes an erasure target named for this context", () => {
    expect(contract.erasureTarget().targetName).toBe("jobs");
  });
});
