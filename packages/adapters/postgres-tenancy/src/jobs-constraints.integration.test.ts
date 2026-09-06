// Every guard, stood BESIDE the raw statement it was written from.
//
// A guard is a claim about what the database refuses. Asserting only that the
// guard refuses proves the guard agrees with itself; each case below also sends
// the same value to PostgreSQL out of band, through the ORM's own CLI, and
// records that the database refuses it too. The pair is the evidence.
//
// EVERY VALUE HERE IS ONE THE IN-MEMORY DOUBLE ACCEPTS. `aJob()` in
// `packages/contexts/jobs/application/testing/builders.ts` mints
// `jobId: "job-0001"` and `anApproval()` mints `rowId: "appr-row-0001"`; both are
// stored happily by their doubles and refused by `@db.Uuid`, and every use-case
// suite in that context passes with them. That is not a criticism of the
// doubles — they model the port's CONTRACT — it is the reason this suite exists.
//
// THE REFUSALS ARE READ BY CODE, NOT BY MESSAGE. `jobs/domain/errors.ts`
// publishes ONE code a store may answer with, `JOBS_REPOSITORY_UNAVAILABLE`, so
// the distinct code is carried in `details.reason` and LEADS that string. A case
// that matched on the message would pass against a store that refused for the
// wrong reason.

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
  JsonValue,
  Result,
  ThreadId,
  TurnId,
} from "@platos/context-jobs/application/ports/index.js";
import { asIdentifier, environmentScope } from "@platos/context-jobs/application/ports/index.js";
import { runResult } from "@platos/context-jobs/application/ports/index.js";

import type { JobsHarness } from "./jobs-harness.js";
import { startJobsHarness } from "./jobs-harness.js";
import {
  APPROVAL_EDIT_NOT_STORABLE,
  APPROVAL_OUTCOME_RESERVED,
  APPROVAL_PAGE_WINDOW_INVALID,
  APPROVAL_TIMEOUT_NOT_STORABLE,
  JOB_BUDGET_NOT_STORABLE,
  JOBS_IDENTIFIER_NOT_UUID,
  JOBS_INSTANT_NOT_REPRESENTABLE,
  PAYLOAD_SCHEMA_NOT_OBJECT,
} from "./jobs-guards.js";
import { APPROVAL_OUTCOME_MARKER } from "./jobs-rows.js";

const AT = new Date("2026-05-01T09:00:00.000Z");

let harness: JobsHarness;
let scope: EnvironmentScope;

