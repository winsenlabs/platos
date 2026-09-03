// The admin-action audit record.
//
// ADR M0.3 §1 row 12 makes this context the SOLE WRITER of `AdminAudit`. It
// complements the tool-call audit that `tools` owns: that one records what an
// agent dispatched, this one records what a HUMAN OPERATOR changed, so the
// question "who deleted agent X at 14:02, and what did it look like before?" has
// an answer.
//
// FOUR RULES, AND EACH ONE IS A THING THAT WENT WRONG SOMEWHERE:
//
// 1. THE ACTOR MAY BE ABSENT, AND WHO ACTED MAY NOT BE GUESSED. A scheduled
//    sweep has no operator. `actorUserId` is therefore nullable, and `source`
//    says which kind of actor it was — but an absent actor is recorded as absent,
//    never backfilled with whoever happened to be in scope.
//
// 2. `before` AND `after` ARE JSON OBJECT ROOTS OR ABSENT. The canonical
//    schema's shape registry declares both as object roots, and it states that
//    JSON null is not a substitute for an absent value. A scalar or an array is
//    refused rather than wrapped, because wrapping makes the stored shape depend
//    on what a caller happened to send, and a reader then has to guess.
//
// 3. THE SNAPSHOTS ARE REDACTED BY THE CALLER, AND TRUNCATED HERE. This context
//    cannot know which of a caller's fields is a secret. What it CAN do is
//    refuse to grow without bound: an audit row holding a whole agent version's
//    prompt is a log that nobody reads and a table that nobody can query.
//
// 4. AN AUDIT WRITE MUST NOT BE THE REASON AN ADMIN ACTION FAILS. That rule is
//    carried out in the application layer, which is where the transaction is;
//    what belongs here is that a REJECTED record is a typed refusal a caller can
//    branch on, rather than a thrown exception that unwinds their work.

import { err, ok, type EnvironmentScope, type PrincipalId, type Result } from "@platos/kernel";

import { auditActionInvalid, auditStateNotAnObject, auditSubjectInvalid } from "./errors.js";
import { asObject } from "./json-read.js";
import type { AdminAuditId } from "./identifiers.js";

/** Where the action came from. Open, not an enum: the column is a String. */
export const KNOWN_AUDIT_SOURCES = ["ui", "api", "scheduled"] as const;

/** What `source` becomes when a caller does not say. */
export const DEFAULT_AUDIT_SOURCE = "api";

/** Longest an action, subject type, subject id or reason may be. */
export const AUDIT_ACTION_MAX_LENGTH = 128;
export const AUDIT_REASON_MAX_LENGTH = 512;

/**
 * Longest a serialized state snapshot may be.
 *
 * A cap, not a schema. See rule 3 above: the point is that the table stays
 * queryable, not that this context understands the caller's shapes.
 */
export const AUDIT_STATE_MAX_BYTES = 64 * 1024;

/** A dotted, lower-case action name — `agent.delete`, `entity.secret.rotate`. */
const ACTION_PATTERN = /^[a-z][a-z0-9]*(?:[._-][a-z0-9]+)*$/u;

/** A redacted state snapshot: an object root, or absent. */
export type AuditState = { readonly [key: string]: unknown };

export interface AdminActionRequest {
  readonly scope: EnvironmentScope;
  /** Null for an action no operator performed — a scheduled sweep. */
  readonly actorUserId: PrincipalId | null;
  readonly action: string;
  readonly subjectType: string;
  readonly subjectId?: string | null;
  readonly before?: unknown;
  readonly after?: unknown;
  readonly reason?: string | null;
  readonly source?: string | null;
}

/** The record as it will be stored. Every field already validated and bounded. */
export interface AdminAuditRecord {
  readonly adminAuditId: AdminAuditId;
  readonly scope: EnvironmentScope;
  readonly actorUserId: PrincipalId | null;
  readonly action: string;
  readonly subjectType: string;
  readonly subjectId: string | null;
  readonly before: AuditState | null;
  readonly after: AuditState | null;
  readonly reason: string | null;
  readonly source: string;
  readonly recordedAt: Date;
}

function trimmed(value: string | null | undefined): string {
  return typeof value === "string" ? value.trim() : "";
}

