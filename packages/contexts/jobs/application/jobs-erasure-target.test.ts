import { asIdentifier, organizationScope, type ErasureSubject } from "@platos/kernel";
import { beforeEach, describe, expect, it } from "vitest";

import type { ApprovalId } from "../domain/index.js";
import {
  APPROVAL_MODEL,
  createJobsErasureTarget,
  isJobsErasurePlan,
  JOB_MODEL,
  JOBS_ERASURE_TARGET_NAME,
  JobsErasureRejected,
  selectorFor,
  selectorIsVacuous,
} from "./jobs-erasure-target.js";
import { requestApproval } from "./request-approval.js";
import {
  anApprovalRequest,
  buildJobsTestContext,
  testEnvironmentScope,
  type JobsTestContext,
} from "./testing/index.js";

const SCOPE = testEnvironmentScope("env-1");

function subject(kind: ErasureSubject["subjectKind"], id = "user-1"): ErasureSubject {
  return { subjectKind: kind, subjectId: id, scope: SCOPE };
}

describe("selectorFor", () => {
  it("matches a user subject by principal id", () => {
    expect(selectorFor(subject("user"))).toEqual({ scope: SCOPE, principalId: "user-1" });
  });

  it("matches an end-user subject by principal id", () => {
    expect(selectorFor(subject("end-user"))).toEqual({ scope: SCOPE, principalId: "user-1" });
  });

  it("matches NOTHING for an entity subject — this context owns no entity-keyed row", () => {
    const selector = selectorFor(subject("entity"));
    expect(selector.principalId).toBeNull();
    expect(selectorIsVacuous(selector)).toBe(true);
  });
});

describe("plan", () => {
  let context: JobsTestContext;

  beforeEach(() => {
    context = buildJobsTestContext();
  });

  it("names both owned models, so neither looks unconsidered", async () => {
    const target = createJobsErasureTarget(context.dependencies);
    const plan = await target.plan(subject("user"));
    expect(plan.targetName).toBe(JOBS_ERASURE_TARGET_NAME);
    expect(plan.items.map((item) => item.model)).toEqual([APPROVAL_MODEL, JOB_MODEL]);
  });

  it("always reports Job as a ZERO-count item — a job is owned by an environment", async () => {
    const target = createJobsErasureTarget(context.dependencies);
    await requestApproval(context.dependencies, {
      scope: SCOPE,
      request: anApprovalRequest({ requestedBy: "user-1" }),
    });
    const plan = await target.plan(subject("user"));
    const job = plan.items.find((item) => item.model === JOB_MODEL);
    expect(job?.rowCount).toBe(0);
  });

  it("counts the subject's approvals", async () => {
    await requestApproval(context.dependencies, {
      scope: SCOPE,
      request: anApprovalRequest({ requestedBy: "user-1" }),
    });
    await requestApproval(context.dependencies, {
      scope: SCOPE,
      request: anApprovalRequest({
        approvalId: asIdentifier<ApprovalId>("appr-0002"),
        requestedBy: "someone-else",
      }),
    });

    const target = createJobsErasureTarget(context.dependencies);
    const plan = await target.plan(subject("user"));
    expect(plan.items.find((item) => item.model === APPROVAL_MODEL)?.rowCount).toBe(1);
  });

  it("reaches environments beneath an ORGANIZATION-addressed subject", async () => {
    await requestApproval(context.dependencies, {
      scope: SCOPE,
      request: anApprovalRequest({ requestedBy: "user-1" }),
    });
    const target = createJobsErasureTarget(context.dependencies);
    const plan = await target.plan({
      subjectKind: "user",
      subjectId: "user-1",
      scope: organizationScope(asIdentifier("org-1")),
    });
    expect(plan.items.find((item) => item.model === APPROVAL_MODEL)?.rowCount).toBe(1);
  });

  it("does NOT reach another organization's rows", async () => {
    await requestApproval(context.dependencies, {
      scope: SCOPE,
      request: anApprovalRequest({ requestedBy: "user-1" }),
    });
    const target = createJobsErasureTarget(context.dependencies);
    const plan = await target.plan({
      subjectKind: "user",
      subjectId: "user-1",
      scope: organizationScope(asIdentifier("org-2")),
    });
    expect(plan.items.find((item) => item.model === APPROVAL_MODEL)?.rowCount).toBe(0);
  });

  it("leaves blockedBy null — privacy adjudicates holds, not this context", async () => {
    const target = createJobsErasureTarget(context.dependencies);
    const plan = await target.plan(subject("user"));
    for (const item of plan.items) expect(item.blockedBy).toBeNull();
  });

  it("carries its subject so a stateless target can act on the plan later", async () => {
    const target = createJobsErasureTarget(context.dependencies);
    const plan = await target.plan(subject("user"));
    expect(isJobsErasurePlan(plan)).toBe(true);
  });

  it("does NOT mutate while planning", async () => {
    await requestApproval(context.dependencies, {
      scope: SCOPE,
      request: anApprovalRequest({ requestedBy: "user-1" }),
    });
    const target = createJobsErasureTarget(context.dependencies);
    await target.plan(subject("user"));
    expect(context.approvals.size()).toBe(1);
  });
});

