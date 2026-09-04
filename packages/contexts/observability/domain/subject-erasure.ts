// Erasing one subject from the rows this context is sole writer of.
//
// FIVE MODELS, ONE METHOD, AND THE METHOD IS UNLINK — NOT DELETE.
//
// The four analytical tables are a PROJECTION of work the canonical store
// already owns, and `usage_events_v1` is retained for years as financial
// evidence. Deleting a charge fact to remove an identifier that can be removed
// on its own destroys an invoice line to serve an erasure. So the subject is
// UNLINKED: `end_user_id` and the two plaintext identity columns are cleared,
// the row and its money survive, and the pseudonymous `subject_key_hash` is
// RETAINED BY POLICY so aggregates stay continuous across the erasure.
//
// `AdminAudit` is unlinked for a different reason. It is the record of who
// changed what, and destroying it to remove a name destroys the accountability
// it exists to provide. `actorUserId` is cleared; the action, the subject and
// the redacted snapshots survive.
//
// THE COLUMN NAMES ARE AN ERASURE CONTRACT. The plan below addresses the live
// tables by `organization_id`, `end_user_id`, `thread_id` and
// `subject_key_hash`. Renaming one does not break a query — it makes the table
// UNADDRESSABLE, and an erasure receipt that cannot address a table must say so
// rather than report the table clean. Adding a new plaintext identity column to
// any of these means adding it here in the same change; a column erasure cannot
// address is a column erasure does not clean.
//
// VERIFICATION IS NEGATIVE, AND UNVERIFIED IS NOT CLEAN. The receipt's claim
// rests on RE-COUNTING the subject's rows afterwards, never on the mutation
// having been accepted. A count that could not be read is `unverified`, and
// unverified is treated as still present everywhere in this context.

import type { ErasureMethod, ErasureSubject } from "@platos/kernel";

import { PROJECTION_TABLES, type ProjectionTable } from "./projection-tables.js";

/** A column an erasure empties, and what it is emptied to. */
export interface ClearedColumn {
  readonly name: string;
  /** `null` for a nullable column, the empty string otherwise. */
  readonly to: "empty" | "null";
}

export interface ErasableTable {
  readonly table: ProjectionTable;
  /** Columns carrying a canonical subject id. */
  readonly subjectIdColumns: readonly string[];
  /** Column carrying the Thread id, so a subject's threads are reachable. */
  readonly threadColumn: string;
  /** The pseudonymous key. Addressed BY, never cleared. */
  readonly subjectHashColumn: string;
  readonly cleared: readonly ClearedColumn[];
}

/**
 * Every analytical table erasure must touch, in Turn -> Step -> Tool Call ->
 * usage order.
 *
 * ENUMERATED, NEVER DISCOVERED. A list is auditable; a scan for "columns that
 * look like an id" is a loaded gun pointed at operator data, and it would clear
 * `subject_key_hash` — the one identity-shaped column policy requires to
 * survive.
 */
export const ERASABLE_TABLES: readonly ErasableTable[] = Object.freeze([
  Object.freeze({
    table: "turns_v1",
    subjectIdColumns: Object.freeze(["end_user_id"]),
    threadColumn: "thread_id",
    subjectHashColumn: "subject_key_hash",
    // The only table in the turn-shaped model carrying plaintext identity.
    cleared: Object.freeze([
      { name: "end_user_id", to: "empty" },
      { name: "user_display_name", to: "null" },
      { name: "user_email", to: "null" },
    ] as const),
  }),
  Object.freeze({
    table: "steps_v1",
    subjectIdColumns: Object.freeze(["end_user_id"]),
    threadColumn: "thread_id",
    subjectHashColumn: "subject_key_hash",
    cleared: Object.freeze([{ name: "end_user_id", to: "empty" }] as const),
  }),
  Object.freeze({
    table: "tool_calls_v1",
    subjectIdColumns: Object.freeze(["end_user_id"]),
    threadColumn: "thread_id",
    subjectHashColumn: "subject_key_hash",
    cleared: Object.freeze([{ name: "end_user_id", to: "empty" }] as const),
  }),
  Object.freeze({
    table: "usage_events_v1",
    subjectIdColumns: Object.freeze(["end_user_id"]),
    threadColumn: "thread_id",
    subjectHashColumn: "subject_key_hash",
    // Immutable charge facts: unlink the subject, keep the money.
    cleared: Object.freeze([{ name: "end_user_id", to: "empty" }] as const),
  }),
]);

/** The canonical-store model this context also owns. */
export const ADMIN_AUDIT_MODEL = "AdminAudit";

/** Every model this target reports on, analytical first then canonical. */
export const ERASABLE_MODELS: readonly string[] = Object.freeze([
  ...ERASABLE_TABLES.map((entry) => entry.table),
  ADMIN_AUDIT_MODEL,
]);

/** Unlink, never delete. See this file's header for why, per model. */
export const ERASURE_METHOD: ErasureMethod = "anonymize";

/**
 * The plan covers every projection table, in canonical order, and no others.
 *
 * A predicate rather than a comment, so "someone added a fifth table and did not
 * add it to the erasure plan" is a failing test rather than a discovery made
 * during an erasure.
 */
