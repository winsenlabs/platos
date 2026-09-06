// The `AdminAudit` row, and the two directions it is read and written in.
//
// ONE TABLE, AND EVERYTHING INTERESTING ABOUT IT IS WHAT THE ROW DOES NOT HOLD.
//
// `AdminAudit` stores ONE scope column, `environmentId`. The port's
// `AdminAuditRecord` carries an `EnvironmentScope` — organization, project and
// environment — so two thirds of the scope on every record this store returns is
// NOT in the row. It comes from the PREDICATE the row was found by:
// `environmentWhere` below is the full chain, resolved by the database as
// correlated subqueries in the same statement, so a row that comes back has
// already been proved to sit under the project and organization the caller
// named, and handing that scope back is a consequence of the WHERE rather than
// an echo of the request.
//
// AND IT IS A CONSEQUENCE ONLY WHILE THE WHERE IS WHOLE, which is why the two
// relation clauses are in one function that every read shares and why two named
// cases in `observability-constraints.integration.test.ts` read a foreign tenant
// and require an EMPTY page. Drop either clause and the scope handed back stops
// being a fact.
//
// WHY NOT LOAD THE ANCESTRY AND READ IT OFF THE ROW. That was the first shape,
// and the statement counter refused it: the client resolves a nested relation
// `select` as SEPARATE queries — one for `AdminAudit`, one for `Environment`,
// one for `Project` — so a one-statement listing became three and an append
// became five. The cost is constant rather than per row, so it was not an N+1;
// it was two round trips buying a fact the WHERE had already established.
//
// `AdminAudit` HAS NO ANCESTRY RULE, which is why the chain has to be in the
// WHERE at all. Thirty-eight tables in `00000000000000_initial/migration.sql`
// carry `enforce_domain_ancestry`; this one does not. Its only structural
// guarantee is `AdminAudit_environmentId_fkey`, which proves the environment
// EXISTS and says nothing about whose it is. Without the relation clauses below,
// an audit trail read for organization A would return rows belonging to
// organization B whenever a caller passed an environment id from B — the row
// would still be one row, and every count in this package would still be
// internally consistent.
//
// THE TWO JSON COLUMNS ARE OBJECT ROOTS OR SQL NULL, and the migration says so
// twice: `AdminAudit_before_json_root` and `AdminAudit_after_json_root` are both
// `IS NULL OR jsonb_typeof(...) = 'object'`. Not `IN ('object', 'array')`, which
// is the shape every other `*_json_root` in that file uses — an array is refused
// here. `domain/admin-audit.ts` already refuses a non-object on the way in, so
// the reader below is what stands between a row an OLDER binary wrote and a
// record whose `before` is a number.

import {
  asIdentifier,
  asObject,
  DEFAULT_AUDIT_SOURCE,
  type AdminAuditId,
  type AdminAuditRecord,
  type AuditState,
  type EnvironmentScope,
  type PrincipalId,
} from "@platos/context-observability/application/ports/index.js";

import { UnreadableRowError } from "./mapping.js";

/** `AdminAudit.before` or `.after` holds something that is not an object root. */
export const AUDIT_STATE_NOT_AN_OBJECT = "observability.row.audit_state_not_an_object";

/**
 * A row came back from a read whose predicate should have excluded it.
 *
 * ITS OWN CODE, because it is a different incident from an unreadable column: a
 * row this store cannot READ is an expand/contract event, and a row this store
 * should never have SEEN is a widened predicate — and the second one is a
 * cross-tenant read. Sharing a code would make the two one line in a log.
 */
export const AUDIT_ROW_OUTSIDE_SCOPE = "observability.row.audit_row_outside_scope";

/** Exactly the columns a full read selects. No relation is loaded: see the header. */
export interface AdminAuditRow {
  readonly id: string;
  readonly environmentId: string;
  readonly actorUserId: string | null;
  readonly action: string;
  readonly subjectType: string;
  readonly subjectId: string | null;
  readonly before: unknown;
  readonly after: unknown;
  readonly reason: string | null;
  readonly source: string | null;
  readonly createdAt: Date;
}

/**
 * Restrict a read to ONE environment, under the project and organization the
 * caller named.
 *
 * ALL THREE CLAUSES, IN ONE STATEMENT. `environmentId` alone would be the
 * cross-tenant read described in the header; the two relation clauses are what
 * make the scope this store hands back true, and they cost no extra round trip
 * because the database resolves them as subqueries on the read it was already
 * doing.
 */
