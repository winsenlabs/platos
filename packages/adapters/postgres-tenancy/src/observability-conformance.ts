// One scenario, written once, so `observability`'s in-memory double and this
// adapter can be asked the SAME questions and their answers compared.
//
// Same instrument as `./conformance.ts`, `./governance-conformance.ts` and
// `./memory-conformance.ts`, and the same reason: two independently written
// suites measure two things and agree by coincidence. This module drives one
// sequence of port calls and records what came back; a test runs it twice and
// compares verbatim. A divergence is then a named step with a value on each
// side.
//
// EVERY IDENTIFIER AND EVERY INSTANT IN THIS SCENARIO IS THE CALLER'S, which
// makes it comparable in a way the other tranches' are not. `recordAdminAudit`
// takes a whole `AdminAuditRecord` — `domain/admin-audit.ts` mints its id
// through the kernel's `IdGenerator` and stamps it through the `Clock` — so
// neither store mints anything and the id and the `recordedAt` compare
// DIRECTLY. There is no advancing-clock stand-in here for the same reason.
//
// *** ONE THING IS DELIBERATELY NOT IN THIS SCENARIO, AND IT IS THE ONE THIS
// TRANCHE EXISTS TO REPORT. ***
//
// A NON-EMPTY `clearAdminAuditActor`. The double unlinks every matching row and
// answers with how many; the real table is APPEND-ONLY — the initial migration
// installs `reject_admin_audit_mutation()` on UPDATE, DELETE and TRUNCATE — so
// the same call refuses. That is not a divergence to hide: it is the finding,
// and it is pinned as two named cases in
// `observability-constraints.integration.test.ts` (one for the refusal, one for
// the aborted transaction it leaves behind) and reported.
//
// THE EMPTY UNLINK IS IN THE SCENARIO, and it earns its place. A row-level rule
// never fires on an UPDATE that matched nothing, so both stores answer `ok(0)` —
// which is the exact boundary of what the port CAN honour here, and a step that
// records it is worth more than a comment claiming it.
//
// THE SECOND TENANT IS IN THE SCENARIO TOO. `AdminAudit` has no ancestry rule,
// so the containment every read depends on is this adapter's WHERE clause rather
// than the database's. A scenario that only ever asked about one organization
// could not tell a correct predicate from a missing one.

import type {
  AdminAuditQuery,
  AdminAuditRecord,
  EnvironmentScope,
  ObservabilityRepository,
  PrincipalId,
  Result,
  TransactionScope,
} from "@platos/context-observability/application/ports/index.js";
import { asIdentifier } from "@platos/context-observability/application/ports/index.js";
import type { NotResult } from "@platos/kernel";
import { runResult } from "@platos/kernel";

/** Every identifier the scenario needs. All uuids; both stores use the same. */
export interface ObservabilityConformanceIds {
  readonly first: string;
  readonly second: string;
  readonly third: string;
  readonly foreign: string;
}

export interface ObservabilityConformanceEnvironment {
  readonly repository: ObservabilityRepository;
  /** The tenant the trail is read in. */
  readonly scope: EnvironmentScope;
  /** A SECOND tenant, so a cross-tenant read has something to fail to see. */
  readonly foreignScope: EnvironmentScope;
  readonly ids: ObservabilityConformanceIds;
  /** Open one transaction. The double's stand-in, or the adapter's unit of work. */
  run<Value>(work: (transaction: TransactionScope) => Promise<NotResult<Value>>): Promise<Value>;
}

export type ObservabilityObservation = Record<string, unknown>;

const AT = new Date("2026-05-01T09:00:00.000Z");

/** The three operators the scenario writes as. Plain strings: the column has no key. */
export const OPERATOR = asIdentifier<PrincipalId>("11111111-1111-4111-8111-111111111111");
export const OTHER_OPERATOR = asIdentifier<PrincipalId>("22222222-2222-4222-8222-222222222222");

/**
 * A `Result`, reduced to what compares across two stores.
 *
 * The error's CODE, CATEGORY and `reason` are all recorded, because two guards
 * that share a code cannot be told apart and a transcript that recorded only
 * `ok: false` would not notice.
 */
