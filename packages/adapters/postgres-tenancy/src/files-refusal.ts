// The one place a thrown thing becomes a `Result` for `files`' canonical store.
//
// THE PORT SAYS "Like `ObjectStore`, every method returns `Result`. A rejected
// promise is a defect, not an outcome." Three kinds of throw reach these stores
// and only two of them are outcomes:
//
//   `FilesWriteRefused` — a value the canonical schema will not hold, or a scope
//   whose ancestry the tenant tree does not agree with, caught before any row
//   was written. An outcome.
//
//   A DRIVER ERROR — a constraint this store did not pre-empt. The append-only
//   unique is the one that matters and it has its OWN answer, minted in
//   `files-artifacts.ts` before this function ever sees it, because
//   `insertArtifactRevision`'s port comment REQUIRES it:
//   `FILES_ARTIFACT_REVISION_CONFLICT`, never an update and never a retry at the
//   next free revision. Everything else the driver refuses is an outcome the
//   caller can only report.
//
//   `TransactionScopeError` — a write issued outside any transaction, with a
//   finished token, or with another live transaction's token. NOT an outcome,
//   and deliberately RETHROWN: those three refusals carry three distinct codes
//   so the three mistakes stay distinguishable, and converting them to a
//   `Result` here would let a use case that lost its transaction carry on as
//   though a row had merely failed to write.
//
// EVERYTHING ELSE IS ALSO RETHROWN. A `TypeError` in this package is a bug in
// this package, and a store that folded it into `FILES_REPOSITORY_UNAVAILABLE`
// would report a defect as an outage.
//
// ONE CALLER-FACING CODE, MANY OPERATOR-FACING ONES.
// `files/domain/errors.ts` publishes exactly one code a store may answer with,
// `FILES_REPOSITORY_UNAVAILABLE`. That collapse is right for a caller and
// useless for an operator, so the distinct code leads `details.reason` and the
// human detail follows it: a caller matches on the code it was given, an
// operator greps for the one that actually happened.

import type { Result } from "@platos/context-files/application/ports/index.js";
import { err, repositoryUnavailable } from "@platos/context-files/application/ports/index.js";

import { FilesWriteRefused } from "./files-guards.js";

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
  if (error instanceof FilesWriteRefused) return `${error.code}: ${error.detail}`;
  return `${label}: ${error instanceof Error ? error.message : String(error)}`;
}

/**
 * Run one store method, turning the two kinds of outcome into a `Result`.
 *
 * `label` names the METHOD rather than the table, because the driver's own
 * message says which table and never says which port call sent the statement.
 */
export async function refuseFiles<Value>(
  work: () => Promise<Result<Value>>,
  label: string,
): Promise<Result<Value>> {
  try {
    return await work();
  } catch (error) {
    if (error instanceof FilesWriteRefused || isDriverError(error)) {
      return err(repositoryUnavailable(reasonOf(error, label)));
    }
    throw error;
  }
}
