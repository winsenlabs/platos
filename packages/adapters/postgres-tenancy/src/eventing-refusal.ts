// The one place a thrown thing becomes a `Result` for `eventing`'s store.
//
// THE PORT SAYS SO IN AS MANY WORDS: "Every method returns `Result`. A rejected
// promise is a defect, not an outcome." Four kinds of throw reach this store and
// only three of them are outcomes:
//
//   `EventingWriteRefused` — a value the canonical schema will not hold, caught
//   before any statement was sent. An outcome.
//
//   `UnreadableRowError` — a stored column this binary cannot read, which is a
//   real operational event during an expand/contract window and the reason
//   `eventing-rows.ts` parses rather than casts. An outcome.
//
//   A DRIVER ERROR — the unique index, the foreign key, or an outage. An
//   outcome, and the first two are given their own reason codes below so an
//   operator can tell "that name is taken" from "that environment does not
//   exist" without reading a vendor message.
//
//   `TransactionScopeError` — a write issued outside any transaction, with a
//   finished token, or with another transaction's token. NOT an outcome, and
//   deliberately RETHROWN: those three refusals are the property WIN-258 T1
//   built and every tranche since has relied on, they carry three distinct
//   codes so the three mistakes stay distinguishable, and converting them to a
//   `Result` here would let a use case that lost its transaction carry on as
//   though a row had merely failed to write.
//
// EVERYTHING ELSE IS ALSO RETHROWN. A `TypeError` in this package is a bug in
// this package, and a store that folded it into EVENTING_REPOSITORY_UNAVAILABLE
// would report a defect as an outage.
//
// ONE PUBLISHED CODE, MANY REASONS, AND THE REASON LEADS WITH ITS OWN CODE.
// `domain/errors.ts` mints exactly one code for a store failure —
// `EVENTING_REPOSITORY_UNAVAILABLE` — and its constructor takes a `reason` that
// lands on `details.reason`. Two guards sharing one string cannot be told apart
// in a log, so every refusal's own code is the FIRST thing in that string.

import type { Result } from "@platos/context-eventing/application/ports/index.js";
import { err, repositoryUnavailable } from "@platos/context-eventing/application/ports/index.js";

import { isForeignKeyViolation, isUniqueViolation } from "./client.js";
import { EventingWriteRefused } from "./eventing-guards.js";
import { UnreadableRowError } from "./mapping.js";

/**
 * The `NotificationRule_environmentId_fkey` refusal.
 *
 * It is NOT pre-checked and could not honestly be. Reading `Environment` first
 * would be a second statement whose answer is stale the instant it returns — the
 * environment can be dropped between the read and the insert, and `ON DELETE
 * CASCADE` means the row would then be taken anyway — so the constraint is the
 * authority and this is its name.
 */
export const EVENTING_ENVIRONMENT_UNKNOWN = "eventing.write.environment_unknown";

/** A driver failure that is neither of the two constraints named by hand. */
export const EVENTING_STORE_FAILED = "eventing.store.failed";

/** True for the driver's own errors, whatever SQLSTATE they carry. */
function isDriverError(error: unknown): boolean {
  return error instanceof Error && error.name.startsWith("PrismaClient");
}

/**
 * The reason string a refusal carries.
 *
 * The distinct CODE leads, so `details.reason` on the returned `DomainError`
 * begins with the code a caller matches on and the human detail follows it.
 */
function reasonOf(error: unknown, label: string): string {
  if (error instanceof EventingWriteRefused) return `${error.code}: ${error.detail}`;
  if (error instanceof UnreadableRowError) return `${error.code}: ${error.message}`;
  if (isForeignKeyViolation(error)) {
    return `${EVENTING_ENVIRONMENT_UNKNOWN}: ${label} names an environment that does not exist`;
  }
  return `${EVENTING_STORE_FAILED}: ${label}: ${error instanceof Error ? error.message : String(error)}`;
}

/**
 * Run one store method, turning the three kinds of outcome into a `Result`.
 *
 * `label` names the method rather than the table, because the driver's own
 * message says which table and never says which port call sent the statement.
 */
export async function refuse<Value>(
  work: () => Promise<Result<Value>>,
  label: string,
): Promise<Result<Value>> {
  try {
    return await work();
  } catch (error) {
    if (
      error instanceof EventingWriteRefused ||
      error instanceof UnreadableRowError ||
      isDriverError(error)
    ) {
      return err(repositoryUnavailable(reasonOf(error, label)));
    }
    throw error;
  }
}

/**
 * True when this error is the `@@unique([environmentId, name])` index refusing a
 * duplicate.
 *
 * Separate from `refuse` because a name clash is NOT an outage: the port's
 * caller gets `EVENTING_RULE_NAME_TAKEN`, a `conflict`, which
 * `register-notification-rule.ts` says in its own header is the code a racing
 * insert must land on.
 */
export function isNameClash(error: unknown): boolean {
  return isUniqueViolation(error);
}