export function auditOutcome<Value>(
  result: Result<Value>,
  project: (value: Value) => unknown,
): Record<string, unknown> {
  if (result.ok) return { ok: true, value: project(result.value) };
  return {
    ok: false,
    code: result.error.code,
    category: result.error.category,
    reason: result.error.details["reason"] ?? null,
  };
}

/** The whole record, projected. Nothing is normalised: both sides return this. */
function projectRecord(record: AdminAuditRecord): unknown {
  return {
    adminAuditId: record.adminAuditId,
    scope: record.scope,
    actorUserId: record.actorUserId,
    action: record.action,
    subjectType: record.subjectType,
    subjectId: record.subjectId,
    before: record.before,
    after: record.after,
    reason: record.reason,
    source: record.source,
    recordedAt: record.recordedAt,
  };
}

function projectPage(records: readonly AdminAuditRecord[]): unknown {
  return records.map((record) => ({
    adminAuditId: record.adminAuditId,
    action: record.action,
    subjectId: record.subjectId,
    actorUserId: record.actorUserId,
    source: record.source,
    recordedAt: record.recordedAt,
  }));
}

function auditQuery(
  scope: EnvironmentScope,
  overrides: Partial<Omit<AdminAuditQuery, "scope">> = {},
): AdminAuditQuery {
  return { scope, limit: 50, ...overrides };
}

function record(
  scope: EnvironmentScope,
  adminAuditId: string,
  overrides: Partial<Omit<AdminAuditRecord, "adminAuditId" | "scope">> = {},
): AdminAuditRecord {
  return {
    adminAuditId: asIdentifier(adminAuditId),
    scope,
    actorUserId: OPERATOR,
    action: "agent.delete",
    subjectType: "Agent",
    subjectId: "agent-7",
    before: { name: "support bot", isActive: true },
    after: null,
    reason: "retired by the owner",
    source: "ui",
    recordedAt: AT,
    ...overrides,
  };
}

/**
 * Drive the whole scenario and record what came back.
 *
 * The sequence is fixed and the observations are keyed by STEP NAME, so a
 * divergence names the call rather than an index into an array.
 */
