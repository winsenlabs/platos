// Use case: append one row to the safety ledger.
//
// The FALLIBLE half of the two ways an event reaches this ledger. This one
// returns a `Result` and a caller must handle it; `safety-event-sink.ts` wraps
// it for the kernel port, which may not fail its caller and therefore swallows
// what this returns. Having one admission path and two façades is what stops the
// two producers disagreeing about what a valid event is.
//
// THE SCOPE COMES FROM THE GRANT. A safety event is stamped with the environment
// the operator's grant re-derived, never with an id on the command, so a
// producer cannot file an event against somebody else's environment even if it
// wants to.
//
// THE WRITE IS BEST-EFFORT AT THE STORE AND STRICT AT THE VOCABULARY. A store
// that is down answers `GOVERNANCE_LEDGER_UNAVAILABLE` and the caller decides;
// a detector nobody registered is refused before the store is touched, because
// an unknown bucket corrupts every rollup taken afterwards and no retry fixes
// it.

import { err, ok, type EnvironmentScope, type Result, type TransactionScope } from "@platos/kernel";

import { admitSafetyEvent, type SafetyEvent, type SafetyEventDraft } from "../domain/index.js";
import { verifyOperator } from "./authorization.js";
import type { GovernanceDependencies } from "./dependencies.js";

export interface RecordSafetyEventCommand {
  readonly authorization: unknown;
  readonly event: SafetyEventDraft;
}

/** Append through an operator grant. The transport-facing entry point. */
export async function recordSafetyEvent(
  dependencies: GovernanceDependencies,
  command: RecordSafetyEventCommand,
): Promise<Result<SafetyEvent>> {
  const grant = verifyOperator(dependencies, command.authorization);
  if (!grant.ok) return err(grant.error);
  return appendSafetyEvent(dependencies, grant.value.scope, command.event, null);
}

/**
 * Append into an already-resolved scope.
 *
 * The sink reaches this directly: it holds no grant, because the enforcement
 * layer that publishes through it is not acting for an operator. The scope it
 * passes is the one the kernel observation carried, which the sink narrows to an
 * environment before calling.
 */
export async function appendSafetyEvent(
  dependencies: GovernanceDependencies,
  scope: EnvironmentScope,
  draft: SafetyEventDraft,
  transaction: TransactionScope | null,
): Promise<Result<SafetyEvent>> {
  const admitted = admitSafetyEvent(draft, dependencies.policy.safety);
  if (!admitted.ok) return err(admitted.error);
  const appended = await dependencies.safety.append(scope, admitted.value, transaction);
  if (!appended.ok) return err(appended.error);
  return ok(appended.value);
}