beforeAll(async () => {
  harness = await startJobsHarness();
  scope = await harness.freshScope();
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

/** The distinct code a refusal carries, or `<ok>` when there was none. */
function refusal(result: Result<unknown>): string {
  if (result.ok) return "<ok>";
  const reason = result.error.details["reason"];
  return typeof reason === "string" ? reason.split(":")[0] ?? reason : String(reason);
}

/** Send `sql` to PostgreSQL out of band and report whether it was refused. */
function databaseRefuses(sql: string): boolean {
  try {
    harness.applyPeerRows(sql);
    return false;
  } catch {
    return true;
  }
}

/**
 * Put `assignment` on a `Job` row this store wrote, out of band.
 *
 * AN UPDATE ON A ROW THE PORT CREATED, NOT A RAW INSERT, and that is a decision
 * rather than a convenience. A raw INSERT has to name every NOT NULL column,
 * and one of `Job`'s carries the pre-cutover vendor name behind an `@map` —
 * `domain/invocation.ts` records it and deliberately does not spell it, and
 * `scripts/vocabulary-boundary.mjs` will not have this package spell it either.
 * An UPDATE names only the column under test, which is also the narrower
 * statement: the row it changes is one this store built and can read back.
 */
async function jobHolding(tag: string, assignment: string): Promise<boolean> {
  const id = harness.base.freshId(tag);
  const created = await insertJob(jobIn(id));
  expect(created.ok).toBe(true);
  return databaseRefuses(`UPDATE "Job" SET ${assignment} WHERE "id" = '${id}';`);
}

function insertJob(job: Job, where: EnvironmentScope = scope): Promise<Result<Job>> {
  return runResult(harness.base.adapter.unitOfWork, (transaction) =>
    harness.stores.jobs.insertJob(where, job, transaction),
  );
}

function insertApproval(approval: Approval, where: EnvironmentScope = scope): Promise<Result<Approval>> {
  return runResult(harness.base.adapter.unitOfWork, (transaction) =>
    harness.stores.approvals.insertApproval(where, approval, transaction),
  );
}

describe("@db.Uuid on both primary keys and every foreign key they carry", () => {
  test("the id the context's own builder mints is refused, and PostgreSQL refuses it too", async () => {
    expect(refusal(await insertJob(jobIn("job-0001")))).toBe(JOBS_IDENTIFIER_NOT_UUID);
    expect(await jobHolding("0730", `"id" = 'job-0001'`)).toBe(true);
  });

  test("an approval row id that is not a uuid is refused on both sides", async () => {
    expect(refusal(await insertApproval(approvalIn("appr-row-0001")))).toBe(
      JOBS_IDENTIFIER_NOT_UUID,
    );
    expect(
      databaseRefuses(
        `INSERT INTO "AgentApproval" ("id", "environmentId", "action", "updatedAt")
         VALUES ('appr-row-0001', '${scope.environmentId}', 'x', now());`,
      ),
    ).toBe(true);
  });

  test("each of the three approval foreign keys is guarded, and the guard names the column", async () => {
    for (const overrides of [
      { agentId: asIdentifier<AgentId>("agent-1") },
      { threadId: asIdentifier<ThreadId>("thread-1") },
      { turnId: asIdentifier<TurnId>("turn-1") },
    ]) {
      const refused = await insertApproval(
        approvalIn(harness.base.freshId("0701"), overrides),
      );
      expect(refusal(refused)).toBe(JOBS_IDENTIFIER_NOT_UUID);
    }
  });

  test("a scope whose environment is not a uuid is refused before any statement", async () => {
    const bogus = environmentScope(
      scope.organizationId,
      scope.projectId,
      asIdentifier("env-not-a-uuid"),
    );
    expect(refusal(await insertJob(jobIn(harness.base.freshId("0702")), bogus))).toBe(
      JOBS_IDENTIFIER_NOT_UUID,
    );
  });
});

describe("Job_payloadSchema_json_root", () => {
  test("an ARRAY schema is refused by the guard and by the CHECK", async () => {
    const refused = await insertJob(
      jobIn(harness.base.freshId("0703"), { payloadSchema: [{ type: "object" }] as JsonValue }),
    );
    expect(refusal(refused)).toBe(PAYLOAD_SCHEMA_NOT_OBJECT);
    expect(await jobHolding("0704", `"payloadSchema" = '[]'::jsonb`)).toBe(true);
  });

  test("an OBJECT schema is accepted by both, which is the control", async () => {
    const accepted = await insertJob(
      jobIn(harness.base.freshId("0705"), { payloadSchema: { type: "object" } }),
    );
    expect(accepted.ok).toBe(true);
    expect(await jobHolding("0706", `"payloadSchema" = '{}'::jsonb`)).toBe(false);
  });
});

describe("AgentApproval_resolution_json_root, and the envelope that survives it", () => {
  test("a NON-object outcome round-trips, where the raw column refuses it", async () => {
    const rowId = harness.base.freshId("0707");
    const approval = approvalIn(rowId);
    expect((await insertApproval(approval)).ok).toBe(true);
    const consumedAt = new Date("2026-05-01T10:00:00.000Z");
    const marked = await runResult(harness.base.adapter.unitOfWork, (transaction) =>
      harness.stores.approvals.markConsumed(
        scope,
        approval.approvalId,
        [1, 2, 3] as JsonValue,
        consumedAt,
        transaction,
      ),
    );
    expect(marked).toEqual({ ok: true, value: true });
    const read = await harness.stores.approvals.findByApprovalId(scope, approval.approvalId);
    expect(read.ok && read.value?.outcome).toEqual([1, 2, 3]);
    // AND THE COLUMN ITSELF REFUSES THAT VALUE, which is why the envelope exists.
    expect(
      databaseRefuses(
        `INSERT INTO "AgentApproval" ("id", "environmentId", "action", "resolution", "updatedAt")
         VALUES ('${harness.base.freshId("0708")}', '${scope.environmentId}', 'x', '[1,2,3]'::jsonb, now());`,
      ),
    ).toBe(true);
  });

  test("an outcome carrying the envelope marker at its ROOT is refused", async () => {
    const rowId = harness.base.freshId("0709");
    const approval = approvalIn(rowId);
    expect((await insertApproval(approval)).ok).toBe(true);
    const marked = await runResult(harness.base.adapter.unitOfWork, (transaction) =>
      harness.stores.approvals.markConsumed(
        scope,
        approval.approvalId,
        { [APPROVAL_OUTCOME_MARKER]: 7 } as JsonValue,
        AT,
        transaction,
      ),
    );
    expect(refusal(marked)).toBe(APPROVAL_OUTCOME_RESERVED);
  });

  test("a NESTED occurrence of the marker is not the marker, and reads back unchanged", async () => {
    // Only the ROOT is reserved. A handler attribute that happens to share the
    // name is a value, not an envelope, and refusing it would be a store
    // deciding what a handler may return.
    const rowId = harness.base.freshId("070a");
    const approval = approvalIn(rowId);
    expect((await insertApproval(approval)).ok).toBe(true);
    const nested = { detail: { [APPROVAL_OUTCOME_MARKER]: 7 } } as JsonValue;
    await runResult(harness.base.adapter.unitOfWork, (transaction) =>
      harness.stores.approvals.markConsumed(scope, approval.approvalId, nested, AT, transaction),
    );
    const read = await harness.stores.approvals.findByApprovalId(scope, approval.approvalId);
    expect(read.ok && read.value?.outcome).toEqual(nested);
  });
});

describe("Int is int4, and TIMESTAMP(3) is not every Date", () => {
  test("a job budget beyond int4 is refused, and PostgreSQL refuses it too", async () => {
    const refused = await insertJob(
      jobIn(harness.base.freshId("070b"), { budget: { timeoutSeconds: 2 ** 40, maxRetries: 0 } }),
    );
    expect(refusal(refused)).toBe(JOB_BUDGET_NOT_STORABLE);
    expect(await jobHolding("070c", `"timeoutSeconds" = 1099511627776`)).toBe(true);
  });

  test("a retry count beyond int4 is refused under the SAME code, and that is deliberate", async () => {
    // `timeoutSeconds` and `maxRetries` are one budget and one column type; a
    // caller acts on both the same way. Where two guards would need telling
    // apart they have two codes — this is one guard over two fields.
    const refused = await insertJob(
      jobIn(harness.base.freshId("070d"), { budget: { timeoutSeconds: 300, maxRetries: 2 ** 40 } }),
    );
    expect(refusal(refused)).toBe(JOB_BUDGET_NOT_STORABLE);
  });

  test("an approval timeout beyond int4 has its OWN code, because it is another table", async () => {
    const refused = await insertApproval(
      approvalIn(harness.base.freshId("070e"), { timeoutSeconds: 2 ** 40 }),
    );
    expect(refusal(refused)).toBe(APPROVAL_TIMEOUT_NOT_STORABLE);
    expect(APPROVAL_TIMEOUT_NOT_STORABLE).not.toBe(JOB_BUDGET_NOT_STORABLE);
  });

  test("an Invalid Date is refused before it reaches the driver", async () => {
    const refused = await insertJob(
      jobIn(harness.base.freshId("070f"), { createdAt: new Date("nonsense") }),
    );
    expect(refusal(refused)).toBe(JOBS_INSTANT_NOT_REPRESENTABLE);
  });
});

describe("the two refusals the port's own contract could not carry", () => {
  test("a page window the double accepts and PostgreSQL reads backwards is refused", async () => {
    for (const window of [{ limit: 0 }, { limit: -1 }, { offset: -1 }]) {
      const refused = await harness.stores.approvals.list(scope, {
        sinceDays: 36_500,
        ...window,
      });
      expect(refusal(refused)).toBe(APPROVAL_PAGE_WINDOW_INVALID);
    }
  });

  test("an edit whose editedArguments is JSON null is refused rather than silently lost", async () => {
    // THE PORT CONTRACT THE SCHEMA CANNOT HONOUR. The live envelope stores the
    // edit and the ABSENCE of an edit in one field, so this value and no edit at
    // all are the same stored bytes. Refusing is the only truthful answer; see
    // `jobs-guards.ts`.
    const rowId = harness.base.freshId("0710");
    const approval = approvalIn(rowId);
    expect((await insertApproval(approval)).ok).toBe(true);
    const refused = await runResult(harness.base.adapter.unitOfWork, (transaction) =>
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
            edit: { editedArguments: null, editedBy: "operator-9" },
          },
        },
        transaction,
      ),
    );
    expect(refusal(refused)).toBe(APPROVAL_EDIT_NOT_STORABLE);
    // AND THE CONTROL: the same decision with a real edited value is accepted.
    const accepted = await runResult(harness.base.adapter.unitOfWork, (transaction) =>
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
            edit: { editedArguments: { table: "orders" }, editedBy: "operator-9" },
          },
        },
        transaction,
      ),
    );
    expect(accepted).toEqual({ ok: true, value: true });
  });
});
