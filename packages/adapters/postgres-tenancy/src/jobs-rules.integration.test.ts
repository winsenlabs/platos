// Rows this store REFUSES to write, put there by the ORM's own CLI and read back.
//
// WHY THEY CANNOT BE WRITTEN THROUGH THE PORT. Every value below is one the
// guards in `jobs-guards.ts` refuse or a shape the mapping in `jobs-rows.ts`
// never produces — a `WorkStatus` a `Job` row never takes, an `allowedAgentIds`
// that is SQL NULL, a registered name that no longer satisfies the key rule, an
// approval envelope written before the marker existed, a metadata field of the
// wrong type. They are exactly the rows an EXPAND/CONTRACT window puts in the
// database: written by an older binary, or by a newer one, and read by this one.
//
// `prisma db execute` IS THE RIGHT DOOR FOR THEM. It is the ORM's CLI at
// runtime, not a client call, so `scripts/arch/sole-writer.mjs` neither sees
// these statements nor should — and a fixture that reached for `$executeRaw`
// instead would be this package writing rows it has just declared unwritable.
//
// THE TWO HALVES REACH IT DIFFERENTLY, AND THE `Job` HALF IS THE INTERESTING
// ONE. An `AgentApproval` is INSERTed outright: every column an INSERT must name
// is one this package may spell. A `Job` is created through the PORT and then
// UPDATED, because a raw INSERT has to name every NOT NULL column and one of
// `Job`'s carries the pre-cutover vendor name behind an `@map` —
// `domain/invocation.ts` deliberately does not spell it, and
// `scripts/vocabulary-boundary.mjs` will not have this package spell it either.
// The UPDATE names only the columns under test, is still out of band, and is
// safe to use here because `enforce_domain_ancestry` does not fire on `Job`.
//
// THE INVOCATION TYPE IS THEREFORE THE ONE VOCABULARY THIS SUITE CANNOT ASK
// ABOUT, and that is a vocabulary boundary rather than a gap: planting a row
// that holds an unknown one would mean naming the column. `readInvocationType`
// is proven in `jobs-rows.test.ts` instead, where the value goes straight to the
// reader and no column is named at all.
//
// ONE CASE DROPS A CONSTRAINT AND PUTS IT BACK. `Job_payloadSchema_json_root`
// has been in the schema since the initial migration, so the only way a row can
// hold a non-object schema is to have been written while the constraint was
// absent — which is precisely the window this suite is about. The constraint is
// restored `NOT VALID`, so the planted row survives for the read and every LATER
// write is checked exactly as before.

import { afterAll, beforeAll, describe, expect, test } from "vitest";

import type { EnvironmentScope, JobId, Result } from "@platos/context-jobs/application/ports/index.js";
import { asIdentifier } from "@platos/context-jobs/application/ports/index.js";
import { runResult } from "@platos/kernel";

import type { ApprovalPeers, JobsHarness } from "./jobs-harness.js";
import { startJobsHarness } from "./jobs-harness.js";
import {
  JOBS_UNKNOWN_WORK_STATUS,
  UNREADABLE_APPROVAL_ENVELOPE,
  UNREADABLE_PAYLOAD_SCHEMA,
} from "./jobs-rows.js";

const STAMP = "'2026-05-01T09:00:00Z'";
const PLANTED_AT = new Date("2026-05-01T09:00:00.000Z");

let harness: JobsHarness;
let scope: EnvironmentScope;
let peers: ApprovalPeers;

beforeAll(async () => {
  harness = await startJobsHarness();
  scope = await harness.freshScope();
  peers = await harness.seedPeers(scope);
}, 600_000);

afterAll(async () => {
  await harness?.stop();
});

/** The distinct code a refusal carries, or `<ok>` when there was none. */
function refusal(result: Result<unknown>): string {
  if (result.ok) return "<ok>";
  const reason = result.error.details["reason"];
  return typeof reason === "string" ? reason.split(":")[0] ?? reason : String(reason);
}

