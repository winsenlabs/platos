// The transaction boundary, proved by FAILURE INJECTION against a real database,
// and the three scope refusals.
//
// WHY INJECTION AND NOT A ROLLBACK COUNT. A store that counted rollbacks would
// pass a suite that asserted rollbacks. Every case below forces the SECOND write
// of a multi-write unit to fail and then LOOKS FOR THE FIRST ROW — over a second
// client, on a connection this adapter's pool never touched, because durability
// is not "the row is there when the writer looks again" but "the row is there
// when somebody else looks".
//
// AND THE OTHER HALF IS THE ONE THAT SHIPPED IN `cost-monitoring`. A returned
// error `Result` RESOLVES, and a callback that resolves COMMITS. That context's
// `detect-crossings.ts` returned an error from inside `unitOfWork.run` on a
// fan-out failure and left exactly the stranded row the file was written to
// prevent. So this suite pins BOTH answers, and for `jobs` they differ by which
// refusal you got:
//
//   A refusal the STORE minted — a guard, a scope check, a zero-count update —
//   leaves the transaction healthy, and everything written before it COMMITS.
//
//   A refusal the DATABASE minted — `enforce_domain_ancestry` on an approval
//   whose agent belongs to another project — has already put the transaction
//   into the aborted state, so the COMMIT the resolved callback asks for is
//   executed as a ROLLBACK and everything written before it is gone.
//
// Both are correct and neither is obvious, and a caller that assumed the first
// while getting the second would report success for rows that no longer exist.
//
// THE PAIR THAT MATTERS MOST FOR THIS CONTEXT IS `resolve` + THE RESUMPTION.
// `resolve-approval.ts` records a human's decision and then resumes the run
// parked on a `DurableRuntime` suspension, inside ONE unit of work. The case
// below stands in for the resumption with a throw, because a suspension is not
// this package's to hold — and the property is the same: a decision that could
// not be acted on is a decision that must not be recorded.

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
  ThreadId,
  TurnId,
} from "@platos/context-jobs/application/ports/index.js";
import { asIdentifier, environmentScope } from "@platos/context-jobs/application/ports/index.js";
import type { TransactionId } from "@platos/context-tenancy/application/ports/index.js";
import { asIdentifier as asTenancyIdentifier } from "@platos/context-tenancy/application/ports/index.js";
import { runResult } from "@platos/kernel";

import type { TenancyDatabaseClient } from "./client.js";
import type { ApprovalPeers, JobsHarness } from "./jobs-harness.js";
import { startJobsHarness } from "./jobs-harness.js";
import {
  TRANSACTION_NOT_OPEN,
  TRANSACTION_SCOPE_FOREIGN,
  TRANSACTION_SCOPE_UNKNOWN,
} from "./transaction.js";

const AT = new Date("2026-05-01T09:00:00.000Z");

let harness: JobsHarness;
let peers: ApprovalPeers;
let foreign: ApprovalPeers;
let scope: EnvironmentScope;
/** A SECOND client over the same database. Nothing this adapter's pool touched. */
let observer: TenancyDatabaseClient;

beforeAll(async () => {
  harness = await startJobsHarness();
  scope = await harness.freshScope();
  peers = await harness.seedPeers(scope);
  foreign = await harness.foreignPeers();
  const { PrismaClient } = await import("@platos/tenancy-database");
  observer = new PrismaClient({
    datasources: { db: { url: harness.base.databaseUrl } },
  }) as TenancyDatabaseClient;
}, 600_000);

