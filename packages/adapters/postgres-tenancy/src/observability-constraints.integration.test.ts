// What the REAL `AdminAudit` table adds on top of the domain, one named case per
// rule — and the one rule that takes a port method away.
//
// *** THE HEADLINE: `clearAdminAuditActor` CANNOT BE HONOURED. ***
//
// `00000000000000_initial/migration.sql` installs `reject_admin_audit_mutation()`
// on UPDATE, on DELETE and on TRUNCATE of this table and withdraws all three
// privileges from PUBLIC, above a comment that says the intent in as many words:
// "Administrative audit evidence is append-only... no role can rewrite or remove
// an accepted event. Corrections must be represented by a new row." The port
// defines the unlink as an UPDATE returning rows changed. Three cases below say
// exactly what that leaves:
//
//   * an unlink matching NO row is `ok(0)`, because a row-level rule never fires
//     on an UPDATE that matched nothing;
//   * an unlink matching ONE row REFUSES, under its own code, with the
//     database's own message on it;
//   * and the caller's transaction is UNUSABLE afterwards, which is what proves
//     the refusal came from the rule rather than from this adapter's memory of
//     having read the migration.
//
// The in-memory double unlinks happily and every use-case suite in the tree
// passes with it. That is trap 2 of this issue, in its second form: the double
// does not mint a value the database refuses, it performs an OPERATION the
// database refuses.
//
// THE OTHER FINDING IS WHAT THE TABLE DOES NOT HAVE. `AdminAudit` is not among
// the thirty-eight tables carrying `enforce_domain_ancestry`, and it stores ONE
// scope column. So nothing in the database relates an audit row to the
// organization the record claims, and nothing relates `actorUserId` to a `User`
// — that column has no foreign key at all. Both are pinned below, because both
// are load-bearing for the erasure path: a plan counts by ORGANIZATION.

import { afterAll, beforeAll, expect, test } from "vitest";

import type {
  EnvironmentScope,
  TransactionScope,
} from "@platos/context-observability/application/ports/index.js";
import {
  asIdentifier,
  type PrincipalId,
} from "@platos/context-observability/application/ports/index.js";

import type { AuditScope, ObservabilityHarness } from "./observability-harness.js";
import { auditRecord, AUDIT_AT, startObservabilityHarness } from "./observability-harness.js";
import {
  ADMIN_AUDIT_IMMUTABLE,
  ADMIN_AUDIT_IMMUTABLE_RAISE,
  AUDIT_ACTOR_BLANK,
  AUDIT_ORGANIZATION_BLANK,
  AUDIT_PAGE_LIMIT_INVALID,
  AUDIT_SCOPE_UNRESOLVED,
  OBSERVABILITY_IDENTIFIER_NOT_UUID,
} from "./observability-guards.js";

let harness: ObservabilityHarness;
let home: AuditScope;
let foreign: AuditScope;

beforeAll(async () => {
  harness = await startObservabilityHarness();
  home = await harness.freshScope();
  foreign = await harness.freshScope();
}, 300_000);

afterAll(async () => {
  await harness?.stop();
});

function id(kind: string): string {
  return harness.base.freshId(kind);
}

/** The refusal reason a store returns, which leads with the distinct code. */
function reasonOf(result: { readonly ok: boolean }): string {
  const error = (result as { readonly error?: { readonly details?: Record<string, unknown> } })
    .error;
  if (error === undefined || error.details === undefined) return "";
  return String(error.details["reason"] ?? "");
}

function write<Value>(work: (transaction: TransactionScope) => Promise<Value>): Promise<Value> {
  return harness.base.adapter.unitOfWork.run(work);
}

const OPERATOR = asIdentifier<PrincipalId>("55555555-5555-4555-8555-555555555555");

// ---------------------------------------------------------------------------
// The append-only rule.
// ---------------------------------------------------------------------------

test("an unlink that matches NO row is ok(0) — the exact boundary of what the port can honour", async () => {
  // A row-level BEFORE UPDATE rule fires PER ROW, so an UPDATE whose WHERE
  // matched nothing never reaches it. This is the one shape of
  // `clearAdminAuditActor` a database these migrations build will accept, and it
  // is the shape the conformance scenario compares against the double.
  const nobody = asIdentifier<PrincipalId>("66666666-6666-4666-8666-666666666666");
  const cleared = await write((transaction) =>
    harness.stores.observability.clearAdminAuditActor(
      { organizationId: home.organizationId, actorUserId: nobody },
      transaction,
    ),
  );
  expect(cleared.ok).toBe(true);
  if (cleared.ok) expect(cleared.value).toBe(0);
});