/**
 * Put a `Job` row into the state `columns` describes, out of band.
 *
 * IT CREATES THE ROW THROUGH THE PORT AND THEN UPDATES IT, rather than issuing a
 * raw INSERT, and that is a decision rather than a convenience. A raw INSERT has
 * to name every NOT NULL column, and one of `Job`'s carries the pre-cutover
 * vendor name behind an `@map` — `domain/invocation.ts` records it and
 * deliberately does not spell it, and `scripts/vocabulary-boundary.mjs` will not
 * have this package spell it either. An UPDATE names only the columns under
 * test.
 *
 * IT IS STILL OUT OF BAND, which is the property that matters: every value below
 * is one the guards refuse or the mapping never produces, so it reaches the
 * database through the ORM's own CLI and through no port method at all — and
 * `enforce_domain_ancestry` does not fire on `Job`, so the UPDATE half is not a
 * second rule to satisfy.
 */
async function plantJob(id: string, columns: Record<string, string>): Promise<void> {
  const created = await runResult(harness.base.adapter.unitOfWork, (transaction) =>
    harness.stores.jobs.insertJob(
      scope,
      {
        jobId: asIdentifier<JobId>(id),
        jobKey: null,
        displayName: "planted",
        description: null,
        invocationType: "manual",
        schedule: { cron: null, timezone: null },
        allowedAgentIds: [],
        payloadSchema: null,
        handler: "async function run() {}",
        budget: { timeoutSeconds: 300, maxRetries: 0 },
        status: "active",
        createdBy: "legacy",
        lastStartedAt: null,
        createdAt: PLANTED_AT,
        updatedAt: PLANTED_AT,
      },
      transaction,
    ),
  );
  expect(created.ok).toBe(true);
  const assignments = Object.entries(columns)
    .map(([name, value]) => `"${name}" = ${value}`)
    .join(", ");
  if (assignments.length === 0) return;
  harness.applyPeerRows(`UPDATE "Job" SET ${assignments} WHERE "id" = '${id}';`);
}

/** Plant one `AgentApproval` row with `columns` spliced into the INSERT. */
function plantApproval(id: string, columns: Record<string, string>): void {
  const base: Record<string, string> = {
    id: `'${id}'`,
    environmentId: `'${scope.environmentId}'`,
    action: "'planted'",
    status: "'PENDING'",
    timeoutSeconds: "300",
    createdAt: STAMP,
    updatedAt: STAMP,
    ...columns,
  };
  const names = Object.keys(base)
    .map((name) => `"${name}"`)
    .join(", ");
  harness.applyPeerRows(
    `INSERT INTO "AgentApproval" (${names}) VALUES (${Object.values(base).join(", ")});`,
  );
}

function readJobRow(id: string) {
  return harness.stores.jobs.findJob(scope, asIdentifier<JobId>(id));
}

function readApprovalRow(id: string) {
  return harness.stores.approvals.findByRowId(scope, asIdentifier(id));
}

describe("Job.status is the FIVE-member WorkStatus, and a Job row takes two of them", () => {
  test.each(["PENDING", "SUCCEEDED", "CANCELLED"])(
    "a row holding %s is refused by name rather than mapped to whichever looks closest",
    async (status) => {
      const id = harness.base.freshId("0901");
      await plantJob(id, { status: `'${status}'` });
      expect(refusal(await readJobRow(id))).toBe(JOBS_UNKNOWN_WORK_STATUS);
    },
  );

  test("ACTIVE and FAILED are the two that read, which is the control", async () => {
    for (const [status, expected] of [
      ["ACTIVE", "active"],
      ["FAILED", "registration-failed"],
    ] as const) {
      const id = harness.base.freshId("0902");
      await plantJob(id, { status: `'${status}'` });
      const read = await readJobRow(id);
      expect(read.ok && read.value?.status).toBe(expected);
    }
  });
});