/**
 * Validate one state snapshot.
 *
 * `undefined` is absence and is allowed. `null` is NOT: the shape registry says
 * JSON null is not a substitute for an absent value, and a column holding null
 * reads as "the state was empty" rather than "no snapshot was taken".
 */
export function readAuditState(value: unknown, field: "before" | "after"): Result<AuditState | null> {
  if (value === undefined) return ok(null);
  const object = asObject(value);
  if (!object) return err(auditStateNotAnObject(field));
  const serialized = JSON.stringify(object);
  if (serialized !== undefined && serialized.length > AUDIT_STATE_MAX_BYTES) {
    return err(
      auditActionInvalid(
        `admin-audit ${field} snapshot exceeds the ${AUDIT_STATE_MAX_BYTES}-byte cap`,
        [{ field, code: "too_large", message: `${serialized.length} bytes` }],
      ),
    );
  }
  return ok(object);
}

/**
 * Build the record, or say why not.
 *
 * Every refusal below is `invalid_input` on a field a caller controls, which is
 * what makes an audit write safe to place inside an admin action's transaction:
 * the caller learns it built a bad record before anything was written, not
 * after.
 */
export function buildAdminAuditRecord(
  adminAuditId: AdminAuditId,
  request: AdminActionRequest,
  recordedAt: Date,
): Result<AdminAuditRecord> {
  const action = trimmed(request.action);
  if (action.length === 0) {
    return err(auditActionInvalid("an admin-audit action is required"));
  }
  if (action.length > AUDIT_ACTION_MAX_LENGTH) {
    return err(auditActionInvalid(`an admin-audit action may not exceed ${AUDIT_ACTION_MAX_LENGTH} characters`));
  }
  if (!ACTION_PATTERN.test(action)) {
    return err(
      auditActionInvalid("an admin-audit action must be a dotted lower-case name", [
        { field: "action", code: "malformed", message: "expected e.g. agent.delete" },
      ]),
    );
  }

  const subjectType = trimmed(request.subjectType);
  if (subjectType.length === 0) {
    return err(auditSubjectInvalid("an admin-audit subject type is required"));
  }
  if (subjectType.length > AUDIT_ACTION_MAX_LENGTH) {
    return err(
      auditSubjectInvalid(`an admin-audit subject type may not exceed ${AUDIT_ACTION_MAX_LENGTH} characters`),
    );
  }

  const before = readAuditState(request.before, "before");
  if (!before.ok) return err(before.error);
  const after = readAuditState(request.after, "after");
  if (!after.ok) return err(after.error);

  const subjectId = trimmed(request.subjectId);
  const reason = trimmed(request.reason);
  const source = trimmed(request.source);

  return ok(
    Object.freeze({
      adminAuditId,
      scope: request.scope,
      actorUserId: request.actorUserId,
      action,
      subjectType,
      subjectId: subjectId.length > 0 ? subjectId : null,
      before: before.value,
      after: after.value,
      reason: reason.length > 0 ? reason.slice(0, AUDIT_REASON_MAX_LENGTH) : null,
      source: source.length > 0 ? source : DEFAULT_AUDIT_SOURCE,
      recordedAt,
    }),
  );
}

/**
 * True when the record names a change — a before, an after, or both.
 *
 * A record with neither is still legitimate (a read-only reveal, an export), so
 * this is a question a reader may ask, never a rule the writer enforces.
 */
export function recordsAStateChange(record: AdminAuditRecord): boolean {
  return record.before !== null || record.after !== null;
}

/** How an audit trail is read back. Environment-scoped, newest first. */
export interface AdminAuditQuery {
  readonly scope: EnvironmentScope;
  readonly action?: string | null;
  readonly subjectType?: string | null;
  readonly subjectId?: string | null;
  readonly limit: number;
}

/** Largest page a caller may ask for, and what an absent limit becomes. */
export const AUDIT_PAGE_MAX = 200;
export const AUDIT_PAGE_DEFAULT = 50;

export function resolveAuditLimit(requested: number | null | undefined): number {
  if (typeof requested !== "number" || !Number.isFinite(requested) || requested < 1) {
    return AUDIT_PAGE_DEFAULT;
  }
  return Math.min(AUDIT_PAGE_MAX, Math.floor(requested));
}
