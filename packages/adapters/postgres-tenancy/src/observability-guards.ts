// What this store refuses BEFORE it sends a statement, and the one refusal the
// DATABASE keeps for itself.
//
// EVERY CODE HERE IS DISTINCT, and that is the point rather than a convention.
// Four of the five guards below answer a different mistake — an id the `@db.Uuid`
// column cannot parse, an actor nobody named, an organization nobody named, a
// page size the driver would read backwards — and a shared code would make two
// of them one incident in a log.
//
// PRE-CHECKING IS NOT TIDINESS, IT IS TRANSACTION SURVIVAL. On PostgreSQL a
// raised constraint aborts the whole transaction, so a value refused by the
// column rather than by this file takes the admin action the audit row was
// supposed to be part of down with it. `domain/admin-audit.ts` rule 4 says an
// audit write must not be the reason an admin action fails; these guards are how
// that survives contact with a real database.
//
// THE FIFTH REFUSAL IS NOT A GUARD AND MUST NOT BECOME ONE. `AdminAudit` is
// APPEND-ONLY IN THE DATABASE — `00000000000000_initial/migration.sql` installs
// `reject_admin_audit_mutation()` on UPDATE, on DELETE and on TRUNCATE, and
// withdraws all three from PUBLIC — so `clearAdminAuditActor` cannot be honoured
// at all. `ADMIN_AUDIT_IMMUTABLE_RAISE` below is the string the database raises,
// and `observability-audit.ts` MAPS it rather than anticipating it: an adapter
// that refused the unlink without sending it would be asserting a fact about a
// database it never asked, and the day the rule is dropped the adapter would go
// on refusing.

/** An identifier bound for a `@db.Uuid` column that is not a uuid. */
export const OBSERVABILITY_IDENTIFIER_NOT_UUID = "observability.write.identifier_not_uuid";

/** An actor selector naming no actor. The port says "Never blank". */
export const AUDIT_ACTOR_BLANK = "observability.write.audit_actor_blank";

/** An actor selector naming no organization, which reaches every tenant. */
export const AUDIT_ORGANIZATION_BLANK = "observability.write.audit_organization_blank";

/** A page size the database would not read as a page size. */
export const AUDIT_PAGE_LIMIT_INVALID = "observability.read.audit_page_limit_invalid";

/**
 * The record's environment is not under the record's project and organization.
 *
 * `AdminAudit` carries no ancestry rule and one scope column, so nothing in the
 * database relates the environment the row is filed under to the organization
 * the record CLAIMS. Left unchecked, an audit row could be written naming
 * organization A and then counted, listed and erased under organization B —
 * with `AdminAudit_environmentId_fkey` satisfied throughout, because the
 * environment does exist. This is the one write guard that costs a statement,
 * and it is the statement that makes the other three port methods agree with
 * each other.
 */
export const AUDIT_SCOPE_UNRESOLVED = "observability.write.audit_scope_unresolved";

/**
 * The message `reject_admin_audit_mutation()` raises, with SQLSTATE 23514.
 *
 * Quoted from `00000000000000_initial/migration.sql`. It is matched on rather
 * than the SQLSTATE alone because 23514 is `check_violation` and every
 * `*_json_root` CHECK on this same table raises it too — telling "this table
 * cannot be changed" apart from "that column is not an object" is exactly the
 * distinction two identical codes would destroy.
 */
export const ADMIN_AUDIT_IMMUTABLE_RAISE = "AdminAudit is immutable";

/** The code this store reports the database's own append-only refusal under. */
export const ADMIN_AUDIT_IMMUTABLE = "observability.write.admin_audit_immutable";

export class ObservabilityStoreRefused extends Error {
  readonly code: string;
  readonly detail: string;

  constructor(code: string, detail: string) {
    super(`${code}: ${detail}`);
    this.name = "ObservabilityStoreRefused";
    this.code = code;
    this.detail = detail;
  }
}

/**
 * The canonical uuid shape, as the database itself parses it.
 *
 * The same expression `governance-guards.ts` uses, and deliberately not a looser
 * hex-and-dashes pattern: PostgreSQL's `uuid` input accepts several spellings,
 * and a guard that admitted one the `@db.Uuid` column then refused would be a
 * guard that does not guard.
 */
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;

export function isAuditUuid(value: string): boolean {
  return UUID.test(value);
}

/** Refuse a value bound for a `@db.Uuid` column. `null` is always allowed. */
export function requireAuditUuid(column: string, value: string | null): void {
  if (value === null) return;
  if (!isAuditUuid(value)) {
    throw new ObservabilityStoreRefused(
      OBSERVABILITY_IDENTIFIER_NOT_UUID,
      `${column} is not a uuid: ${JSON.stringify(value)}`,
    );
  }
}

/**
 * Refuse an actor selector that names nobody.
 *
 * BLANK IS NOT "MATCH NOTHING", IT IS A QUESTION NOBODY ASKED.
 * `AdminAudit.actorUserId` is a plain nullable `TEXT`, so `WHERE "actorUserId"
 * = ''` is a legal statement that quietly returns zero — and a count of zero is
 * what an erasure plan reports as "this target holds nothing about the subject".
 * The refusal is what stops an unaddressable subject being certified clean.
 */
export function requireAuditActor(organizationId: string, actorUserId: string): void {
  if (organizationId.trim().length === 0) {
    throw new ObservabilityStoreRefused(
      AUDIT_ORGANIZATION_BLANK,
      "an admin-audit actor selector must name an organization",
    );
  }
  if (actorUserId.trim().length === 0) {
    throw new ObservabilityStoreRefused(
      AUDIT_ACTOR_BLANK,
      "an admin-audit actor selector must name an actor",
    );
  }
}

/**
 * Refuse a page size the driver would not read as one.
 *
 * A NEGATIVE `take` IS NOT AN EMPTY PAGE. The client reads it as "the last N, in
 * reverse", so `limit: -1` returns the OLDEST row of the trail from a method
 * whose contract says newest first — the exact opposite of what was asked, with
 * a row in hand and no error anywhere. A fractional one is refused for a duller
 * reason: the driver rounds, and a page size that changes under rounding makes
 * two identical calls disagree.
 */
export function requireAuditLimit(limit: number): void {
  if (!Number.isInteger(limit) || limit < 0) {
    throw new ObservabilityStoreRefused(
      AUDIT_PAGE_LIMIT_INVALID,
      `an admin-audit page size must be a non-negative whole number: ${JSON.stringify(limit)}`,
    );
  }
}

/** True for the append-only refusal the database raises on any matched UPDATE. */
export function isAdminAuditImmutable(error: unknown): boolean {
  return error instanceof Error && error.message.includes(ADMIN_AUDIT_IMMUTABLE_RAISE);
}
