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

  // WHICH PROJECTION `describeJob` RETURNS WAS UNPINNED. `views.ts` argues that
  // making the safe projection the default is what stops "a new call site
  // leaking nothing by omission", and `registerJob` is asserted to honour it —
  // but nothing asserted it of the READ, which is the call a dashboard makes.
  // Swapping this one line to `toJobSourceView` publishes the handler source,
  // type-checks, and left all 354 tests green.
  it("describes an EXISTING job WITHOUT the handler — the safe projection is the default", async () => {
    const registered = await contract.registerJob(REGISTER);
    if (!registered.ok) throw new Error("unreachable");
    const described = await contract.describeJob({
      scope: SCOPE,
      jobId: asIdentifier<JobId>(registered.value.job.id),
    });
    if (!described.ok) throw new Error("unreachable");
    expect(described.value).not.toHaveProperty("handler");
    expect(JSON.stringify(described.value)).not.toContain(REGISTER.handler);
  });

  it("keeps the two reads DIFFERENT, so the source read is the only way to the source", async () => {
    const registered = await contract.registerJob(REGISTER);
    if (!registered.ok) throw new Error("unreachable");
    const query = { scope: SCOPE, jobId: asIdentifier<JobId>(registered.value.job.id) };
    const safe = await contract.describeJob(query);
    const source = await contract.readJobSource(query);
    if (!safe.ok || !source.ok) throw new Error("unreachable");
    // Same job, same fields — except the one that matters.
    expect(source.value).toMatchObject(safe.value);
    expect(Object.keys(source.value)).toContain("handler");
    expect(Object.keys(safe.value)).not.toContain("handler");
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

  // `markApprovalConsumed`'s not-found guard had no reachable caller: every
  // existing test consumes an approval that exists in the scope asked about, so
  // deleting the guard and going straight to the repository write left all 354
  // green. `markConsumed` reports a miss as `ok(false)`, which is
  // indistinguishable from "recorded nothing" — and the id is caller-supplied.
  it("REFUSES to consume an approval that does not exist, rather than reporting false", async () => {
    const marked = await contract.markApprovalConsumed({
      scope: SCOPE,
      approvalId: asIdentifier<ApprovalId>("appr-nope"),
      outcome: { deleted: 3 },
    });
    expect(marked.ok).toBe(false);
    if (marked.ok) throw new Error("unreachable");
    expect(marked.error.code).toBe("JOBS_APPROVAL_NOT_FOUND");
  });

  it("REFUSES to consume an approval that lives in ANOTHER environment", async () => {
    // The scoping consequence, and the reason `ok(false)` is not good enough: an
    // id from a neighbouring environment must be a refusal, not a quiet no-op
    // that a caller reads as "already done".
    const other = testEnvironmentScope("env-2");
    await contract.requestApproval({
      scope: other,
      approvalId: APPROVAL,
      source: "mcp_tool_call",
      action: "Delete everything",
    });
    const marked = await contract.markApprovalConsumed({
      scope: SCOPE,
      approvalId: APPROVAL,
      outcome: { deleted: 3 },
    });
    expect(marked.ok).toBe(false);
    if (marked.ok) throw new Error("unreachable");
    expect(marked.error.code).toBe("JOBS_APPROVAL_NOT_FOUND");
    // And the neighbour's row is untouched.
    const neighbour = await contract.describeApproval(other, APPROVAL);
    if (!neighbour.ok) throw new Error("unreachable");
    expect(neighbour.value.consumedAt).toBeNull();
  });

  // `mcpActionLabel` had NO caller anywhere in the repository. It exists so the
  // string a human reads in the approval queue has one definition; a definition
  // nothing calls has none. It is now the contract's default for the MCP path.
  it("defaults an MCP tool call's action to the canonical label", async () => {
    await contract.requestApproval({
      scope: SCOPE,
      approvalId: APPROVAL,
      source: "mcp_tool_call",
      toolName: "files.delete",
    });
    const described = await contract.describeApproval(SCOPE, APPROVAL);
    if (!described.ok) throw new Error("unreachable");
    expect(described.value.action).toBe("MCP tool call: files.delete");
  });

  it("never overwrites an action the caller supplied", async () => {
    await contract.requestApproval({
      scope: SCOPE,
      approvalId: APPROVAL,
      source: "mcp_tool_call",
      toolName: "files.delete",
      action: "Delete the Q3 export",
    });
    const described = await contract.describeApproval(SCOPE, APPROVAL);
    if (!described.ok) throw new Error("unreachable");
    expect(described.value.action).toBe("Delete the Q3 export");
  });

  it("REFUSES an approval with neither an action nor a tool name to derive one", async () => {
    // An approval whose action is blank is a question no human can answer.
    // Defaulting it to something plausible would put that question in front of
    // one anyway.
    const opened = await contract.requestApproval({
      scope: SCOPE,
      approvalId: APPROVAL,
      source: "request_approval",
      action: "   ",
    });
    expect(opened.ok).toBe(false);
    if (opened.ok) throw new Error("unreachable");
    expect(opened.error.code).toBe("INVALID_REQUEST");
    const described = await contract.describeApproval(SCOPE, APPROVAL);
    expect(described.ok).toBe(false);
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
