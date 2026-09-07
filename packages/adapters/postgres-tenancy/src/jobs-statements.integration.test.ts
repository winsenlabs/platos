// Statement counts, MEASURED — the N+1 control for both of `jobs`' stores.
//
// EVERY PIN IS TAKEN TWICE, over a small environment and one an order of
// magnitude larger, and both must be identical. A read whose cost grows with the
// rows it returns is correct in every case and expensive in exactly one: the
// installation that has been running longest. `ApprovalsRepository.list` is what
// a dashboard opens with; `findPending` folds every pending row in a scope
// without paging at all; and `findScopesWithPending` runs PLATFORM-WIDE, which
// is where a per-scope query would be invisible until it was slow on the
// install with the most tenants.
//
// `findScopesWithPending` IS THE PIN THIS SUITE EXISTS FOR, AND IT IS THREE
// RATHER THAN ONE. The live `sweepExpiredAllScopes` reads its distinct
// environments and then calls `sweepExpired` ONCE PER SCOPE, which is an N+1 in
// the TENANT TREE rather than in the rows — and the port splits the enumeration
// from the sweep so the enumeration can be constant. It is: the client loads
// each relation level with a query of its own, so the cost is
// `AgentApproval -> Environment -> Project`, which the SCHEMA fixes at three.
// The case measures it at three scopes and at six and gets three both times,
// which is the property that matters; the number itself is the driver's
// relation-loading strategy and is reported rather than asserted away.
//
// THE ERASURE'S TENANT FILTER IS THE SECOND. `countErasable` takes a TENANT
// scope and every approval stores only its environment, so the containment is a
// relation filter through `Environment` and `Project` resolved inside the same
// statement. The obvious wrong implementation — read the environments the scope
// reaches, then one query per environment — is measured here at an ORGANIZATION
// scope precisely so the widening cannot hide.
//
// THE PROBE PATTERN IS ANCHORED, and that is tranche 3's trap rather than a
// precaution. Its advisory lock projected `SELECT 1`, which is exactly the shape
// these suites strip to discard the driver's connection probe, so the lock was
// measured at ZERO statements and a mutation that removed it survived. The
// filter below anchors the probe to a statement that is ONLY `SELECT 1`, and
// every measurement records the unfiltered count beside the filtered one.

import { afterAll, beforeAll, describe, expect, test } from "vitest";

import type {
  Approval,
  ApprovalId,
  ApprovalRowId,
  EnvironmentScope,
  Job,
  JobId,
  JobKey,
} from "@platos/context-jobs/application/ports/index.js";
import { asIdentifier, organizationScope } from "@platos/context-jobs/application/ports/index.js";
import { runResult } from "@platos/context-jobs/application/ports/index.js";

import type { JobsHarness } from "./jobs-harness.js";
import { startJobsHarness } from "./jobs-harness.js";

const AT = new Date("2026-05-01T09:00:00.000Z");
const WIDE = 36_500;

let harness: JobsHarness;

interface Fixture {
  readonly scope: EnvironmentScope;
  readonly jobIds: readonly string[];
  readonly approvals: readonly Approval[];
}

let small: Fixture;
let large: Fixture;

/**
 * Statements the CLIENT sent, less the transaction frame.
 *
 * `BEGIN`/`COMMIT`/`ROLLBACK`/`DEALLOCATE` are the driver's bookkeeping and are
 * not what an N+1 is made of. `SELECT 1` is the driver's connection probe and is
 * matched ONLY when the whole statement is that and nothing else, so a read that
 * genuinely projects a constant cannot be discarded by the thing measuring it.
 */
function queries(): readonly string[] {
  return harness.base
    .statements()
    .filter(
      (statement) =>
        !/^\s*(BEGIN|COMMIT|ROLLBACK|DEALLOCATE)\b/iu.test(statement) &&
        !/^\s*SELECT\s+1\s*$/iu.test(statement),
    );
}