describe("erase", () => {
  let context: JobsTestContext;

  beforeEach(async () => {
    context = buildJobsTestContext();
    await requestApproval(context.dependencies, {
      scope: SCOPE,
      request: anApprovalRequest({ requestedBy: "user-1" }),
    });
    await requestApproval(context.dependencies, {
      scope: SCOPE,
      request: anApprovalRequest({
        approvalId: asIdentifier<ApprovalId>("appr-0002"),
        requestedBy: "someone-else",
      }),
    });
  });

  it("destroys the subject's approvals and leaves everyone else's", async () => {
    const target = createJobsErasureTarget(context.dependencies);
    const plan = await target.plan(subject("user"));
    const receipt = await target.erase(plan, { transactionId: asIdentifier("txn-1") });

    expect(receipt.items.find((item) => item.model === APPROVAL_MODEL)?.rowCount).toBe(1);
    expect(context.approvals.size()).toBe(1);
  });

  it("REFUSES a plan it did not mint rather than guessing a subject", async () => {
    const target = createJobsErasureTarget(context.dependencies);
    await expect(
      target.erase(
        { targetName: "files", items: [] },
        { transactionId: asIdentifier("txn-1") },
      ),
    ).rejects.toBeInstanceOf(JobsErasureRejected);
  });

  it("REFUSES a plan bearing this target's name but no subject", async () => {
    const target = createJobsErasureTarget(context.dependencies);
    await expect(
      target.erase(
        { targetName: JOBS_ERASURE_TARGET_NAME, items: [] },
        { transactionId: asIdentifier("txn-1") },
      ),
    ).rejects.toBeInstanceOf(JobsErasureRejected);
  });

  it("erases nothing for an entity subject and says so truthfully", async () => {
    const target = createJobsErasureTarget(context.dependencies);
    const plan = await target.plan(subject("entity"));
    const receipt = await target.erase(plan, { transactionId: asIdentifier("txn-1") });
    expect(receipt.items.find((item) => item.model === APPROVAL_MODEL)?.rowCount).toBe(0);
    expect(context.approvals.size()).toBe(2);
  });

  it("REJECTS rather than issuing a receipt claiming rows went when the store failed", async () => {
    const target = createJobsErasureTarget(context.dependencies);
    const plan = await target.plan(subject("user"));
    context.approvals.failNext("store down");
    await expect(target.erase(plan, { transactionId: asIdentifier("txn-1") })).rejects.toBeInstanceOf(
      JobsErasureRejected,
    );
  });

  it("also matches the operator who RESPONDED, not only the requester", async () => {
    const fresh = buildJobsTestContext();
    await requestApproval(fresh.dependencies, {
      scope: SCOPE,
      request: anApprovalRequest({ requestedBy: "requester-1" }),
    });
    const stored = await fresh.approvals.findByApprovalId(SCOPE, asIdentifier<ApprovalId>("appr-0001"));
    if (!stored.ok || stored.value === null) throw new Error("unreachable");
    await fresh.approvals.resolve(
      SCOPE,
      {
        ...stored.value,
        status: "approved",
        resolution: {
          status: "approved",
          respondedBy: "operator-9",
          comment: null,
          resolvedAt: fresh.clock.now(),
          edit: null,
        },
      },
      { transactionId: asIdentifier("txn-1") },
    );

    const target = createJobsErasureTarget(fresh.dependencies);
    const plan = await target.plan(subject("user", "operator-9"));
    expect(plan.items.find((item) => item.model === APPROVAL_MODEL)?.rowCount).toBe(1);
  });
});
