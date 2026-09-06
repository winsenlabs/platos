// The one place a thrown thing becomes a `Result` for `observability`'s store.
//
// THE PORT'S METHODS ALL RETURN `Result`, and three kinds of throw reach this
// store. Two of them are outcomes:
//
//   `ObservabilityStoreRefused` — a value the canonical schema will not hold, or
//   a selector that names nobody, caught before any statement was sent. An
//   outcome.
//
//   `UnreadableRowError` — a stored `before` or `after` this binary cannot read,
//   which is a real expand/contract event and the reason `observability-rows.ts`
//   validates rather than casts. An outcome.
//
//   `TransactionScopeError` — a write issued outside any transaction, with a
//   finished token, or with another transaction's token. NOT an outcome, and
//   deliberately RETHROWN: those three refusals carry three distinct codes so
//   the three mistakes stay distinguishable, and converting them to a `Result`
//   here would let a use case that lost its transaction carry on as though a row
//   had merely failed to write.
//
// THE DATABASE'S APPEND-ONLY REFUSAL IS GIVEN ITS OWN CODE, and that is the
// whole reason this file is not a copy of `governance-refusal.ts`. Folding
// `AdminAudit is immutable` into the generic driver branch would report a
// PERMANENT structural refusal — a port method that can never succeed against a
// database these migrations build — under the same string as a dropped
// connection, and the operator reading the log would retry for ever.
//
// EVERYTHING ELSE IS ALSO RETHROWN. A `TypeError` in this package is a bug in
// this package, and a store that folded it into
// `OBSERVABILITY_REPOSITORY_UNAVAILABLE` would report a defect as an outage.

import {
  err,
  repositoryUnavailable,
  type Result,
} from "@platos/context-observability/application/ports/index.js";

import {
  ADMIN_AUDIT_IMMUTABLE,
  isAdminAuditImmutable,
  ObservabilityStoreRefused,
} from "./observability-guards.js";
import { UnreadableRowError } from "./mapping.js";

/** True for the driver's own errors, whatever SQLSTATE they carry. */
function isDriverError(error: unknown): boolean {
  return error instanceof Error && error.name.startsWith("PrismaClient");
}

/**
 * The reason string a refusal carries.
 *
 * The distinct CODE leads, so `details.reason` on the returned `DomainError`
 * begins with the code a caller matches on and the human detail follows it. Two
 * guards with one code cannot be told apart in a log; two guards whose codes
 * lead the same string can.
 */
function reasonOf(error: unknown, label: string): string {
  if (isAdminAuditImmutable(error)) {
    return `${ADMIN_AUDIT_IMMUTABLE}: ${error instanceof Error ? error.message : String(error)}`;
  }
  if (error instanceof ObservabilityStoreRefused) return `${error.code}: ${error.detail}`;
  if (error instanceof UnreadableRowError) return `${error.code}: ${error.message}`;
  return `${label}: ${error instanceof Error ? error.message : String(error)}`;
}

/**
 * Run one store method, turning the kinds of outcome into a `Result`.
 *
 * `label` names the method rather than the table, because the driver's own
 * message says which table and never says which port call sent the statement.
 */
export async function refuseObservability<Value>(
  work: () => Promise<Result<Value>>,
  label: string,
): Promise<Result<Value>> {
  try {
    return await work();
  } catch (error) {
    if (
      error instanceof ObservabilityStoreRefused ||
      error instanceof UnreadableRowError ||
      isDriverError(error)
    ) {
      return err(repositoryUnavailable(reasonOf(error, label)));
    }
    throw error;
  }
}
