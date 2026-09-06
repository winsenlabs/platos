// The one place a thrown thing becomes a `Result` for `governance`'s stores.
//
// THE PORTS SAY "EVERY METHOD RETURNS `Result`. A rejected promise is a defect,
// not an outcome." Three kinds of throw reach these stores and only two of them
// are outcomes:
//
//   `GovernanceWriteRefused` — a value the canonical schema will not hold,
//   caught before any statement was sent. An outcome.
//
//   `UnreadableRowError` — a stored column this binary cannot read, which is a
//   real operational event during an expand/contract window and the reason
//   `governance-rows.ts` validates rather than casts. An outcome.
//
//   `TransactionScopeError` — a write issued outside any transaction, with a
//   finished token, or with another transaction's token. NOT an outcome, and
//   deliberately RETHROWN: those three refusals are the property WIN-258 T1
//   built and T2 and T3 relied on, they carry three distinct codes so the three
//   mistakes stay distinguishable, and converting them to a `Result` here would
//   let a use case that lost its transaction carry on as though a row had merely
//   failed to write.
//
// EVERYTHING ELSE IS ALSO RETHROWN. A `TypeError` in this package is a bug in
// this package, and a store that folded it into `GOVERNANCE_LEDGER_UNAVAILABLE`
// would report a defect as an outage — the shape of mistake that makes an
// incident take a day instead of a minute.

import type { Result } from "@platos/context-governance/application/ports/index.js";
import { err, ledgerUnavailable } from "@platos/context-governance/application/ports/index.js";

import { GovernanceWriteRefused } from "./governance-guards.js";
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
  if (error instanceof GovernanceWriteRefused) return `${error.code}: ${error.detail}`;
  if (error instanceof UnreadableRowError) return `${error.code}: ${error.message}`;
  return `${label}: ${error instanceof Error ? error.message : String(error)}`;
}

/**
 * Run one store method, turning the two kinds of outcome into a `Result`.
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
      error instanceof GovernanceWriteRefused ||
      error instanceof UnreadableRowError ||
      isDriverError(error)
    ) {
      return err(ledgerUnavailable(reasonOf(error, label)));
    }
    throw error;
  }
}