export function environmentWhere(scope: EnvironmentScope): Record<string, unknown> {
  return {
    environmentId: scope.environmentId,
    environment: {
      projectId: scope.projectId,
      project: { organizationId: scope.organizationId },
    },
  };
}

/**
 * Restrict a read to every environment ONE ORGANIZATION reaches.
 *
 * `AdminAuditActorSelector` names an organization and an actor and no
 * environment, because an erasure is organization-scoped. The containment is a
 * relation filter through `Environment` and `Project`, resolved by the database
 * in the SAME statement — not a widening read of the tree followed by an `IN`
 * list, which is the N+1 this shape is easy to write by accident, and which
 * `observability-statements.integration.test.ts` pins at a fixed count for a
 * small fixture and a large one.
 */
export function organizationWhere(organizationId: string): Record<string, unknown> {
  return { environment: { project: { organizationId } } };
}

/** The columns every full read selects. One place, so no read is wider. */
export const AUDIT_COLUMNS = {
  id: true,
  environmentId: true,
  actorUserId: true,
  action: true,
  subjectType: true,
  subjectId: true,
  before: true,
  after: true,
  reason: true,
  source: true,
  createdAt: true,
} as const;

/**
 * One stored snapshot column, as an object root or absent.
 *
 * SQL NULL is absence and reads as `null`. Anything else must be an object,
 * because that is what the CHECK admits and what the domain's own
 * `readAuditState` produces — and a value that is neither is a row this binary
 * cannot read, which is an expand/contract event rather than a shrug. Casting
 * it would put a number where every reader of `AdminAuditRecord` expects a bag
 * of fields, and the first thing to notice would be a caller indexing into it.
 */
export function readAuditSnapshot(value: unknown, column: "before" | "after"): AuditState | null {
  if (value === null || value === undefined) return null;
  const object = asObject(value);
  if (object === undefined) {
    throw new UnreadableRowError(
      AUDIT_STATE_NOT_AN_OBJECT,
      `AdminAudit.${column}`,
      typeof value === "string" ? value : (JSON.stringify(value) ?? String(value)),
    );
  }
  return object;
}

/**
 * The stored `source`, or what the domain says an unstated one is.
 *
 * `AdminAudit.source` is nullable and `AdminAuditRecord.source` is not, so the
 * two disagree about one row: the one written before this store existed, by a
 * writer that did not say. `DEFAULT_AUDIT_SOURCE` is the domain's OWN published
 * answer to "what `source` becomes when a caller does not say", so applying it
 * here is that rule read back rather than a fact this adapter invented — and it
 * is why the constant is imported instead of spelled.
 */
export function readAuditSource(value: string | null): string {
  return value === null ? DEFAULT_AUDIT_SOURCE : value;
}

/**
 * A stored row as the record its port publishes.
 *
 * `scope` is the scope the row was PROVED to be in — `environmentWhere`'s three
 * clauses on a read, and the ancestry statement `recordAdminAudit` sends before
 * its INSERT on a write. It is a parameter rather than a column because the
 * table has no column for two thirds of it; it is not the caller's unchecked
 * claim because nothing reaches this function until the database has agreed with
 * it. `environmentId` is asserted against it below, so a row that somehow
 * arrived from outside the predicate is refused rather than relabelled.
 */
export function readAdminAudit(row: AdminAuditRow, scope: EnvironmentScope): AdminAuditRecord {
  if (row.environmentId !== scope.environmentId) {
    throw new UnreadableRowError(AUDIT_ROW_OUTSIDE_SCOPE, "AdminAudit.environmentId", row.environmentId);
  }
  return {
    adminAuditId: asIdentifier<AdminAuditId>(row.id),
    scope,
    actorUserId: row.actorUserId === null ? null : asIdentifier<PrincipalId>(row.actorUserId),
    action: row.action,
    subjectType: row.subjectType,
    subjectId: row.subjectId,
    before: readAuditSnapshot(row.before, "before"),
    after: readAuditSnapshot(row.after, "after"),
    reason: row.reason,
    source: readAuditSource(row.source),
    recordedAt: row.createdAt,
  };
}