interface Measurement {
  readonly counted: number;
  readonly total: number;
}

async function measure(work: () => Promise<unknown>): Promise<Measurement> {
  harness.base.resetStatements();
  await work();
  return { counted: queries().length, total: harness.base.statements().length };
}

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

function approvalIn(id: string, index: number): Approval {
  const at = new Date(AT.getTime() + index * 1000);
  return {
    rowId: asIdentifier<ApprovalRowId>(id),
    approvalId: asIdentifier<ApprovalId>(`appr-${id.slice(-12)}`),
    source: "mcp_tool_call",
    agentId: null,
    threadId: null,
    turnId: null,
    action: "Delete the production database",
    details: null,
    toolName: "web_search",
    arguments: { query: "platos" },
    requestedBy: "subject-a",
    requestDigest: asIdentifier(`digest-${index}`),
    requestedByTokenId: "tok-1",
    status: "pending",
    timeoutSeconds: 3600,
    createdAt: at,
    updatedAt: at,
    resolution: null,
    consumedAt: null,
    outcome: null,
  };
}

/** One environment carrying `count` jobs and `count` approvals. */
async function seedFixture(count: number, tag: string): Promise<Fixture> {
  const scope = await harness.freshScope();
  const jobIds: string[] = [];
  const approvals: Approval[] = [];
  for (let index = 0; index < count; index += 1) {
    const jobId = harness.base.freshId(tag);
    const rowId = harness.base.freshId(tag);
    jobIds.push(jobId);
    const approval = approvalIn(rowId, index);
    approvals.push(approval);
    await harness.base.adapter.unitOfWork.run(async (transaction) => {
      await harness.stores.jobs.insertJob(scope, jobIn(jobId), transaction);
      await harness.stores.approvals.insertApproval(scope, approval, transaction);
    });
  }
  return { scope, jobIds, approvals };
}

beforeAll(async () => {
  harness = await startJobsHarness();
  small = await seedFixture(2, "0801");
  large = await seedFixture(24, "0802");
}, 900_000);

afterAll(async () => {
  await harness?.stop();
});

/** Both fixtures must answer the same question in the same number of statements. */
async function bothCost(
  expected: number,
  work: (fixture: Fixture) => Promise<unknown>,
): Promise<void> {
  const cheap = await measure(() => work(small));
  const heavy = await measure(() => work(large));
  expect({ small: cheap.counted, large: heavy.counted }).toEqual({
    small: expected,
    large: expected,
  });
  // The unfiltered total is recorded beside it so a filter that swallowed a
  // real statement would be visible as a gap rather than as nothing.
  expect(cheap.total).toBeGreaterThanOrEqual(cheap.counted);
  expect(heavy.total).toBeGreaterThanOrEqual(heavy.counted);
}

describe("the Job store's reads are one statement each, whatever the environment holds", () => {
  test("listJobs is ONE statement over two rows and over twenty-four", async () => {
    await bothCost(1, (fixture) => harness.stores.jobs.listJobs(fixture.scope));
  });

  test("findJob and findJobByKey are ONE each", async () => {
    await bothCost(1, (fixture) =>
      harness.stores.jobs.findJob(fixture.scope, asIdentifier<JobId>(fixture.jobIds[0] as string)),
    );
    await bothCost(1, (fixture) =>
      harness.stores.jobs.findJobByKey(
        fixture.scope,
        asIdentifier<JobKey>(`job-${(fixture.jobIds[0] as string).slice(-12)}`),
      ),
    );
  });

  test("a miss costs the same as a hit", async () => {
    await bothCost(1, (fixture) =>
      harness.stores.jobs.findJob(
        fixture.scope,
        asIdentifier<JobId>("dddddddd-dddd-4ddd-8ddd-dddddddddddd"),
      ),
    );
  });
});

