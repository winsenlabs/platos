// The `observability` error catalogue.
//
// M0.4 §2 fixes `code` as a SCREAMING_SNAKE string that is immutable within a
// major, and the kernel makes an error a VALUE rather than a thrown class. Every
// code this context can produce is minted here, once, so a transport builds its
// status table from one list and an operator grepping a log finds exactly one
// definition.
//
// TWO FAMILIES, AND THE DISTINCTION IS THE POINT.
//
//   OBSERVABILITY_SINK_* say what the analytical store is doing. `DISABLED` is a
//   CHOICE — an installation with no analytical store is a supported
//   configuration and the product completes turns without one. `SCHEMA_MISSING`
//   is an installation that BELIEVES it has one and does not. Reporting the
//   second as the first is how a projection pipeline stays broken with nobody
//   told, and it is why the two have separate codes rather than one flag.
//
//   OBSERVABILITY_ENVELOPE_* say why one queued projection could not be
//   delivered. `MALFORMED` and `VERSION_UNSUPPORTED` are both terminal — neither
//   heals by waiting — and they are distinct because the operator action
//   differs: one is a defect in a producer, the other is a binary older than the
//   fleet that minted the row.
//
// THERE IS DELIBERATELY NO CODE FOR AN UNRECOGNISED EVENT NAME. ADR M0.3 §7
// decision 8 puts one outbox behind several drains, so this drain SEES envelopes
// that are not its own, and M0.4 §1.1 has a reader ignore an unknown event name.
// An envelope belonging to `eventing` is not a failure of anything, so minting an
// error for it would put another drain's routine traffic into this one's failure
// vocabulary — and, through `lastErrorCode`, into an operator's parked count.
// `domain/envelope.ts` returns an `ignore` decision instead.

import { domainError, type DomainError, type FieldViolation } from "@platos/kernel";

export const OBSERVABILITY_ERROR_CODES = [
  "OBSERVABILITY_SINK_DISABLED",
  "OBSERVABILITY_SINK_MISCONFIGURED",
  "OBSERVABILITY_SINK_UNREACHABLE",
  "OBSERVABILITY_SINK_SCHEMA_MISSING",
  "OBSERVABILITY_SINK_REJECTED_BATCH",
  "OBSERVABILITY_ENVELOPE_VERSION_UNSUPPORTED",
  "OBSERVABILITY_ENVELOPE_MALFORMED",
  "OBSERVABILITY_PROJECTION_SCOPE_MISMATCH",
  "OBSERVABILITY_QUEUE_UNAVAILABLE",
  "OBSERVABILITY_DRAIN_BUDGET_INVALID",
  "OBSERVABILITY_AUDIT_ACTION_INVALID",
  "OBSERVABILITY_AUDIT_SUBJECT_INVALID",
  "OBSERVABILITY_AUDIT_STATE_NOT_AN_OBJECT",
  "OBSERVABILITY_REPOSITORY_UNAVAILABLE",
  "OBSERVABILITY_ERASURE_PLAN_FOREIGN",
  "OBSERVABILITY_ERASURE_SUBJECT_UNADDRESSABLE",
  "OBSERVABILITY_ERASURE_RESIDUE",
  "OBSERVABILITY_ERASURE_UNVERIFIED",
] as const;

export type ObservabilityErrorCode = (typeof OBSERVABILITY_ERROR_CODES)[number];

/** A supported configuration, not a fault. Never logged at error level. */
export function sinkDisabled(reason: string): DomainError {
  return domainError("OBSERVABILITY_SINK_DISABLED", "precondition_failed", "no analytical sink is configured", {
    details: { reason },
  });
}

export function sinkMisconfigured(detail: string): DomainError {
  return domainError(
    "OBSERVABILITY_SINK_MISCONFIGURED",
    "precondition_failed",
    "an analytical sink is configured but the value is not usable",
    { details: { detail } },
  );
}

export function sinkUnreachable(detail: string, retryAfterSeconds = 30): DomainError {
  return domainError("OBSERVABILITY_SINK_UNREACHABLE", "unavailable", "analytical sink is unreachable", {
    retryAfterSeconds,
    details: { detail },
  });
}

/**
 * The sink answered, and the schema this context writes is not there.
 *
 * `precondition_failed`, not `unavailable`: retrying does not create a table,
 * and an operator has to run a migration.
 */
export function sinkSchemaMissing(missingTables: readonly string[]): DomainError {
  return domainError(
    "OBSERVABILITY_SINK_SCHEMA_MISSING",
    "precondition_failed",
    "analytical sink is reachable but does not carry the projection schema",
    { details: { missingTables: [...missingTables] } },
  );
}

export function sinkRejectedBatch(detail: string, retryAfterSeconds = 30): DomainError {
  return domainError(
    "OBSERVABILITY_SINK_REJECTED_BATCH",
    "unavailable",
    "analytical sink refused the batch",
    { retryAfterSeconds, details: { detail } },
  );
}

/**
 * A newer envelope than this binary understands.
 *
 * M0.4 §1.1 has readers ignore unknown FIELDS; a bumped schema version is the
 * producer saying the meaning changed, which is not something a reader may
 * ignore. Terminal rather than retried: waiting does not make this binary newer.
 */