test("*** an unlink that matches ONE row is REFUSED BY THE DATABASE — the port's contract is unhonourable ***", async () => {
  const auditId = id("0041");
  await write((transaction) =>
    harness.stores.observability.recordAdminAudit(
      auditRecord(home.scope, auditId, { actorUserId: OPERATOR }),
      transaction,
    ),
  );

  const counted = await harness.stores.observability.countAdminAuditForActor({
    organizationId: home.organizationId,
    actorUserId: OPERATOR,
  });
  expect(counted.ok && counted.value).toBe(1);

  const refused = await write((transaction) =>
    harness.stores.observability.clearAdminAuditActor(
      { organizationId: home.organizationId, actorUserId: OPERATOR },
      transaction,
    ),
  );
  expect(refused.ok).toBe(false);
  // The DISTINCT code, and the database's own raise text under it. The code
  // matters because folding this into the generic driver branch would report a
  // permanent structural refusal as an outage; the raise text matters because it
  // is what proves which rule refused.
  expect(reasonOf(refused)).toContain(ADMIN_AUDIT_IMMUTABLE);
  expect(reasonOf(refused)).toContain(ADMIN_AUDIT_IMMUTABLE_RAISE);

  // AND THE ROW IS UNTOUCHED. The actor is still named, which is the whole
  // reason the refusal is a finding rather than a nuisance: an erasure that
  // reported this as done would be certifying something that did not happen.
  const stillThere = await harness.stores.observability.countAdminAuditForActor({
    organizationId: home.organizationId,
    actorUserId: OPERATOR,
  });
  expect(stillThere.ok && stillThere.value).toBe(1);
});

test("the refusal leaves the caller's transaction UNUSABLE, which is what proves it is the DATABASE's", async () => {
  // A guard refuses before any statement and the session stays writable — the
  // three cases below this one show that. A RULE refuses inside the statement
  // and PostgreSQL puts the session into 25P02, so everything after it in the
  // same transaction fails too. Measuring the difference is the only way to tell
  // "this adapter declined" from "the table declined", and it is the reason
  // `observability-audit.ts` sends the statement rather than anticipating it.
  const auditId = id("0042");
  const actor = asIdentifier<PrincipalId>("77777777-7777-4777-8777-777777777777");
  await write((transaction) =>
    harness.stores.observability.recordAdminAudit(
      auditRecord(home.scope, auditId, { actorUserId: actor }),
      transaction,
    ),
  );

  const outcome = await write(async (transaction) => {
    const unlink = await harness.stores.observability.clearAdminAuditActor(
      { organizationId: home.organizationId, actorUserId: actor },
      transaction,
    );
    // THE SAME TRANSACTION, after the raise. A read that would have succeeded on
    // a healthy session.
    const after = await harness.stores.observability.countAdminAuditForActor({
      organizationId: home.organizationId,
      actorUserId: actor,
    });
    return { unlink, after };
  }).catch((error: unknown) => ({ thrown: error instanceof Error ? error.message : String(error) }));

  // Either the follow-up read refuses too, or the whole unit of work is rejected
  // when the driver tries to commit an aborted session. Both are the same fact;
  // neither is "the unlink quietly worked".
  if ("thrown" in outcome) {
    expect(outcome.thrown.length).toBeGreaterThan(0);
  } else {
    expect(outcome.unlink.ok).toBe(false);
    expect(outcome.after.ok).toBe(false);
  }
});

test("a DELETE is refused too, so 'unlink rather than delete' was never a choice this store had", async () => {
  // The port's comment argues for unlinking INSTEAD of deleting, as though both
  // were available. Neither is: the same function is installed on DELETE. The
  // statement is issued through the client directly, because no method of this
  // port deletes and none may be added.
  const auditId = id("0043");
  await write((transaction) =>
    harness.stores.observability.recordAdminAudit(auditRecord(home.scope, auditId), transaction),
  );
  await expect(harness.base.client.adminAudit.delete({ where: { id: auditId } })).rejects.toThrow(
    ADMIN_AUDIT_IMMUTABLE_RAISE,
  );
});

// ---------------------------------------------------------------------------
// What the table does NOT relate.
// ---------------------------------------------------------------------------