describe("the Job store's writes are one statement each", () => {
  test("insertJob, updateJob, markStarted and deleteJob are ONE apiece", async () => {
    const id = harness.base.freshId("0803");
    const insert = await measure(() =>
      runResult(harness.base.adapter.unitOfWork, (transaction) =>
        harness.stores.jobs.insertJob(small.scope, jobIn(id), transaction),
      ),
    );
    expect(insert.counted).toBe(1);

    const update = await measure(() =>
      runResult(harness.base.adapter.unitOfWork, (transaction) =>
        harness.stores.jobs.updateJob(
          small.scope,
          jobIn(id, { displayName: "renamed" }),
          transaction,
        ),
      ),
    );
    expect(update.counted).toBe(1);

    // `markStarted` resolves through `atomic()` rather than a caller's token, so
    // it opens a transaction of its own — and the BEGIN/COMMIT that frames it is
    // exactly what the filter above discards.
    const started = await measure(() =>
      harness.stores.jobs.markStarted(small.scope, asIdentifier<JobId>(id), AT),
    );
    expect(started.counted).toBe(1);
    expect(started.total).toBeGreaterThan(started.counted);

    const removed = await measure(() =>
      runResult(harness.base.adapter.unitOfWork, (transaction) =>
        harness.stores.jobs.deleteJob(small.scope, asIdentifier<JobId>(id), transaction),
      ),
    );
    expect(removed.counted).toBe(1);
  });
});

describe("the Approval store's reads", () => {
  test("list is THREE statements — the page, the total, the scope-wide pending count", async () => {
    // Three because they are three questions, and the port says the third is
    // "pending in the WHOLE scope, not just this page". A store that folded the
    // pending count into the page would answer a different number.
    await bothCost(3, (fixture) =>
      harness.stores.approvals.list(fixture.scope, { sinceDays: WIDE }),
    );
  });

  test("list stays THREE when the page is narrowed and when it is widened", async () => {
    await bothCost(3, (fixture) =>
      harness.stores.approvals.list(fixture.scope, { sinceDays: WIDE, limit: 1 }),
    );
    await bothCost(3, (fixture) =>
      harness.stores.approvals.list(fixture.scope, { sinceDays: WIDE, limit: 200 }),
    );
  });

  test("findPending folds every pending row in ONE statement", async () => {
    await bothCost(1, (fixture) => harness.stores.approvals.findPending(fixture.scope));
  });

  test("findByApprovalId resolves a JSON path in ONE statement", async () => {
    // A sequential scan over a JSONB column with no index behind it, which is a
    // property of the DEPLOYED schema rather than of this store. The index it
    // wants is a GIN index on `arguments` or an expression index on
    // `arguments -> '__platosApproval' ->> 'approvalId'`; this tranche adds no
    // migration and names it here instead.
    await bothCost(1, (fixture) =>
      harness.stores.approvals.findByApprovalId(
        fixture.scope,
        (fixture.approvals[0] as Approval).approvalId,
      ),
    );
  });

  test("findByRowId and findPendingByDigest are ONE each", async () => {
    await bothCost(1, (fixture) =>
      harness.stores.approvals.findByRowId(
        fixture.scope,
        (fixture.approvals[0] as Approval).rowId,
      ),
    );
    await bothCost(1, (fixture) =>
      harness.stores.approvals.findPendingByDigest(fixture.scope, asIdentifier("digest-0")),
    );
  });
});

