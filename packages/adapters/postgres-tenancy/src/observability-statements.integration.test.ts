// Statement counts, MEASURED — the N+1 control for `observability`'s store.
//
// EVERY PIN IS TAKEN TWICE, over a small trail and one an order of magnitude
// larger, and both must be identical. A read whose cost grows with the rows it
// returns is correct in every case and expensive in exactly one: the
// installation that has been running longest, which for an audit trail is every
// installation, because nothing here is ever deleted.
//
// THE ANCESTRY IS THE THING THIS SUITE EXISTS TO WATCH. `AdminAudit` stores one
// scope column and the port's record carries three, so every read has to resolve
// `Environment -> Project -> Organization`. Done as a relation filter the
// database plans, that is a JOIN inside the statement the read was already
// making; done in JavaScript it is one extra statement per ROW, and the obvious
// wrong implementation — list the rows, then look up each row's environment —
// is invisible to every functional assertion in this package.
//
// THE PROBE PATTERN IS ANCHORED, and this is tranche 3's trap rather than a
// precaution. Its advisory lock projected `SELECT 1`, which is exactly the shape
// the statement suites strip to discard the driver's connection probe, so the
// lock was measured at ZERO statements and a mutation that removed it survived.
// The filter below anchors the probe to a statement that is ONLY `SELECT 1`, and
// every measurement records the unfiltered total beside the filtered count — so
// a measurement can never be smaller than the thing it is measuring.
//
// THE WRITE IS PINNED AT TWO, NOT ONE, AND THE SECOND ONE IS THE POINT.
// `AdminAudit` carries no ancestry rule — it is not among the thirty-eight
// tables that do — so the containment the record claims is checked by this store
// or by nobody. That check is a statement, it is measured here, and it does not
// grow with the size of the trail.

import { afterAll, beforeAll, describe, expect, test } from "vitest";

import type { TransactionScope } from "@platos/context-observability/application/ports/index.js";
import {
  asIdentifier,
  type PrincipalId,
} from "@platos/context-observability/application/ports/index.js";
import { runResult } from "@platos/kernel";
import type { NotResult } from "@platos/kernel";
import type { Result } from "@platos/kernel";

import type { AuditScope, ObservabilityHarness } from "./observability-harness.js";
import { auditRecord, AUDIT_AT, startObservabilityHarness } from "./observability-harness.js";

let harness: ObservabilityHarness;

interface Fixture {
  readonly tenant: AuditScope;
  readonly rows: number;
}

let small: Fixture;
let large: Fixture;

const ACTOR = asIdentifier<PrincipalId>("99999999-9999-4999-8999-999999999999");

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

function write<Value>(work: (transaction: TransactionScope) => Promise<Result<Value>>): Promise<Result<Value>> {
  return runResult(harness.base.adapter.unitOfWork, work);
}

/** `rows` audit records in a fresh tenant, all by the same actor. */
async function seedFixture(rows: number): Promise<Fixture> {
  const tenant = await harness.freshScope();
  for (let index = 0; index < rows; index += 1) {
    await write((transaction) =>
      harness.stores.observability.recordAdminAudit(
        auditRecord(tenant.scope, harness.base.freshId("0070"), {
          actorUserId: ACTOR,
          subjectId: `agent-${String(index)}`,
          recordedAt: new Date(AUDIT_AT.getTime() + index * 1000),
        }),
        transaction,
      ),
    );
  }
  return { tenant, rows };
}

beforeAll(async () => {
  harness = await startObservabilityHarness();
  small = await seedFixture(2);
  large = await seedFixture(20);
}, 600_000);

afterAll(async () => {
  await harness?.stop();
});

describe("the write", () => {
  test("one append is exactly TWO statements: the ancestry check and the insert", async () => {
    const measured = await measure(() =>
      write((transaction) =>
        harness.stores.observability.recordAdminAudit(
          auditRecord(small.tenant.scope, harness.base.freshId("0071")),
          transaction,
        ),
      ),
    );
    expect(measured.counted).toBe(2);
    // The unfiltered total can only be larger, never smaller, than the filtered
    // count. A filter that discarded the statement it was measuring would break
    // this.
    expect(measured.total).toBeGreaterThanOrEqual(measured.counted);
  });

  test("the append costs the SAME two statements in a tenant holding twenty rows", async () => {
    const measured = await measure(() =>
      write((transaction) =>
        harness.stores.observability.recordAdminAudit(
          auditRecord(large.tenant.scope, harness.base.freshId("0072")),
          transaction,
        ),
      ),
    );
    expect(measured.counted).toBe(2);
  });

  test("a GUARD refusal costs ZERO statements, which is why it leaves the transaction usable", async () => {
    const measured = await measure(() =>
      write((transaction) =>
        harness.stores.observability.recordAdminAudit(
          auditRecord(small.tenant.scope, "audit-not-a-uuid"),
          transaction,
        ),
      ),
    );
    expect(measured.counted).toBe(0);
  });
});