test("`actorUserId` has NO foreign key, so an audit row can name an operator the tree never had", async () => {
  // Deliberate, and load-bearing: the column has to survive the operator being
  // erased. But it means `countAdminAuditForActor` is a string match narrowed by
  // a relation walk to the organization, and nothing structural ties an audit
  // row to a person.
  const ghost = asIdentifier<PrincipalId>("not-a-uuid-and-not-a-user");
  const auditId = id("0044");
  const written = await write((transaction) =>
    harness.stores.observability.recordAdminAudit(
      auditRecord(home.scope, auditId, { actorUserId: ghost }),
      transaction,
    ),
  );
  expect(written.ok).toBe(true);
  const counted = await harness.stores.observability.countAdminAuditForActor({
    organizationId: home.organizationId,
    actorUserId: ghost,
  });
  expect(counted.ok && counted.value).toBe(1);
});

test("an environment outside the record's own organization is refused by THIS store, because no rule refuses it", async () => {
  // `AdminAudit` is not among the thirty-eight tables carrying
  // `enforce_domain_ancestry`. Its only structural guarantee is
  // `AdminAudit_environmentId_fkey`, which proves the environment exists and
  // says nothing about whose it is — so a record claiming this organization and
  // naming the OTHER tenant's environment would be written, and then counted
  // and erased under the wrong tenant.
  const mixed: EnvironmentScope = {
    level: "environment",
    organizationId: home.scope.organizationId,
    projectId: home.scope.projectId,
    environmentId: foreign.scope.environmentId,
  };
  const refused = await write((transaction) =>
    harness.stores.observability.recordAdminAudit(
      auditRecord(mixed, id("0045")),
      transaction,
    ),
  );
  expect(refused.ok).toBe(false);
  expect(reasonOf(refused)).toContain(AUDIT_SCOPE_UNRESOLVED);

  // AND THE FOREIGN KEY WOULD HAVE ACCEPTED IT. The same environment id, written
  // under its OWN organization, succeeds — so the refusal above is about
  // ancestry and not about the row being unwritable.
  const accepted = await write((transaction) =>
    harness.stores.observability.recordAdminAudit(
      auditRecord(foreign.scope, id("0046")),
      transaction,
    ),
  );
  expect(accepted.ok).toBe(true);
});

test("a listing scoped to the wrong project returns NOTHING rather than another tenant's trail", async () => {
  const auditId = id("0047");
  await write((transaction) =>
    harness.stores.observability.recordAdminAudit(auditRecord(home.scope, auditId), transaction),
  );
  const crossed: EnvironmentScope = {
    level: "environment",
    organizationId: foreign.scope.organizationId,
    projectId: foreign.scope.projectId,
    environmentId: home.scope.environmentId,
  };
  const page = await harness.stores.observability.listAdminAudit({ scope: crossed, limit: 50 });
  expect(page.ok).toBe(true);
  if (page.ok) expect(page.value).toEqual([]);
});

// ---------------------------------------------------------------------------
// The guards that keep the caller's transaction usable.
// ---------------------------------------------------------------------------

test("a non-uuid id is refused by a GUARD, and the same transaction stays writable", async () => {
  const survivor = id("0048");
  const outcome = await write(async (transaction) => {
    const refused = await harness.stores.observability.recordAdminAudit(
      auditRecord(home.scope, "audit-1"),
      transaction,
    );
    // THE SAME TRANSACTION, still open, still writable — which a raised
    // `invalid input syntax for type uuid` would not have left.
    const written = await harness.stores.observability.recordAdminAudit(
      auditRecord(home.scope, survivor),
      transaction,
    );
    return { refused, written };
  });
  expect(outcome.refused.ok).toBe(false);
  expect(reasonOf(outcome.refused)).toContain(OBSERVABILITY_IDENTIFIER_NOT_UUID);
  expect(outcome.written.ok).toBe(true);
});

test("a blank actor and a blank organization are two refusals with two codes", async () => {
  const blankActor = await harness.stores.observability.countAdminAuditForActor({
    organizationId: home.organizationId,
    actorUserId: "   ",
  });
  expect(blankActor.ok).toBe(false);
  expect(reasonOf(blankActor)).toContain(AUDIT_ACTOR_BLANK);

  const blankOrganization = await harness.stores.observability.countAdminAuditForActor({
    organizationId: "",
    actorUserId: OPERATOR,
  });
  expect(blankOrganization.ok).toBe(false);
  expect(reasonOf(blankOrganization)).toContain(AUDIT_ORGANIZATION_BLANK);

  // TWO CODES, NOT ONE. A shared code would make these one incident in a log.
  expect(AUDIT_ACTOR_BLANK).not.toBe(AUDIT_ORGANIZATION_BLANK);
});

