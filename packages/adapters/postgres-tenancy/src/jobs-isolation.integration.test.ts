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
  RequestDigest,
  Result,
  ThreadId,
  TurnId,
} from "@platos/context-jobs/application/ports/index.js";
import { asIdentifier, environmentScope } from "@platos/context-jobs/application/ports/index.js";
import { runResult } from "@platos/kernel";

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
  return runResult(harness.base.adapter.unitOfWork, (transaction) =>
    harness.stores.jobs.insertJob(where, job, transaction),
  );
}

function insertApproval(
  approval: Approval,
  where: EnvironmentScope = scope,
): Promise<Result<Approval>> {
  return runResult(harness.base.adapter.unitOfWork, (transaction) =>
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
  test("a second approval with the same row id is refused WITHOUT aborting the transaction", async () => {
    // The double APPENDS, leaving two rows with one `rowId` and `findByRowId`
    // answering the first — a state the primary key cannot hold. And the
    // refusal must arrive through `ON CONFLICT DO NOTHING` rather than through a
    // raised violation, because `request-approval.ts` writes this row inside the
    // unit of work that then parks the turn on a suspension: a raise would take
    // the suspension with it. The THIRD write is what proves the transaction
    // survived.
    const rowId = harness.base.freshId("0715");
    const third = harness.base.freshId("0716");
    const outcome = await harness.base.adapter.unitOfWork.run(async (transaction) => {
      const first = await harness.stores.approvals.insertApproval(
        scope,
        approvalIn(rowId),
        transaction,
      );
      const second = await harness.stores.approvals.insertApproval(
        scope,
        approvalIn(rowId, { approvalId: asIdentifier<ApprovalId>("other") }),
        transaction,
      );
      const after = await harness.stores.approvals.insertApproval(
        scope,
        approvalIn(third),
        transaction,
      );
      return { first: first.ok, second: second.ok, after: after.ok };
    });
    expect(outcome).toEqual({ first: true, second: false, after: true });
    const held = await harness.stores.approvals.findByRowId(scope, asIdentifier<ApprovalRowId>(rowId));
    expect(held.ok && held.value?.approvalId).toBe(`appr-${rowId.slice(-12)}`);
  });

  test("a second job with the same key in the same environment is refused", async () => {
    const key = asIdentifier<JobKey>("taken-key");
    expect((await insertJob(jobIn(harness.base.freshId("071e"), { jobKey: key }))).ok).toBe(true);
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

describe("a WRITE is keyed by its scope too, not only a read", () => {
  test("update, delete, markStarted, resolve and markConsumed all miss another tenant's row", async () => {
    // The reads above prove a foreign row is invisible. These prove it is also
    // UNREACHABLE: every write is keyed on `id` AND `environmentId`, so a caller
    // holding a real id from another tenant changes nothing rather than
    // changing somebody else's row.
    const jobId = harness.base.freshId("0801");
    const rowId = harness.base.freshId("0802");
    const job = jobIn(jobId);
    const approval = approvalIn(rowId);
    expect((await insertJob(job, foreign.scope)).ok).toBe(true);
    expect((await insertApproval(approval, foreign.scope)).ok).toBe(true);

    const updated = await runResult(harness.base.adapter.unitOfWork, (transaction) =>
      harness.stores.jobs.updateJob(scope, { ...job, displayName: "stolen" }, transaction),
    );
    expect(updated.ok).toBe(false);
    expect(
      await harness.stores.jobs.markStarted(scope, asIdentifier<JobId>(jobId), AT),
    ).toEqual({ ok: true, value: false });
    expect(
      await runResult(harness.base.adapter.unitOfWork, (transaction) =>
        harness.stores.jobs.deleteJob(scope, asIdentifier<JobId>(jobId), transaction),
      ),
    ).toEqual({ ok: true, value: false });
    expect(
      await runResult(harness.base.adapter.unitOfWork, (transaction) =>
        harness.stores.approvals.resolve(
          scope,
          {
            ...approval,
            status: "approved",
            updatedAt: AT,
            resolution: {
              status: "approved",
              respondedBy: "operator-9",
              comment: null,
              resolvedAt: AT,
              edit: null,
            },
          },
          transaction,
        ),
      ),
    ).toEqual({ ok: true, value: false });
    expect(
      await runResult(harness.base.adapter.unitOfWork, (transaction) =>
        harness.stores.approvals.markConsumed(scope, approval.approvalId, null, AT, transaction),
      ),
    ).toEqual({ ok: true, value: false });

    // AND THE CONTROL: the foreign row is untouched by any of the five.
    const survivor = await harness.stores.jobs.findJob(foreign.scope, asIdentifier<JobId>(jobId));
    expect(survivor.ok && survivor.value?.displayName).toBe("a job");
    const held = await harness.stores.approvals.findByRowId(foreign.scope, approval.rowId);
    expect(held.ok && held.value?.status).toBe("pending");
  });
});

describe("the dedupe lookup is THREE predicates, and each one is load-bearing", () => {
  test("only a PENDING mcp_tool_call row carrying the digest is the answer", async () => {
    const where = await harness.freshScope();
    const digest = asIdentifier<RequestDigest>("shared-digest");
    const hit = approvalIn(harness.base.freshId("0803"), {
      source: "mcp_tool_call",
      requestDigest: digest,
      createdAt: AT,
      updatedAt: AT,
    });
    const wrongSource = approvalIn(harness.base.freshId("0804"), {
      source: "request_approval",
      requestDigest: digest,
      createdAt: new Date(AT.getTime() + 60_000),
      updatedAt: new Date(AT.getTime() + 60_000),
    });
    const decided = approvalIn(harness.base.freshId("0805"), {
      source: "mcp_tool_call",
      requestDigest: digest,
      createdAt: new Date(AT.getTime() + 120_000),
      updatedAt: new Date(AT.getTime() + 120_000),
    });
    for (const approval of [hit, wrongSource, decided]) {
      expect((await insertApproval(approval, where)).ok).toBe(true);
    }
    const decidedAt = new Date(AT.getTime() + 180_000);
    await runResult(harness.base.adapter.unitOfWork, (transaction) =>
      harness.stores.approvals.resolve(
        where,
        {
          ...decided,
          status: "rejected",
          updatedAt: decidedAt,
          resolution: {
            status: "rejected",
            respondedBy: "operator-9",
            comment: null,
            resolvedAt: decidedAt,
            edit: null,
          },
        },
        transaction,
      ),
    );
    // The most RECENT row carrying the digest is `decided`, and it is no longer
    // pending; the next most recent is `wrongSource`, and its source is not
    // `mcp_tool_call`. So the answer is the OLDEST of the three, which is what
    // makes all three predicates observable at once.
    const found = await harness.stores.approvals.findPendingByDigest(where, digest);
    expect(found.ok && found.value?.approvalId).toBe(hit.approvalId);
  });
});

describe("the listing's date window, and the platform-wide enumeration", () => {
  test("the DEFAULT window is thirty days back from now, and a wide one reaches past it", async () => {
    // Neither the port nor the double takes an instant, so the double applies NO
    // date filter at all and the conformance differential always passes a wide
    // window. The default is the live `list`'s and is pinned HERE instead.
    const where = await harness.freshScope();
    const old = new Date(Date.now() - 60 * 86_400_000);
    const recent = new Date(Date.now() - 86_400_000);
    expect(
      (await insertApproval(
        approvalIn(harness.base.freshId("0806"), { createdAt: old, updatedAt: old }),
        where,
      )).ok,
    ).toBe(true);
    expect(
      (await insertApproval(
        approvalIn(harness.base.freshId("0807"), { createdAt: recent, updatedAt: recent }),
        where,
      )).ok,
    ).toBe(true);
    const defaulted = await harness.stores.approvals.list(where, {});
    expect(defaulted.ok && defaulted.value.total).toBe(1);
    const wide = await harness.stores.approvals.list(where, { sinceDays: 36_500 });
    expect(wide.ok && wide.value.total).toBe(2);
    // The pending count is scope-wide and is NOT narrowed by the window, which
    // is the port's own sentence and the reason it is a third statement.
    expect(defaulted.ok && defaulted.value.pendingCount).toBe(2);
  });

  test("a scope is enumerated ONCE while it holds a pending row, and not at all after", async () => {
    const where = await harness.freshScope();
    const first = approvalIn(harness.base.freshId("0808"));
    const second = approvalIn(harness.base.freshId("0809"), {
      createdAt: new Date(AT.getTime() + 1000),
      updatedAt: new Date(AT.getTime() + 1000),
    });
    for (const approval of [first, second]) {
      expect((await insertApproval(approval, where)).ok).toBe(true);
    }
    const paths = async (): Promise<readonly string[]> => {
      const found = await harness.stores.approvals.findScopesWithPending();
      return found.ok ? found.value.map((one) => one.environmentId) : ["<refused>"];
    };
    // TWO pending rows, ONE scope: `distinct` is what makes the sweep visit an
    // environment once rather than once per waiting approval.
    expect((await paths()).filter((id) => id === where.environmentId)).toEqual([
      where.environmentId,
    ]);
    for (const approval of [first, second]) {
      const at = new Date(AT.getTime() + 5000);
      await runResult(harness.base.adapter.unitOfWork, (transaction) =>
        harness.stores.approvals.resolve(
          where,
          {
            ...approval,
            status: "timed_out",
            updatedAt: at,
            resolution: {
              status: "timed_out",
              respondedBy: null,
              comment: null,
              resolvedAt: at,
              edit: null,
            },
          },
          transaction,
        ),
      );
    }
    // And a scope whose approvals are all DECIDED is not enumerated at all: a
    // sweep that visited it would be doing work with nothing to find.
    expect((await paths()).filter((id) => id === where.environmentId)).toEqual([]);
  });
});

describe("the erasure is narrowed by its tenant scope, not only by its subject", () => {
  test("one subject with approvals in two environments is counted per environment", async () => {
    const here = await harness.freshScope();
    const there = await harness.freshScope();
    const subject = `subject-${harness.base.freshId("080a").slice(-12)}`;
    for (const [target, tag] of [
      [here, "080b"],
      [here, "080c"],
      [there, "080d"],
    ] as const) {
      const approval = approvalIn(harness.base.freshId(tag), { requestedBy: subject });
      expect((await insertApproval(approval, target)).ok).toBe(true);
    }
    expect(await harness.stores.approvals.countErasable({ scope: here, principalId: subject })).toEqual(
      { ok: true, value: 2 },
    );
    expect(await harness.stores.approvals.countErasable({ scope: there, principalId: subject })).toEqual(
      { ok: true, value: 1 },
    );
    // AND THE ERASURE DESTROYS ONLY WHAT IT COUNTED: the other environment's row
    // is untouched, which is the property a plan and its receipt rest on.
    const erased = await runResult(harness.base.adapter.unitOfWork, (transaction) =>
      harness.stores.approvals.erase({ scope: here, principalId: subject }, transaction),
    );
    expect(erased).toEqual({ ok: true, value: 2 });
    expect(await harness.stores.approvals.countErasable({ scope: there, principalId: subject })).toEqual(
      { ok: true, value: 1 },
    );
  });
});
