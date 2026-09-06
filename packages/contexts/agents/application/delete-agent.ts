// Use case: remove an agent from an environment.
//
// THIS IS AN UNBIND, NOT A DELETE, AND THE NAME IN THE RUNNING SYSTEM IS WRONG.
// An `Agent` row belongs to a project and may be bound in several environments.
// Removing it from production must not remove it from staging, so what the
// operation actually deletes is the `AgentBinding`. The `Agent` row survives,
// and is deactivated only when the binding just removed was the last one — a
// tombstone rather than a delete, because its versions, its threads and its
// audit trail all still reference it.
//
// THE COUNT IS READ INSIDE THE TRANSACTION, AFTER THE DELETE. Reading it before
// would count the binding that is about to go and never deactivate; reading it
// outside would let a second environment bind the agent in the gap and
// deactivate an agent that is live somewhere. Both are one-line mistakes with no
// symptom until an operator finds a deactivated agent still serving turns.
//
// REMOVING A BINDING MINTS NO VERSION. The configuration did not change; only
// this environment's use of it did. A version here would put an entry in the
// history of an agent that another environment is still serving, saying nothing
// about what changed for them.

import { err, ok, runResult, type Result } from "@platos/kernel";

import { deactivate, unbind, type AgentId, type UnbindOutcome } from "../domain/index.js";
import { verifyOperator } from "./authorization.js";
import type { AgentsDependencies } from "./dependencies.js";
import { requireBound } from "./read-agents.js";
import { releaseHolds } from "./version-writer.js";

export interface RemoveAgentCommand {
  readonly authorization: unknown;
  readonly agentId: AgentId;
}

export async function removeAgent(
  dependencies: AgentsDependencies,
  command: RemoveAgentCommand,
): Promise<Result<UnbindOutcome>> {
  const granted = verifyOperator(dependencies, command.authorization);
  if (!granted.ok) return err(granted.error);
  const scope = granted.value.scope;

  const bound = await requireBound(dependencies, scope, command.agentId);
  if (!bound.ok) return err(bound.error);

  const now = dependencies.clock.now();
  const removed = await runResult(dependencies.unitOfWork, async (transaction) => {
    const deleted = await dependencies.repository.deleteBinding(scope, bound.value.binding, transaction);
    if (!deleted.ok) return err(deleted.error);
    const remaining = await dependencies.repository.countBindings(command.agentId, transaction);
    if (!remaining.ok) return err(remaining.error);
    const outcome = unbind(bound.value.binding, remaining.value);
    if (outcome.deactivatesAgent) {
      const deactivated = await dependencies.repository.updateAgent(
        deactivate(bound.value.agent, now),
        transaction,
      );
      if (!deactivated.ok) return err(deactivated.error);
    }
    return ok(outcome);
  });

  if (removed.ok) await releaseHolds(dependencies, scope, command.agentId);
  return removed;
}
