// Use cases: archive, restore, delete.
//
// THREE OPERATIONS, TWO OF WHICH ARE REVERSIBLE AND ONE OF WHICH IS NOT, and the
// difference is deliberately visible in their names. `archive` puts a memory out
// of every default read and leaves it recoverable; `restore` undoes it; `forget`
// destroys the row. A single `delete(soft: boolean)` would have made the
// destructive case reachable from a caller that only meant to hide something.
//
// ARCHIVING IS IDEMPOTENT AND REPORTS WHETHER IT DID ANYTHING. The source uses
// `updateMany ... where archivedAt: null` and returns the affected count, so
// archiving an already-archived memory is not an error and is also not silently
// reported as a change. That distinction is preserved: the result carries
// `changed`, and the instant that is now on the row.
//
// BULK DELETE IS CAPPED AT A HUNDRED IDS, and the cap is refused rather than
// truncated. Truncating would delete ninety-nine of a caller's hundred and one
// and report success, which is the worst available answer for a destructive
// operation.
//
// EVERY ONE OF THESE IS SCOPED BY SUBJECT AND BY AGENT. There is no path here
// that takes an id alone: a memory outside the caller's agent scope is NOT FOUND
// rather than forbidden, which is the same conflation the read path makes and
// for the same reason — telling a caller that a memory exists but is not theirs
// discloses the memory.

import { err, ok, runResult, type Result } from "@platos/kernel";

import {
  archive as archiveMemory,
  bulkLimitExceeded,
  memoryNotFound,
  restore as restoreMemory,
  type AgentId,
  type EndUserId,
  type Memory,
  type MemoryId,
} from "../domain/index.js";
import { authorizeMutation } from "./authorization.js";
import type { MemoryDependencies } from "./dependencies.js";
import { KEEP_EMBEDDING } from "./ports/index.js";

export interface ForgetCommand {
  readonly authorization: unknown;
  /** Required under an operator grant; a runtime grant names its own subject. */
  readonly endUserId: EndUserId | null;
  readonly actingAgentId: AgentId | null;
  readonly memoryId: MemoryId;
}

export interface BulkForgetCommand {
  readonly authorization: unknown;
  readonly endUserId: EndUserId | null;
  readonly actingAgentId: AgentId | null;
  readonly memoryIds: readonly MemoryId[];
}

/** Whether the operation changed anything, and the row as it now stands. */
export interface LifecycleChange {
  readonly changed: boolean;
  readonly memory: Memory;
}

export async function archive(
  dependencies: MemoryDependencies,
  command: ForgetCommand,
): Promise<Result<LifecycleChange>> {
  return transition(dependencies, command, archiveMemory);
}

export async function restore(
  dependencies: MemoryDependencies,
  command: ForgetCommand,
): Promise<Result<LifecycleChange>> {
  return transition(dependencies, command, restoreMemory);
}

export async function forget(
  dependencies: MemoryDependencies,
  command: ForgetCommand,
): Promise<Result<boolean>> {
  const scope = await authorizeMutation(dependencies, { ...command, requestedAgentIds: [] });
  if (!scope.ok) return err(scope.error);
  return runResult(dependencies.unitOfWork, async (transaction) => {
    const deleted = await dependencies.repository.deleteMemories(
      scope.value.subject,
      scope.value.agentIds,
      [command.memoryId],
      transaction,
    );
    if (!deleted.ok) return err(deleted.error);
    return ok(deleted.value > 0);
  });
}

export async function forgetMany(
  dependencies: MemoryDependencies,
  command: BulkForgetCommand,
): Promise<Result<number>> {
  const ids = [...new Set(command.memoryIds)];
  if (ids.length === 0) return ok(0);
  const maximum = dependencies.policy.page.bulkDeleteMax;
  if (ids.length > maximum) return err(bulkLimitExceeded(ids.length, maximum));

  const scope = await authorizeMutation(dependencies, { ...command, requestedAgentIds: [] });
  if (!scope.ok) return err(scope.error);
  return runResult(dependencies.unitOfWork, async (transaction) =>
    dependencies.repository.deleteMemories(scope.value.subject, scope.value.agentIds, ids, transaction),
  );
}

async function transition(
  dependencies: MemoryDependencies,
  command: ForgetCommand,
  apply: (memory: Memory, now: Date) => Result<Memory>,
): Promise<Result<LifecycleChange>> {
  const scope = await authorizeMutation(dependencies, { ...command, requestedAgentIds: [] });
  if (!scope.ok) return err(scope.error);

  const found = await dependencies.repository.findMemory(
    scope.value.subject,
    scope.value.agentIds,
    command.memoryId,
  );
  if (!found.ok) return err(found.error);
  if (found.value === null) return err(memoryNotFound(command.memoryId));

  const now = dependencies.clock.now();
  const next = apply(found.value, now);
  if (!next.ok) return err(next.error);
  if (next.value === found.value) return ok({ changed: false, memory: found.value });

  return runResult(dependencies.unitOfWork, async (transaction) => {
    // The vector is untouched: archiving hides a row from the default read, it
    // does not un-embed it, and restoring must not have to pay a model call.
    const written = await dependencies.repository.updateMemory(
      { memory: next.value, embedding: KEEP_EMBEDDING },
      transaction,
    );
    if (!written.ok) return err(written.error);
    return ok({ changed: true, memory: written.value });
  });
}