export function envelopeVersionUnsupported(name: string, found: number, supported: number): DomainError {
  return domainError(
    "OBSERVABILITY_ENVELOPE_VERSION_UNSUPPORTED",
    "precondition_failed",
    "queued envelope was minted by a newer writer than this drain",
    { details: { name, found, supported } },
  );
}

export function envelopeMalformed(reason: string, fields: readonly FieldViolation[] = []): DomainError {
  return domainError(
    "OBSERVABILITY_ENVELOPE_MALFORMED",
    "invalid_input",
    "queued envelope is not the shape this projection wrote",
    { fields, details: { reason } },
  );
}

/**
 * Two parts of one Turn claiming different tenants.
 *
 * `forbidden`, not `invalid_input`: the payload parses, and what it asks for is
 * a Step of one environment filed under another environment's Turn. Every
 * aggregate over this projection is keyed by the scope columns, so admitting one
 * of these puts one tenant's token count on another tenant's invoice.
 */
export function projectionScopeMismatch(part: string, expected: string, found: string): DomainError {
  return domainError(
    "OBSERVABILITY_PROJECTION_SCOPE_MISMATCH",
    "forbidden",
    "one Turn's projection names more than one environment",
    { details: { part, expected, found } },
  );
}

export function queueUnavailable(reason: string): DomainError {
  return domainError("OBSERVABILITY_QUEUE_UNAVAILABLE", "unavailable", "projection queue is unavailable", {
    retryAfterSeconds: 5,
    details: { reason },
  });
}

export function drainBudgetInvalid(requested: number): DomainError {
  return domainError(
    "OBSERVABILITY_DRAIN_BUDGET_INVALID",
    "invalid_input",
    "a drain budget must be a positive whole number of rows",
    { details: { requested } },
  );
}

export function auditActionInvalid(message: string, fields: readonly FieldViolation[] = []): DomainError {
  return domainError("OBSERVABILITY_AUDIT_ACTION_INVALID", "invalid_input", message, { fields });
}

export function auditSubjectInvalid(message: string, fields: readonly FieldViolation[] = []): DomainError {
  return domainError("OBSERVABILITY_AUDIT_SUBJECT_INVALID", "invalid_input", message, { fields });
}

/**
 * `AdminAudit.before`/`after` are declared object roots in the canonical
 * schema's shape registry. A scalar or an array is refused rather than wrapped,
 * because wrapping would make the stored shape depend on what a caller happened
 * to send.
 */
export function auditStateNotAnObject(field: "before" | "after"): DomainError {
  return domainError(
    "OBSERVABILITY_AUDIT_STATE_NOT_AN_OBJECT",
    "invalid_input",
    "an admin-audit state snapshot must be a JSON object, or absent",
    { fields: [{ field, code: "not_an_object", message: "expected a JSON object root" }] },
  );
}

export function repositoryUnavailable(reason: string): DomainError {
  return domainError(
    "OBSERVABILITY_REPOSITORY_UNAVAILABLE",
    "unavailable",
    "observability repository is unavailable",
    { retryAfterSeconds: 5, details: { reason } },
  );
}

/**
 * The kernel's `ErasurePlan` carries no subject, so a target handed a plan it
 * did not mint cannot know whose rows to unlink. Refusing is the only safe
 * answer.
 */
export function erasurePlanForeign(targetName: string): DomainError {
  return domainError(
    "OBSERVABILITY_ERASURE_PLAN_FOREIGN",
    "precondition_failed",
    "erasure plan was not produced by this target and carries no subject to act on",
    { details: { targetName } },
  );
}

/**
 * Nothing to address means nothing can be proved.
 *
 * A blank subject id would widen to `end_user_id IN ('')`, which matches every
 * system-attributed row in the organization — one person's erasure becoming a
 * tenant-wide wipe. Refusing is the only safe reading of an empty selector.
 */
export function erasureSubjectUnaddressable(subjectKind: string): DomainError {
  return domainError(
    "OBSERVABILITY_ERASURE_SUBJECT_UNADDRESSABLE",
    "precondition_failed",
    "subject resolved to no column this projection can be addressed by",
    { details: { subjectKind } },
  );
}

/** Rows still carrying the subject's identity after the mutation was applied. */
export function erasureResidue(table: string, survivors: number): DomainError {
  return domainError(
    "OBSERVABILITY_ERASURE_RESIDUE",
    "precondition_failed",
    "rows still carry the subject's identity after erasure; the receipt would be false",
    { details: { table, survivors } },
  );
}

/**
 * The mutation was submitted and the residue count could not be read.
 *
 * Distinct from residue: this is "we do not know", and an erasure receipt that
 * cannot distinguish the two is worthless. Unverified is treated as still
 * present everywhere in this context.
 */
export function erasureUnverified(table: string, reason: string): DomainError {
  return domainError(
    "OBSERVABILITY_ERASURE_UNVERIFIED",
    "unavailable",
    "erasure could not be verified; it is reported as unproven, never as done",
    { retryAfterSeconds: 30, details: { table, reason } },
  );
}