afterAll(async () => {
  await observer?.$disconnect();
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

/** Whether a row is visible to somebody who is not the writer. */
async function jobExists(id: string): Promise<boolean> {
  return (await observer.job.findUnique({ where: { id }, select: { id: true } })) !== null;
}

async function approvalExists(id: string): Promise<boolean> {
  return (
    (await observer.agentApproval.findUnique({ where: { id }, select: { id: true } })) !== null
  );
}

describe("a write the DATABASE refuses takes everything written before it with it", () => {
  test("neither row survives when the second write violates the ancestry rule", async () => {
    const first = harness.base.freshId("0601");
    const second = harness.base.freshId("0602");
    const outcome = await harness.base.adapter.unitOfWork.run(async (transaction) => {
      const good = await harness.stores.jobs.insertJob(scope, jobIn(first), transaction);
      // THE INJECTED FAILURE. The agent is real and belongs to another PROJECT,
      // which `enforce_domain_ancestry` on `AgentApproval` refuses — and the
      // refusal aborts the transaction the job is sitting in.
      const bad = await harness.stores.approvals.insertApproval(
        scope,
        approvalIn(second, { agentId: asIdentifier<AgentId>(foreign.agentId) }),
        transaction,
      );
      return { good: good.ok, bad: bad.ok };
    });
    expect(outcome).toEqual({ good: true, bad: false });
    expect(await jobExists(first)).toBe(false);
    expect(await approvalExists(second)).toBe(false);
  });

  test("the negative control: both writes land when neither is refused", async () => {
    // WITHOUT THIS, the case above passes against a store that never commits
    // anything at all.
    const first = harness.base.freshId("0603");
    const second = harness.base.freshId("0604");
    await harness.base.adapter.unitOfWork.run(async (transaction) => {
      await harness.stores.jobs.insertJob(scope, jobIn(first), transaction);
      await harness.stores.approvals.insertApproval(
        scope,
        approvalIn(second, {
          agentId: asIdentifier<AgentId>(peers.agentId),
          threadId: asIdentifier<ThreadId>(peers.threadId),
          turnId: asIdentifier<TurnId>(peers.turnId),
        }),
        transaction,
      );
    });
    expect(await jobExists(first)).toBe(true);
    expect(await approvalExists(second)).toBe(true);
  });

  test("a throw from the callback rolls the decision and its resumption back together", async () => {
    // The shape `resolve-approval.ts` has: record the decision, then resume the
    // parked run. A resumption this package cannot perform is stood in for by a
    // throw, and the property is the one that matters — a decision that could
    // not be acted on is not left recorded.
    const rowId = harness.base.freshId("0605");
    await runResult(harness.base.adapter.unitOfWork, (transaction) =>
      harness.stores.approvals.insertApproval(scope, approvalIn(rowId), transaction),
    );
    const decidedAt = new Date("2026-05-01T10:00:00.000Z");
    await expect(
      harness.base.adapter.unitOfWork.run(async (transaction) => {
        const moved = await harness.stores.approvals.resolve(
          scope,
          {
            ...approvalIn(rowId),
            status: "approved",
            updatedAt: decidedAt,
            resolution: {
              status: "approved",
              respondedBy: "operator-9",
              comment: null,
              resolvedAt: decidedAt,
              edit: null,
            },
          },
          transaction,
        );
        expect(moved).toEqual({ ok: true, value: true });
        throw new Error("the parked run could not be resumed");
      }),
    ).rejects.toThrow("the parked run could not be resumed");
    const row = await observer.agentApproval.findUnique({
      where: { id: rowId },
      select: { status: true },
    });
    expect(row?.status).toBe("PENDING");
  });

  test("a throw rolls a job insert back", async () => {
    const first = harness.base.freshId("0606");
    await expect(
      harness.base.adapter.unitOfWork.run(async (transaction) => {
        await harness.stores.jobs.insertJob(scope, jobIn(first), transaction);
        throw new Error("injected");
      }),
    ).rejects.toThrow("injected");
    expect(await jobExists(first)).toBe(false);
  });
});

describe("a refusal the STORE minted resolves, and a resolved callback COMMITS", () => {
  test("a guard refusal leaves the earlier write committed", async () => {
    // THE `cost-monitoring` TRAP, measured here rather than assumed away. The
    // second call never reaches the database — the uuid guard refuses it — so
    // the transaction is healthy, the callback resolves, and the COMMIT is a
    // real commit. A use case that treated "I returned an error" as "nothing was
    // written" would be wrong about the first row.
    const first = harness.base.freshId("0607");
    const outcome = await harness.base.adapter.unitOfWork.run(async (transaction) => {
      await harness.stores.jobs.insertJob(scope, jobIn(first), transaction);
      const refused = await harness.stores.approvals.insertApproval(
        scope,
        // `anApproval()` in the context's own builders mints exactly this, and
        // every use-case suite in `packages/contexts/jobs` passes with it.
        approvalIn("appr-row-0001"),
        transaction,
      );
      return refused.ok;
    });
    expect(outcome).toBe(false);
    expect(await jobExists(first)).toBe(true);
  });

  test("a zero-count update leaves the earlier write committed too", async () => {
    // `updateJob` on a row that is not in this scope answers `err` from a
    // `count === 0`, not from a raised statement — so the transaction survives
    // and the job written before it commits.
    const first = harness.base.freshId("0608");
    const outcome = await harness.base.adapter.unitOfWork.run(async (transaction) => {
      await harness.stores.jobs.insertJob(scope, jobIn(first), transaction);
      const refused = await harness.stores.jobs.updateJob(
        scope,
        jobIn(harness.base.freshId("0609")),
        transaction,
      );
      return refused.ok;
    });
    expect(outcome).toBe(false);
    expect(await jobExists(first)).toBe(true);
  });

  test("the duplicate-key insert refuses WITHOUT aborting the transaction", async () => {
    // THE WHOLE REASON `insertJob` GOES THROUGH `ON CONFLICT DO NOTHING`. A
    // raised unique violation would have left the caller unable to write
    // anything else for the rest of the block; this refusal leaves the earlier
    // row committed and the transaction usable, which the third write proves.
    const first = harness.base.freshId("060a");
    const third = harness.base.freshId("060c");
    const outcome = await harness.base.adapter.unitOfWork.run(async (transaction) => {
      const seed = jobIn(first);
      await harness.stores.jobs.insertJob(scope, seed, transaction);
      const clash = await harness.stores.jobs.insertJob(
        scope,
        { ...jobIn(harness.base.freshId("060b")), jobKey: seed.jobKey },
        transaction,
      );
      const after = await harness.stores.jobs.insertJob(scope, jobIn(third), transaction);
      return { clash: clash.ok, after: after.ok };
    });
    expect(outcome).toEqual({ clash: false, after: true });
    expect(await jobExists(first)).toBe(true);
    expect(await jobExists(third)).toBe(true);
  });
});

describe("the three scope refusals", () => {
  test("a write with no open transaction is not_open", async () => {
    // The scope is well-formed and no transaction is open, which is a DIFFERENT
    // mistake from carrying a token whose transaction has finished.
    const outside = { transactionId: asTenancyIdentifier<TransactionId>("pg-txn-none") };
    await expect(
      harness.stores.jobs.insertJob(scope, jobIn(harness.base.freshId("060d")), outside),
    ).rejects.toMatchObject({ code: TRANSACTION_NOT_OPEN });
  });

  test("a token whose transaction has already finished is scope_unknown", async () => {
    let expired = { transactionId: asTenancyIdentifier<TransactionId>("pg-txn-none") };
    await harness.base.adapter.unitOfWork.run(async (transaction) => {
      expired = transaction as typeof expired;
    });
    await harness.base.adapter.unitOfWork.run(async () => {
      await expect(
        harness.stores.approvals.insertApproval(
          scope,
          approvalIn(harness.base.freshId("060e")),
          expired,
        ),
      ).rejects.toMatchObject({ code: TRANSACTION_SCOPE_UNKNOWN });
    });
  });

  test("another live transaction's token is scope_foreign", async () => {
    // The second transaction is opened OUTSIDE any ambient frame and held open
    // while the first tries to write with its token, so BOTH are live and the
    // refusal cannot be the expired one.
    let release: () => void = () => undefined;
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    let other: { transactionId: TransactionId } | null = null;
    const heldTransaction = harness.base.adapter.unitOfWork.run(async (transaction) => {
      other = transaction as { transactionId: TransactionId };
      await held;
    });
    while (other === null) await new Promise((resolve) => setTimeout(resolve, 5));
    await harness.base.adapter.unitOfWork.run(async () => {
      await expect(
        harness.stores.approvals.erase(
          { scope, principalId: "subject-a" },
          other as unknown as { transactionId: TransactionId },
        ),
      ).rejects.toMatchObject({ code: TRANSACTION_SCOPE_FOREIGN });
    });
    release();
    await heldTransaction;
  });

  test("the three refusals carry three DISTINCT codes", () => {
    // Two guards returning one code cannot be told apart in a log, which is how
    // two defects hid behind one code in `privacy` and in `identity-access`.
    const codes = [TRANSACTION_NOT_OPEN, TRANSACTION_SCOPE_UNKNOWN, TRANSACTION_SCOPE_FOREIGN];
    expect(new Set(codes).size).toBe(3);
  });
});

describe("a READ joins the transaction it is issued inside", () => {
  test("a job written in this unit is visible to a read that carries no token", async () => {
    // THE AMBIENT FRAME, which is the property WIN-258 T1 built and which every
    // read on both of these ports depends on: `findJob` takes no
    // `TransactionScope`, so without it the read would go to the POOL and would
    // not see the row the same transaction just wrote.
    const first = harness.base.freshId("0610");
    const seen = await harness.base.adapter.unitOfWork.run(async (transaction) => {
      await harness.stores.jobs.insertJob(scope, jobIn(first), transaction);
      const read = await harness.stores.jobs.findJob(scope, asIdentifier<JobId>(first));
      return read.ok && read.value !== null;
    });
    expect(seen).toBe(true);
    // And an observer outside it can see it too, now that it has committed.
    expect(await jobExists(first)).toBe(true);
  });

  test("the same read from OUTSIDE the transaction does not see it", async () => {
    // The negative control for the case above: without it, "the read saw the
    // row" could be true because the row was already committed.
    const first = harness.base.freshId("0611");
    let visibleOutside = true;
    await expect(
      harness.base.adapter.unitOfWork.run(async (transaction) => {
        await harness.stores.jobs.insertJob(scope, jobIn(first), transaction);
        visibleOutside = await jobExists(first);
        throw new Error("injected");
      }),
    ).rejects.toThrow("injected");
    expect(visibleOutside).toBe(false);
  });
});