export function planCoversEveryProjectionTable(): boolean {
  const planned = ERASABLE_TABLES.map((entry) => entry.table);
  return (
    planned.length === PROJECTION_TABLES.length &&
    PROJECTION_TABLES.every((table, index) => planned[index] === table)
  );
}

/**
 * How a subject is addressed in the analytical store.
 *
 * Three independent locators, OR-ed. The thread and hash locators exist because
 * a row whose `end_user_id` was already blank — a system-attributed Step, a row
 * from before the id was recorded — is still the subject's row, and addressing
 * it only by id would leave it behind.
 */
export interface SubjectAddress {
  readonly organizationId: string;
  /** Canonical end-user ids. NEVER blank: see `addressSubject`. */
  readonly endUserIds: readonly string[];
  /** Thread ids, read while the canonical store still holds them. */
  readonly threadIds: readonly string[];
  /** Salted, organization-scoped subject keys. Content-free by construction. */
  readonly subjectKeyHashes: readonly string[];
}

function distinctNonBlank(values: readonly string[]): readonly string[] {
  return [...new Set(values.filter((value) => typeof value === "string" && value.trim().length > 0))];
}

/**
 * Build the address for a subject.
 *
 * Blank values are dropped BEFORE they reach a predicate. `end_user_id IN ('')`
 * matches every system-attributed row in the organization, which would turn one
 * person's erasure into a tenant-wide wipe — so a blank is not a weak locator,
 * it is a catastrophic one, and it is removed here rather than guarded for
 * later.
 */
export function addressSubject(
  subject: ErasureSubject,
  threadIds: readonly string[] = [],
  subjectKeyHashes: readonly string[] = [],
): SubjectAddress {
  // Only an end-user is addressable in the analytical store: its identity
  // columns hold EndUser ids. An operator or an entity subject yields no id
  // locator, and reporting a zero-row plan is more honest than omitting this
  // target from the operation.
  const endUserIds = subject.subjectKind === "end-user" ? distinctNonBlank([subject.subjectId]) : [];
  return {
    organizationId: subject.scope.organizationId,
    endUserIds,
    threadIds: distinctNonBlank(threadIds),
    subjectKeyHashes: distinctNonBlank(subjectKeyHashes),
  };
}

/** True when the address names nothing, so nothing can be proved about it. */
export function addressIsVacuous(address: SubjectAddress): boolean {
  return (
    address.endUserIds.length === 0 &&
    address.threadIds.length === 0 &&
    address.subjectKeyHashes.length === 0
  );
}

/** One OR-ed locator: a column, and the values that identify the subject in it. */
export interface SubjectLocator {
  readonly column: string;
  readonly values: readonly string[];
}

/**
 * Everything an adapter needs to build one statement, and nothing vendor-shaped.
 *
 * `organizationId` is AND-ed, the locators are OR-ed together, and `residue` is
 * AND-ed on top as "at least one cleared column is still non-empty".
 *
 * THE RESIDUE CLAUSE IS WHY VERIFICATION MEANS ANYTHING. Without it,
 * verification would be a tautology: the mutation empties the very columns the
 * locator matches on, so re-running the locator alone returns zero whether or
 * not the mutation ran. What must be proved is that no row for this subject
 * STILL CARRIES identity — and the hash column is deliberately not part of that,
 * because policy retains it. The count before and the count after are the SAME
 * predicate, so they cannot drift.
 */
export interface SubjectPredicate {
  readonly organizationId: string;
  readonly locators: readonly SubjectLocator[];
  readonly residue: readonly ClearedColumn[];
}

/**
 * Build the predicate for one table, or null when the subject cannot be
 * addressed in it at all.
 *
 * Null is not "match nothing" — it is "do not run a statement". A predicate with
 * no locator degenerates to `organization_id = ?`, which is every row the tenant
 * has, and the residue clause would not save it: for `turns_v1` that would clear
 * the display name and email of every person in the organization.
 */
export function buildSubjectPredicate(
  table: ErasableTable,
  address: SubjectAddress,
): SubjectPredicate | null {
  const locators: SubjectLocator[] = [];
  if (address.endUserIds.length > 0) {
    for (const column of table.subjectIdColumns) {
      locators.push({ column, values: address.endUserIds });
    }
  }
  if (address.threadIds.length > 0) {
    locators.push({ column: table.threadColumn, values: address.threadIds });
  }
  if (address.subjectKeyHashes.length > 0) {
    locators.push({ column: table.subjectHashColumn, values: address.subjectKeyHashes });
  }
  if (locators.length === 0) return null;
  return { organizationId: address.organizationId, locators, residue: table.cleared };
}

/**
 * The columns a predicate proves emptiness of.
 *
 * `subject_key_hash` is never among them, and that is the policy: the row stays
 * joinable under its pseudonym after the person is unlinked.
 */
export function residueColumns(predicate: SubjectPredicate): readonly string[] {
  return predicate.residue.map((column) => column.name);
}

/**
 * Whether `AdminAudit` can be addressed for this subject.
 *
 * `actorUserId` holds an operator principal, so only a `user` subject reaches
 * it. An end-user never performed an admin action, and an entity is not a
 * person.
 */
export function adminAuditActorFor(subject: ErasureSubject): string | null {
  if (subject.subjectKind !== "user") return null;
  const value = subject.subjectId.trim();
  return value.length > 0 ? value : null;
}