describe("the platform-wide read, and the erasure's tenant filter", () => {
  test("findScopesWithPending costs the SAME whether three scopes are pending or six", async () => {
    // MEASURED AT THREE, NOT ONE, AND THE THREE ARE THE TENANT TREE'S DEPTH.
    // The port asks for the distinct environments holding a pending approval
    // AND the organization each one belongs to, and the client loads each
    // relation level with a query of its own — the approvals, then their
    // `Environment` rows, then those rows' `Project` rows. So the cost is
    // `AgentApproval -> Environment -> Project`, which the SCHEMA fixes, and
    // nothing here grows with the number of tenants.
    //
    // THAT IS THE PROPERTY THIS CASE EXISTS FOR, and it is the one the live
    // system does not have. `sweepExpiredAllScopes` reads its distinct
    // environments and then calls `sweepExpired` ONCE PER SCOPE — an N+1 in the
    // TENANT TREE, invisible until the install with the most tenants — which is
    // why the port splits the enumeration from the sweep. Three scopes and six
    // are measured below and both are THREE.
    const beforeCount = await harness.stores.approvals.findScopesWithPending();
    expect(beforeCount.ok && beforeCount.value.length).toBeGreaterThanOrEqual(2);
    const atThree = await measure(() => harness.stores.approvals.findScopesWithPending());

    for (const tag of ["0804", "0807", "0808"]) {
      const grown = await seedFixture(1, tag);
      expect(grown.approvals.length).toBe(1);
    }
    const atSix = await measure(() => harness.stores.approvals.findScopesWithPending());
    expect({ three: atThree.counted, six: atSix.counted }).toEqual({ three: 3, six: 3 });

    const found = await harness.stores.approvals.findScopesWithPending();
    expect(found.ok && found.value.length).toBeGreaterThanOrEqual(5);
  });

  test("countErasable is ONE statement at an ENVIRONMENT and at an ORGANIZATION", async () => {
    await bothCost(1, (fixture) =>
      harness.stores.approvals.countErasable({
        scope: fixture.scope,
        principalId: "subject-a",
      }),
    );
    await bothCost(1, (fixture) =>
      harness.stores.approvals.countErasable({
        scope: organizationScope(fixture.scope.organizationId),
        principalId: "subject-a",
      }),
    );
  });

  test("a subject-less selector costs NOTHING, because it sends no statement", async () => {
    const measured = await measure(() =>
      harness.stores.approvals.countErasable({ scope: small.scope, principalId: null }),
    );
    expect(measured.counted).toBe(0);
  });
});

describe("the Approval store's writes", () => {
  test("insertApproval and resolve are ONE apiece; markConsumed is TWO", async () => {
    const rowId = harness.base.freshId("0805");
    const approval = approvalIn(rowId, 0);
    const inserted = await measure(() =>
      runResult(harness.base.adapter.unitOfWork, (transaction) =>
        harness.stores.approvals.insertApproval(small.scope, approval, transaction),
      ),
    );
    expect(inserted.counted).toBe(1);

    // TWO, and the read is not avoidable the way `resolve`'s is: `consumedAt`
    // lives inside the `arguments` envelope beside the caller's own arguments,
    // and this method is handed the business id rather than the approval.
    const consumed = await measure(() =>
      runResult(harness.base.adapter.unitOfWork, (transaction) =>
        harness.stores.approvals.markConsumed(
          small.scope,
          approval.approvalId,
          { ok: true },
          AT,
          transaction,
        ),
      ),
    );
    expect(consumed.counted).toBe(2);

    // ONE, and that is the whole point of the port handing `resolve` the WHOLE
    // approval: the live implementation reads the row first to recover the
    // metadata it has to write back, and this one rebuilds it from the argument.
    const resolved = await measure(() =>
      runResult(harness.base.adapter.unitOfWork, (transaction) =>
        harness.stores.approvals.resolve(
          small.scope,
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
    );
    expect(resolved.counted).toBe(1);
  });

  test("erase destroys a whole subject in ONE statement, at either scope level", async () => {
    const doomed = await seedFixture(6, "0806");
    const measured = await measure(() =>
      runResult(harness.base.adapter.unitOfWork, (transaction) =>
        harness.stores.approvals.erase(
          { scope: organizationScope(doomed.scope.organizationId), principalId: "subject-a" },
          transaction,
        ),
      ),
    );
    expect(measured.counted).toBe(1);
    const left = await harness.stores.approvals.countErasable({
      scope: doomed.scope,
      principalId: "subject-a",
    });
    expect(left).toEqual({ ok: true, value: 0 });
  });
});
