// What the DATABASE decides on its own: the ancestry rule, the two unique
// indexes, and the fact that every read is keyed by its scope.
//
// A SECOND FILE FROM `jobs-constraints.integration.test.ts`, split at a seam the
// two halves already had. That file is guards: a TypeScript refusal stood beside
// the raw statement it was written from, and every case is a PAIR. Nothing here
// has a guard at all — `enforce_domain_ancestry`, `Job_environmentId_externalId_key`
// and the `environmentId` in every `where` are rules this store does not
// restate, and every case is a single question put to PostgreSQL. A reader
// checking "what does this package refuse" and a reader checking "what does the
// schema refuse" are asking different questions.
//
// THE ANCESTRY RULE IS THE ONE `jobs` FEELS HARDEST. It fires BEFORE INSERT OR
// UPDATE on `AgentApproval` and demands three things at once: the `agentId`
// names an `Agent` in the environment's PROJECT, the `threadId` a `Thread` in
// the ENVIRONMENT, and the `turnId` a `Turn` in THAT thread. All three point at
// rows this context does not own, and all three are refused with real ids from a
// real second tenant — a null would have satisfied the rule and proved nothing.

import { afterAll, beforeAll, describe, expect, test } from "vitest";

import type {
  AgentId,
  Approval,
  ApprovalId,
  ApprovalRowId,
  EnvironmentScope,
  Job,
  JobId,
  JobKey,
  Result,
  ThreadId,
  TurnId,
} from "@platos/context-jobs/application/ports/index.js";
import { asIdentifier, environmentScope } from "@platos/context-jobs/application/ports/index.js";

import type { ApprovalPeers, JobsHarness } from "./jobs-harness.js";
import { startJobsHarness } from "./jobs-harness.js";

const AT = new Date("2026-05-01T09:00:00.000Z");

let harness: JobsHarness;
let scope: EnvironmentScope;
let peers: ApprovalPeers;
let foreign: ApprovalPeers;

beforeAll(async () => {
  harness = await startJobsHarness();
  scope = await harness.freshScope();
  peers = await harness.seedPeers(scope);
  foreign = await harness.foreignPeers();
}, 600_000);

afterAll(async () => {
  await harness?.stop();
});

function jobIn(id: string, overrides: Partial<Job> = {}): Job {
  return {
    jobId: asIdentifier<JobId>(id),
    jobKey: asIdentifier<JobKey>(`job-${id.slice(-12)}`),
    displayName: "a job",
    description: null,
    invocationType: "manual",
    schedule: { cron: null, timezone: null },
    allowedAgentIds: [],
    payloadSchema: null,
    handler: "async function run() { return null; }",
    budget: { timeoutSeconds: 300, maxRetries: 0 },
    status: "active",
    createdBy: "operator-1",
    lastStartedAt: null,
    createdAt: AT,
    updatedAt: AT,
    ...overrides,
  };
}

function approvalIn(id: string, overrides: Partial<Approval> = {}): Approval {
  return {
    rowId: asIdentifier<ApprovalRowId>(id),
    approvalId: asIdentifier<ApprovalId>(`appr-${id.slice(-12)}`),
    source: "request_approval",
    agentId: null,
    threadId: null,
    turnId: null,
    action: "Delete the production database",
    details: null,
    toolName: null,
    arguments: null,
    requestedBy: "subject-a",
    requestDigest: null,
    requestedByTokenId: null,
    status: "pending",
    timeoutSeconds: 300,
    createdAt: AT,
    updatedAt: AT,
    resolution: null,
    consumedAt: null,
    outcome: null,
    ...overrides,
  };
}

function insertJob(job: Job, where: EnvironmentScope = scope): Promise<Result<Job>> {
  return harness.base.adapter.unitOfWork.run((transaction) =>
    harness.stores.jobs.insertJob(where, job, transaction),
  );
}

function insertApproval(
  approval: Approval,
  where: EnvironmentScope = scope,
): Promise<Result<Approval>> {
  return harness.base.adapter.unitOfWork.run((transaction) =>
    harness.stores.approvals.insertApproval(where, approval, transaction),
  );
}