describe("the columns schema.prisma and the migration disagree about", () => {
  test("allowedAgentIds is NULLABLE in the DDL and reads as the empty list", async () => {
    // `schema.prisma` declares `String[] @default([])`, which Prisma treats as a
    // list that cannot be null; the initial migration declares
    // `"allowedAgentIds" TEXT[] DEFAULT ARRAY[]::TEXT[]` with NO `NOT NULL`. An
    // empty list and a null one mean the same thing to `authorizeAgent` — "any
    // agent" — so the null is read rather than refused.
    const id = harness.base.freshId("0905");
    await plantJob(id, { allowedAgentIds: "NULL" });
    const read = await readJobRow(id);
    expect(read.ok && read.value?.allowedAgentIds).toEqual([]);
  });

  test("an externalId that no longer satisfies the key rule is CARRIED, not refused", async () => {
    // `domain/job.ts` re-checks the key at dispatch and says why: "a row
    // predating a narrowing of the rule would otherwise stay dispatchable
    // forever". Refusing it on READ would make the row unreadable instead, and
    // the decision belongs to `assertDispatchable`.
    const id = harness.base.freshId("0906");
    await plantJob(id, { externalId: "'Nightly_Rollup'" });
    const read = await readJobRow(id);
    expect(read.ok && read.value?.jobKey).toBe("Nightly_Rollup");
  });

  test("a payloadSchema written while the CHECK was absent is refused on read", async () => {
    const id = harness.base.freshId("0907");
    harness.applyPeerRows(
      `ALTER TABLE "Job" DROP CONSTRAINT "Job_payloadSchema_json_root";`,
    );
    await plantJob(id, { payloadSchema: `'[1,2]'::jsonb` });
    harness.applyPeerRows(
      `ALTER TABLE "Job" ADD CONSTRAINT "Job_payloadSchema_json_root"
       CHECK ("payloadSchema" IS NULL OR jsonb_typeof("payloadSchema") = 'object') NOT VALID;`,
    );
    expect(refusal(await readJobRow(id))).toBe(UNREADABLE_PAYLOAD_SCHEMA);
  });
});

describe("the approval envelope, against rows written before it existed", () => {
  test("a NULL arguments column is the absent envelope, not an unreadable row", async () => {
    const id = harness.base.freshId("0908");
    plantApproval(id, {});
    const read = await readApprovalRow(id);
    expect(read.ok && read.value).toMatchObject({
      approvalId: "",
      source: "request_approval",
      arguments: null,
      requestedBy: null,
      requestDigest: null,
      requestedByTokenId: null,
      consumedAt: null,
    });
  });

  test("an arguments object with NO marker is a legacy row and its arguments SURVIVE", async () => {
    // THE ONE PLACE THIS STORE DIVERGES FROM THE LIVE READER ON PURPOSE. The
    // live `readArguments` answers `value: null` for such a row and discards its
    // arguments on every read. Discarding a column the port promises to return
    // is data loss, so the whole object is the arguments here. Reported, not
    // silently changed.
    const id = harness.base.freshId("0909");
    plantApproval(id, { arguments: `'{"table":"orders"}'::jsonb` });
    const read = await readApprovalRow(id);
    expect(read.ok && read.value?.arguments).toEqual({ table: "orders" });
    expect(read.ok && read.value?.approvalId).toBe("");
  });

  test("a marker that is not an object is an unreadable row", async () => {
    const id = harness.base.freshId("090a");
    plantApproval(id, { arguments: `'{"__platosApproval":"nope"}'::jsonb` });
    expect(refusal(await readApprovalRow(id))).toBe(UNREADABLE_APPROVAL_ENVELOPE);
  });

  test("a metadata field of the wrong TYPE is an unreadable row, not a coerced one", async () => {
    for (const metadata of [
      `{"__platosApproval":{"approvalId":7,"source":"request_approval"}}`,
      `{"__platosApproval":{"approvalId":"a","source":"request_approval","requestedBy":7}}`,
      `{"__platosApproval":{"approvalId":"a","source":"request_approval","consumedAt":"not-a-date"}}`,
    ]) {
      const id = harness.base.freshId("090b");
      plantApproval(id, { arguments: `'${metadata}'::jsonb` });
      expect(refusal(await readApprovalRow(id))).toBe(UNREADABLE_APPROVAL_ENVELOPE);
    }
  });

  test("a resolution object with no envelope marker reads back as the object it holds", async () => {
    // What the live `markMcpConsumed` wrote: an object outcome stored verbatim.
    // It is lossy for a NON-object — that path wrapped one as `{ value: x }`,
    // which is indistinguishable from an outcome that IS `{ value: x }` — and
    // this is the most that can be recovered from a wrapper that never said
    // whether it was one.
    const id = harness.base.freshId("090c");
    plantApproval(id, { resolution: `'{"ok":true}'::jsonb` });
    const read = await readApprovalRow(id);
    expect(read.ok && read.value?.outcome).toEqual({ ok: true });
  });
});