export async function runObservabilityConformance(
  environment: ObservabilityConformanceEnvironment,
): Promise<ObservabilityObservation> {
  const { repository, scope, foreignScope, ids } = environment;
  const observed: ObservabilityObservation = {};

  // ------------------------------------------------------------- the writes
  const first = await runResult(environment, (transaction) =>
    repository.recordAdminAudit(record(scope, ids.first), transaction),
  );
  observed["record.first"] = auditOutcome(first, projectRecord);

  // A second action by the SAME operator, one second later, with both snapshots
  // present. `before` and `after` are the two columns the migration guards with
  // an object-root CHECK, and a record carrying both is the only one that
  // measures both.
  const second = await runResult(environment, (transaction) =>
    repository.recordAdminAudit(
      record(scope, ids.second, {
        action: "agent.update",
        subjectId: "agent-9",
        before: { maxSteps: 10 },
        after: { maxSteps: 20 },
        reason: null,
        source: "api",
        recordedAt: new Date(AT.getTime() + 1000),
      }),
      transaction,
    ),
  );
  observed["record.second"] = auditOutcome(second, projectRecord);

  // A SCHEDULED sweep: no operator at all. `domain/admin-audit.ts` rule 1 says an
  // absent actor is recorded as absent and never backfilled, and the column is
  // nullable so both stores can hold it.
  const third = await runResult(environment, (transaction) =>
    repository.recordAdminAudit(
      record(scope, ids.third, {
        actorUserId: null,
        action: "environment.archive",
        subjectType: "Environment",
        subjectId: null,
        before: null,
        after: null,
        reason: null,
        source: "scheduled",
        recordedAt: new Date(AT.getTime() + 2000),
      }),
      transaction,
    ),
  );
  observed["record.third"] = auditOutcome(third, projectRecord);

  // One row in the SECOND tenant, by the same operator. Everything below that
  // says "this organization" is measured against it.
  const foreign = await runResult(environment, (transaction) =>
    repository.recordAdminAudit(
      record(foreignScope, ids.foreign, {
        action: "agent.delete",
        subjectId: "agent-7",
        recordedAt: new Date(AT.getTime() + 3000),
      }),
      transaction,
    ),
  );
  observed["record.foreign"] = auditOutcome(foreign, projectRecord);

  // -------------------------------------------------------------- the reads
  observed["list.all"] = auditOutcome(await repository.listAdminAudit(auditQuery(scope)), projectPage);

  observed["list.byAction"] = auditOutcome(
    await repository.listAdminAudit(auditQuery(scope, { action: "agent.delete" })),
    projectPage,
  );

  observed["list.bySubjectType"] = auditOutcome(
    await repository.listAdminAudit(auditQuery(scope, { subjectType: "Environment" })),
    projectPage,
  );

  observed["list.bySubjectId"] = auditOutcome(
    await repository.listAdminAudit(auditQuery(scope, { subjectId: "agent-9" })),
    projectPage,
  );

  // Every filter at once, and every one of them matching the same row.
  observed["list.byEverything"] = auditOutcome(
    await repository.listAdminAudit(
      auditQuery(scope, { action: "agent.update", subjectType: "Agent", subjectId: "agent-9" }),
    ),
    projectPage,
  );

  // An `undefined` filter and a `null` one are BOTH absence. The port's type
  // admits all three spellings and a store that treated one as a value would
  // return an empty page for a reason no caller could see.
  observed["list.nullFilters"] = auditOutcome(
    await repository.listAdminAudit(
      auditQuery(scope, { action: null, subjectType: null, subjectId: null }),
    ),
    projectPage,
  );

  // NEWEST FIRST, capped. Two of the three rows in this tenant, in the order the
  // port's contract names.
  observed["list.capped"] = auditOutcome(
    await repository.listAdminAudit(auditQuery(scope, { limit: 2 })),
    projectPage,
  );

  // A filter matching nothing is an empty page, not a refusal.
  observed["list.noMatch"] = auditOutcome(
    await repository.listAdminAudit(auditQuery(scope, { action: "agent.create" })),
    projectPage,
  );

  // THE CROSS-TENANT READ. The foreign row exists, was written by the same
  // operator, and carries the same action and subject id — so a listing that
  // returned it would look entirely plausible.
  observed["list.foreignTenant"] = auditOutcome(
    await repository.listAdminAudit(auditQuery(foreignScope)),
    projectPage,
  );

  // ------------------------------------------------------------- the counts
  observed["count.operator"] = auditOutcome(
    await repository.countAdminAuditForActor({
      organizationId: scope.organizationId,
      actorUserId: OPERATOR,
    }),
    (total) => total,
  );

  // THE SAME ACTOR, THE OTHER ORGANIZATION. One row, and it is the one the
  // first count must NOT have included.
  observed["count.operatorForeign"] = auditOutcome(
    await repository.countAdminAuditForActor({
      organizationId: foreignScope.organizationId,
      actorUserId: OPERATOR,
    }),
    (total) => total,
  );

  // An operator who has done nothing. Zero, not a refusal.
  observed["count.unknownOperator"] = auditOutcome(
    await repository.countAdminAuditForActor({
      organizationId: scope.organizationId,
      actorUserId: OTHER_OPERATOR,
    }),
    (total) => total,
  );

  // ------------------------------------------------------------- the unlink
  //
  // ONLY THE EMPTY ONE. See this file's header: a non-empty unlink is refused by
  // the real table's append-only rule and honoured by the double, and that
  // difference is the finding rather than a step to compare. An UPDATE that
  // matches no row never fires a row-level rule, so this one is `ok(0)` on both
  // sides — the exact boundary of what the port can honour against a real
  // database.
  observed["unlink.noRows"] = auditOutcome(
    await runResult(environment, (transaction) =>
      repository.clearAdminAuditActor(
        { organizationId: scope.organizationId, actorUserId: OTHER_OPERATOR },
        transaction,
      ),
    ),
    (changed) => changed,
  );

  // And the count is unmoved by it, which is what makes the zero above a fact
  // about the table rather than about the return value.
  observed["count.afterEmptyUnlink"] = auditOutcome(
    await repository.countAdminAuditForActor({
      organizationId: scope.organizationId,
      actorUserId: OPERATOR,
    }),
    (total) => total,
  );

  return observed;
}