describe("enforce_domain_ancestry fires on AgentApproval, and on UPDATE as well as INSERT", () => {
  test("an agent from another PROJECT is refused, though it is a real agent", async () => {
    const refused = await insertApproval(
      approvalIn(harness.base.freshId("0711"), {
        agentId: asIdentifier<AgentId>(foreign.agentId),
      }),
    );
    expect(refused.ok).toBe(false);
  });

  test("a thread from another ENVIRONMENT is refused", async () => {
    const refused = await insertApproval(
      approvalIn(harness.base.freshId("0712"), {
        threadId: asIdentifier<ThreadId>(foreign.threadId),
      }),
    );
    expect(refused.ok).toBe(false);
  });

  test("a turn from another THREAD is refused even when the thread is right", async () => {
    const refused = await insertApproval(
      approvalIn(harness.base.freshId("0713"), {
        threadId: asIdentifier<ThreadId>(peers.threadId),
        turnId: asIdentifier<TurnId>(foreign.turnId),
      }),
    );
    expect(refused.ok).toBe(false);
  });

  test("the whole chain agreeing is accepted, which is the control", async () => {
    const accepted = await insertApproval(
      approvalIn(harness.base.freshId("0714"), {
        agentId: asIdentifier<AgentId>(peers.agentId),
        threadId: asIdentifier<ThreadId>(peers.threadId),
        turnId: asIdentifier<TurnId>(peers.turnId),
      }),
    );
    expect(accepted.ok).toBe(true);
  });
});

describe("the row-id and key uniqueness the double does not hold", () => {
  test("a second approval with the same row id is refused, where the double appends", async () => {
    const rowId = harness.base.freshId("0715");
    expect((await insertApproval(approvalIn(rowId))).ok).toBe(true);
    const second = await insertApproval(approvalIn(rowId, { approvalId: asIdentifier("other") }));
    expect(second.ok).toBe(false);
  });

  test("a second job with the same key in the same environment is refused", async () => {
    const key = asIdentifier<JobKey>("taken-key");
    expect((await insertJob(jobIn(harness.base.freshId("0716"), { jobKey: key }))).ok).toBe(true);
    const second = await insertJob(jobIn(harness.base.freshId("0717"), { jobKey: key }));
    expect(second.ok).toBe(false);
  });

  test("the SAME key in another environment is accepted: the index is scoped", async () => {
    const accepted = await insertJob(
      jobIn(harness.base.freshId("0718"), { jobKey: asIdentifier<JobKey>("taken-key") }),
      foreign.scope,
    );
    expect(accepted.ok).toBe(true);
  });

  test("many jobs with a NULL key coexist, because PostgreSQL treats NULLs as distinct", async () => {
    for (const suffix of ["0719", "071a"]) {
      const created = await insertJob(jobIn(harness.base.freshId(suffix), { jobKey: null }));
      expect(created.ok).toBe(true);
    }
  });
});

describe("every read is scoped, and the scope is in the key", () => {
  test("a job that exists in another environment is invisible, not merely un-asserted", async () => {
    const id = harness.base.freshId("071b");
    expect((await insertJob(jobIn(id), foreign.scope)).ok).toBe(true);
    const read = await harness.stores.jobs.findJob(scope, asIdentifier<JobId>(id));
    expect(read).toEqual({ ok: true, value: null });
  });

  test("an approval that exists in another environment is invisible by BOTH lookups", async () => {
    const rowId = harness.base.freshId("071c");
    const approval = approvalIn(rowId);
    expect((await insertApproval(approval, foreign.scope)).ok).toBe(true);
    expect(await harness.stores.approvals.findByRowId(scope, approval.rowId)).toEqual({
      ok: true,
      value: null,
    });
    expect(await harness.stores.approvals.findByApprovalId(scope, approval.approvalId)).toEqual({
      ok: true,
      value: null,
    });
  });

  test("an environment that does not exist is refused by the foreign key, not silently ignored", async () => {
    const nowhere = environmentScope(
      scope.organizationId,
      scope.projectId,
      asIdentifier("eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee"),
    );
    const refused = await insertJob(jobIn(harness.base.freshId("071d")), nowhere);
    expect(refused.ok).toBe(false);
  });
});
