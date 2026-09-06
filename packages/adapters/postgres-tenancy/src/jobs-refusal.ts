// The one place a thrown thing becomes a `Result` for `jobs`' two stores.
//
// BOTH PORTS SAY IT IN THE SAME WORDS. `jobs-repository.ts` in the context:
// "Every method returns `Result`. A rejected promise is a defect, not an
// outcome." Three kinds of throw reach these stores and only two of them are
// outcomes:
//
//   `JobsWriteRefused` — a value the canonical schema will not hold, caught
//   before any statement was sent. An outcome.
//
//   `UnreadableRowError` — a stored column this binary cannot read, which is a
//   real operational event during an expand/contract window and the reason
//   `jobs-rows.ts` validates rather than casts. An outcome.
//
//   `TransactionScopeError` — a write issued outside any transaction, with a
//   finished token, or with another transaction's token. NOT an outcome, and
//   deliberately RETHROWN: those three refusals are the property WIN-258 T1
//   built and every tranche since has relied on, they carry three distinct codes
//   so the three mistakes stay distinguishable, and converting them to a
//   `Result` here would let a use case that lost its transaction carry on as
//   though a row had merely failed to write.
//
// EVERYTHING ELSE IS ALSO RETHROWN. A `TypeError` in this package is a bug in
// this package, and a store that folded it into `JOBS_REPOSITORY_UNAVAILABLE`
// would report a defect as an outage — the shape of mistake that makes an
// incident take a day instead of a minute.
//
// ONE CODE LEAVES THIS FILE, AND THAT IS THE CONTEXT'S DECISION RATHER THAN
// THIS PACKAGE'S. `domain/errors.ts` publishes exactly one code a store may
// answer with — `JOBS_REPOSITORY_UNAVAILABLE` — so a caller cannot tell a
// payload schema the column refuses from a row an older binary wrote from a
// database that is down. That collapse is right for a caller, which has one
// thing to do in all three cases, and useless for an operator; the distinct
// codes are carried in `details.reason`, which is why the code LEADS the string
// below.

import type { Result } from "@platos/context-jobs/application/ports/index.js";
import { err, repositoryUnavailable } from "@platos/context-jobs/application/ports/index.js";

import { JobsWriteRefused } from "./jobs-guards.js";
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
  if (error instanceof JobsWriteRefused) return `${error.code}: ${error.detail}`;
  if (error instanceof UnreadableRowError) return `${error.code}: ${error.message}`;
  return `${label}: ${error instanceof Error ? error.message : String(error)}`;
}

/**
 * Run one store method, turning the two kinds of outcome into a `Result`.
 *
 * `label` names the METHOD rather than the table, because the driver's own
 * message says which table and never says which port call sent the statement.
 */
export async function refuseJobs<Value>(
  work: () => Promise<Result<Value>>,
  label: string,
): Promise<Result<Value>> {
  try {
    return await work();
  } catch (error) {
    if (
      error instanceof JobsWriteRefused ||
      error instanceof UnreadableRowError ||
      isDriverError(error)
    ) {
      return err(repositoryUnavailable(reasonOf(error, label)));
    }
    throw error;
  }
}
