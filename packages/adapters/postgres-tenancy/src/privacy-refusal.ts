// The one place a thrown thing becomes a `Result` for `privacy`'s canonical
// store, and the one place the OPERATION half and the REGISTER half are told
// apart.
//
// The port says "Every method returns `Result`. A rejected promise is a defect,
// not an outcome — with one consequence worth stating:
// `PRIVACY_ERASURE_REGISTER_UNAVAILABLE` is a VALUE the barrier turns into a
// refusal, so an implementation that threw instead would bypass the fail-closed
// rule rather than fire it." That sentence is why this file exists and why it
// has TWO wrappers rather than one.
//
//   `refusePrivacy` answers with `PRIVACY_OPERATION_STORE_UNAVAILABLE`. It wraps
//   the six `OperationRepository` methods, whose caller is a use case that can
//   stop and report.
//
//   `refuseRegister` answers with `PRIVACY_ERASURE_REGISTER_UNAVAILABLE`. It
//   wraps the three `TombstoneRepository` methods, and the difference is not
//   cosmetic: `guard-subject-write.ts` REFUSES THE WRITE on that error, and an
//   operator reading a log has to be able to tell "we blocked a resurrection"
//   from "we lost the ability to tell". Folding the register's outages into the
//   operation store's code would put both facts under one name on the hot path
//   of every identity chokepoint in the system.
//
// THREE KINDS OF THROW REACH THESE STORES AND ONLY TWO OF THEM ARE OUTCOMES:
//
//   `PrivacyWriteRefused` — a value the canonical schema will not hold, caught
//   before any statement was sent. An outcome.
//
//   `UnreadablePrivacyRow` — a stored column this binary cannot read, which is a
//   real operational event during an expand/contract window and the reason
//   `privacy-rows.ts` validates rather than casts. An outcome.
//
//   `TransactionScopeError` — a write issued outside any transaction, with a
//   finished token, or with another transaction's token. NOT an outcome, and
//   deliberately RETHROWN: those three refusals carry three distinct codes so
//   the three mistakes stay distinguishable, and converting them to a `Result`
//   here would let a use case that lost its transaction carry on as though a row
//   had merely failed to write — which in this context means carrying on with a
//   destruction whose barrier is not committed.
//
// EVERYTHING ELSE IS ALSO RETHROWN. A `TypeError` in this package is a bug in
// this package, and a store that folded it into an `unavailable` would report a
// defect as an outage.

import type { Result } from "@platos/context-privacy/application/ports/index.js";
import {
  erasureRegisterUnavailable,
  err,
  operationStoreUnavailable,
} from "@platos/context-privacy/application/ports/index.js";

import { PrivacyWriteRefused } from "./privacy-guards.js";
import { UnreadablePrivacyRow } from "./privacy-rows.js";

/** True for the driver's own errors, whatever SQLSTATE they carry. */
function isDriverError(error: unknown): boolean {
  return error instanceof Error && error.name.startsWith("PrismaClient");
}

function isOutcome(error: unknown): boolean {
  return (
    error instanceof PrivacyWriteRefused ||
    error instanceof UnreadablePrivacyRow ||
    isDriverError(error)
  );
}

/**
 * The reason string a refusal carries.
 *
 * The distinct CODE leads, so `details.reason` begins with the code an operator
 * greps for and the human detail follows it. Two guards with one code cannot be
 * told apart; two guards whose codes lead the same string can.
 */
function reasonOf(error: unknown, label: string): string {
  if (error instanceof PrivacyWriteRefused) return `${error.code}: ${error.detail}`;
  if (error instanceof UnreadablePrivacyRow) return `${error.code}: ${error.message}`;
  return `${label}: ${error instanceof Error ? error.message : String(error)}`;
}

/**
 * Run one `OperationRepository` method, turning the two kinds of outcome into a
 * `Result`.
 *
 * `label` names the METHOD rather than the table, because the driver's own
 * message says which table and never says which port call sent the statement.
 */
export async function refusePrivacy<Value>(
  work: () => Promise<Result<Value>>,
  label: string,
): Promise<Result<Value>> {
  try {
    return await work();
  } catch (error) {
    if (isOutcome(error)) return err(operationStoreUnavailable(reasonOf(error, label)));
    throw error;
  }
}

/** Run one `TombstoneRepository` method. See the header for why it is separate. */
export async function refuseRegister<Value>(
  work: () => Promise<Result<Value>>,
  label: string,
): Promise<Result<Value>> {
  try {
    return await work();
  } catch (error) {
    if (isOutcome(error)) return err(erasureRegisterUnavailable(reasonOf(error, label)));
    throw error;
  }
}