test("a negative page size is refused rather than read backwards", async () => {
  // The client reads `take: -1` as "the last one, in reverse", so an
  // unguarded store would answer a newest-first contract with the OLDEST row and
  // no error anywhere.
  const refused = await harness.stores.observability.listAdminAudit({
    scope: home.scope,
    limit: -1,
  });
  expect(refused.ok).toBe(false);
  expect(reasonOf(refused)).toContain(AUDIT_PAGE_LIMIT_INVALID);

  const fractional = await harness.stores.observability.listAdminAudit({
    scope: home.scope,
    limit: 2.5,
  });
  expect(fractional.ok).toBe(false);
  expect(reasonOf(fractional)).toContain(AUDIT_PAGE_LIMIT_INVALID);
});

// ---------------------------------------------------------------------------
// The two JSON columns.
// ---------------------------------------------------------------------------

test("an absent snapshot is SQL NULL, not the JSON scalar null, which both CHECKs refuse", async () => {
  // `AdminAudit_before_json_root` and `AdminAudit_after_json_root` are both
  // `IS NULL OR jsonb_typeof(...) = 'object'`. The JSON scalar `null` has
  // `jsonb_typeof` `'null'` and is refused by the clause that looks like it
  // should have allowed it — which is why `nullableJson` exists.
  const auditId = id("0049");
  const written = await write((transaction) =>
    harness.stores.observability.recordAdminAudit(
      auditRecord(home.scope, auditId, { before: null, after: null }),
      transaction,
    ),
  );
  expect(written.ok).toBe(true);
  const raw = await harness.base.client.$queryRawUnsafe<
    readonly { readonly before_kind: string | null; readonly after_kind: string | null }[]
  >(
    `SELECT jsonb_typeof("before") AS before_kind, jsonb_typeof("after") AS after_kind
     FROM "AdminAudit" WHERE "id" = '${auditId}'::uuid`,
  );
  expect(raw[0]?.before_kind).toBeNull();
  expect(raw[0]?.after_kind).toBeNull();
});

test("an ARRAY snapshot is refused by the column, and the CHECK on this table is narrower than its siblings", async () => {
  // Every other `*_json_root` in the initial migration reads
  // `jsonb_typeof(...) IN ('object', 'array')`. These two read `= 'object'`. An
  // adapter written against the family rather than against these two would have
  // let an array through, and `domain/admin-audit.ts` — which refuses one on the
  // way in — would have been the only thing standing in front of it.
  await expect(
    harness.base.client.$executeRawUnsafe(
      `INSERT INTO "AdminAudit" ("id", "environmentId", "action", "subjectType", "before", "createdAt")
       VALUES ('${id("004a")}'::uuid, '${home.environmentId}'::uuid, 'agent.delete', 'Agent', '[]'::jsonb, NOW())`,
    ),
  ).rejects.toThrow();
});

// ---------------------------------------------------------------------------
// Expand/contract.
// ---------------------------------------------------------------------------

test("a row written WITHOUT `source` reads back as the domain's default rather than as null", async () => {
  // `AdminAudit.source` is nullable and `AdminAuditRecord.source` is not, so one
  // row disagrees with the record type: the one an older writer left unstated.
  // `DEFAULT_AUDIT_SOURCE` is the domain's own published answer to "what
  // `source` becomes when a caller does not say", so this is that rule read back
  // rather than a value the adapter invented.
  const auditId = id("004b");
  await harness.base.client.$executeRawUnsafe(
    `INSERT INTO "AdminAudit" ("id", "environmentId", "action", "subjectType", "createdAt")
     VALUES ('${auditId}'::uuid, '${home.environmentId}'::uuid, 'legacy.action', 'Legacy', '${AUDIT_AT.toISOString()}'::timestamp)`,
  );
  const page = await harness.stores.observability.listAdminAudit({
    scope: home.scope,
    action: "legacy.action",
    limit: 10,
  });
  expect(page.ok).toBe(true);
  if (page.ok) {
    expect(page.value).toHaveLength(1);
    expect(page.value[0]?.source).toBe("api");
    expect(page.value[0]?.actorUserId).toBeNull();
    expect(page.value[0]?.before).toBeNull();
  }
});