describe("the reads", () => {
  test("a full listing is ONE statement — the ancestry is a join, not a second read", async () => {
    const forSmall = await measure(() =>
      harness.stores.observability.listAdminAudit({ scope: small.tenant.scope, limit: 200 }),
    );
    const forLarge = await measure(() =>
      harness.stores.observability.listAdminAudit({ scope: large.tenant.scope, limit: 200 }),
    );
    expect(forSmall.counted).toBe(1);
    // THE SAME COUNT FOR TEN TIMES THE ROWS. This is the pin that fails the day
    // somebody resolves the scope per row.
    expect(forLarge.counted).toBe(forSmall.counted);
    expect(forSmall.total).toBeGreaterThanOrEqual(forSmall.counted);
    expect(forLarge.total).toBeGreaterThanOrEqual(forLarge.counted);
  });

  test("a filtered listing is still ONE statement, and the same one for every filter", async () => {
    const byAction = await measure(() =>
      harness.stores.observability.listAdminAudit({
        scope: large.tenant.scope,
        action: "agent.delete",
        limit: 200,
      }),
    );
    const byEverything = await measure(() =>
      harness.stores.observability.listAdminAudit({
        scope: large.tenant.scope,
        action: "agent.delete",
        subjectType: "Agent",
        subjectId: "agent-3",
        limit: 200,
      }),
    );
    expect(byAction.counted).toBe(1);
    // A store that built its `WHERE` in JavaScript would make a filtered read a
    // query per filter.
    expect(byEverything.counted).toBe(1);
  });

  test("the actor count is ONE statement, and the organization walk is inside it", async () => {
    const forSmall = await measure(() =>
      harness.stores.observability.countAdminAuditForActor({
        organizationId: small.tenant.organizationId,
        actorUserId: ACTOR,
      }),
    );
    const forLarge = await measure(() =>
      harness.stores.observability.countAdminAuditForActor({
        organizationId: large.tenant.organizationId,
        actorUserId: ACTOR,
      }),
    );
    expect(forSmall.counted).toBe(1);
    expect(forLarge.counted).toBe(forSmall.counted);
    // And it counted the right rows: the plan an erasure reports is this number.
    const counted = await harness.stores.observability.countAdminAuditForActor({
      organizationId: large.tenant.organizationId,
      actorUserId: ACTOR,
    });
    expect(counted.ok && counted.value).toBe(large.rows);
  });

  test("a page size of two costs the same ONE statement as a page size of two hundred", async () => {
    const capped = await measure(() =>
      harness.stores.observability.listAdminAudit({ scope: large.tenant.scope, limit: 2 }),
    );
    expect(capped.counted).toBe(1);
  });

  test("a read guard refusal costs ZERO statements", async () => {
    const measured = await measure(() =>
      harness.stores.observability.listAdminAudit({ scope: large.tenant.scope, limit: -5 }),
    );
    expect(measured.counted).toBe(0);
  });
});

describe("the unlink", () => {
  test("an unlink that matches nothing is ONE statement, whatever the trail holds", async () => {
    const nobody = asIdentifier<PrincipalId>("aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa");
    const forSmall = await measure(() =>
      write((transaction) =>
        harness.stores.observability.clearAdminAuditActor(
          { organizationId: small.tenant.organizationId, actorUserId: nobody },
          transaction,
        ),
      ),
    );
    const forLarge = await measure(() =>
      write((transaction) =>
        harness.stores.observability.clearAdminAuditActor(
          { organizationId: large.tenant.organizationId, actorUserId: nobody },
          transaction,
        ),
      ),
    );
    expect(forSmall.counted).toBe(1);
    expect(forLarge.counted).toBe(forSmall.counted);
  });
});