describe("the one pair in the status vocabulary that does not match by name", () => {
  test("EXPIRED reads as timed_out, and the other three read as their own names", async () => {
    // An extraction that mapped by lower-casing would be right three times out
    // of four and would silently turn every timed-out approval into an unknown
    // status.
    for (const [stored, expected] of [
      ["PENDING", "pending"],
      ["APPROVED", "approved"],
      ["REJECTED", "rejected"],
      ["EXPIRED", "timed_out"],
    ] as const) {
      const id = harness.base.freshId("090d");
      plantApproval(id, { status: `'${stored}'` });
      const read = await readApprovalRow(id);
      expect(read.ok && read.value?.status).toBe(expected);
    }
  });

  test("a decided row with NO resolvedAt falls back to updatedAt rather than to null", async () => {
    // `ApprovalResolution.resolvedAt` is not nullable and the COLUMN is. For
    // every row this store wrote the two are the same instant, so the fallback
    // is unobservable — which is exactly why it needs a row this store did not
    // write to be observable at all.
    const id = harness.base.freshId("090e");
    plantApproval(id, {
      status: "'APPROVED'",
      respondedBy: "'operator-legacy'",
      updatedAt: "'2026-06-01T12:00:00Z'",
    });
    const read = await readApprovalRow(id);
    expect(read.ok && read.value?.resolution).toMatchObject({
      status: "approved",
      respondedBy: "operator-legacy",
      resolvedAt: new Date("2026-06-01T12:00:00.000Z"),
      edit: null,
    });
  });

  test("a PENDING row carries no resolution at all, whatever the decision columns say", async () => {
    const id = harness.base.freshId("090f");
    plantApproval(id, { respondedBy: "'operator-pending-only'", comment: "'stale'" });
    const read = await readApprovalRow(id);
    expect(read.ok && read.value?.resolution).toBeNull();
    // AND THAT IS WHAT KEEPS THE ERASURE'S TWO HALVES AGREEING WITH THE DOUBLE.
    // The double matches a subject through `resolution?.respondedBy`, which such
    // a row does not have; this store matches the COLUMN, which it does. Every
    // row this store WRITES has a null `respondedBy` while pending, so the two
    // agree — and a planted row is the only place they can be told apart.
    const counted = await harness.stores.approvals.countErasable({
      scope,
      principalId: "operator-pending-only",
    });
    expect(counted).toEqual({ ok: true, value: 1 });
  });
});

describe("the peer chain is real, so a planted approval can carry one", () => {
  test("a planted row pointing at the seeded agent, thread and turn reads back whole", async () => {
    const id = harness.base.freshId("0910");
    plantApproval(id, {
      agentId: `'${peers.agentId}'`,
      threadId: `'${peers.threadId}'`,
      turnId: `'${peers.turnId}'`,
      arguments: `'{"__platosApproval":{"approvalId":"appr-legacy","source":"mcp_tool_call","requestedBy":"subject-z","requestHash":"h1","requestedByMcpTokenId":"tok-z","consumedAt":"2026-05-02T00:00:00.000Z","editedArgs":{"a":1},"editedByUserId":"operator-z"},"value":{"q":"x"}}'::jsonb`,
      status: "'APPROVED'",
      resolvedAt: STAMP,
      respondedBy: "'operator-z'",
    });
    const read = await readApprovalRow(id);
    expect(read.ok && read.value).toMatchObject({
      approvalId: "appr-legacy",
      source: "mcp_tool_call",
      agentId: peers.agentId,
      threadId: peers.threadId,
      turnId: peers.turnId,
      requestedBy: "subject-z",
      requestDigest: "h1",
      requestedByTokenId: "tok-z",
      arguments: { q: "x" },
      consumedAt: new Date("2026-05-02T00:00:00.000Z"),
    });
    expect(read.ok && read.value?.resolution?.edit).toEqual({
      editedArguments: { a: 1 },
      editedBy: "operator-z",
    });
  });
});
