// Use cases: working memory, and the two other things this context caches.
//
// Working memory is the second layer above the store — short-term,
// per-conversation, discarded when the conversation ends. Every key it uses is
// minted by `domain/working-set.ts`, so the keyspace is decided in the domain
// and this file only sequences the calls.
//
// EVERY READ HERE TREATS A CACHE FAILURE AS A MISS. That policy lives in this
// one file rather than at each call site, because the alternative — a `Result`
// propagated from every cache read — would make a Redis outage fail a turn that
// could have run perfectly well against the store. The port still REPORTS the
// failure (`Cache` returns `Result` for exactly that reason); this is the one
// place that decides to treat it as absence.
//
// WRITES ARE BEST-EFFORT AND SAY SO IN THEIR RETURN TYPE. `writeWatermark`
// returns a boolean rather than a `Result`, because there is no caller that
// should abandon its work because a watermark did not persist: the store's
// unique index is what makes extraction idempotent, and the watermark only
// decides whether a judge is paid for.
//
// THERE IS NO `clearAll`. The one bulk operation is scoped to a single thread's
// prefix, and `Cache.deleteNamespace` refuses a blank one — a flush of the whole
// keyspace is not an operation this context offers.

import { ok, type Result } from "@platos/kernel";

import {
  addWorkingEntity,
  extractionWatermarkKey,
  isSweepRedundant,
  pendingActionField,
  renderWorkingContext,
  toolResultField,
  workingMemoryKey,
  workingMemoryPrefix,
  WORKING_ENTITIES_FIELD,
  type ThreadId,
  type TurnId,
  type WorkingEntity,
} from "../domain/index.js";
import type { MemoryDependencies } from "./dependencies.js";

/** Read a working-memory field, parsed. Null on a miss, a failure, or garbage. */
export async function readWorkingField<Value>(
  dependencies: MemoryDependencies,
  threadId: ThreadId,
  field: string,
): Promise<Value | null> {
  const raw = await dependencies.cache.get(workingMemoryKey(threadId, field));
  if (!raw.ok || raw.value === null) return null;
  return parse<Value>(raw.value);
}

export async function writeWorkingField(
  dependencies: MemoryDependencies,
  threadId: ThreadId,
  field: string,
  value: unknown,
): Promise<boolean> {
  const written = await dependencies.cache.set({
    key: workingMemoryKey(threadId, field),
    value: JSON.stringify(value),
    ttlSeconds: dependencies.policy.cache.workingMemoryTtlSeconds,
  });
  return written.ok;
}

export async function forgetWorkingField(
  dependencies: MemoryDependencies,
  threadId: ThreadId,
  field: string,
): Promise<boolean> {
  const deleted = await dependencies.cache.delete(workingMemoryKey(threadId, field));
  return deleted.ok && deleted.value;
}

/** Every key one thread holds. Called when the conversation ends. */
export async function clearWorkingMemory(
  dependencies: MemoryDependencies,
  threadId: ThreadId,
): Promise<Result<number>> {
  const cleared = await dependencies.cache.deleteNamespace(workingMemoryPrefix(threadId));
  return cleared.ok ? cleared : ok(0);
}

export async function readWorkingEntities(
  dependencies: MemoryDependencies,
  threadId: ThreadId,
): Promise<readonly WorkingEntity[]> {
  const stored = await readWorkingField<WorkingEntity[]>(dependencies, threadId, WORKING_ENTITIES_FIELD);
  return Array.isArray(stored) ? stored : [];
}

/**
 * Record a mention.
 *
 * READ, DECIDE, WRITE — and the decision is `addWorkingEntity`, which is pure
 * and de-duplicates on `(type, name)`. A cache with no compare-and-set can lose
 * a concurrent mention here, which is acceptable for a layer whose whole
 * lifetime is one conversation and whose contents are re-derivable from the
 * transcript. Anything that must not be lost is written as a `Memory`.
 */
export async function noteWorkingEntity(
  dependencies: MemoryDependencies,
  threadId: ThreadId,
  entity: WorkingEntity,
): Promise<readonly WorkingEntity[]> {
  const existing = await readWorkingEntities(dependencies, threadId);
  const next = addWorkingEntity(existing, entity);
  if (next !== existing) await writeWorkingField(dependencies, threadId, WORKING_ENTITIES_FIELD, next);
  return next;
}

/** The one-line block a turn is given, or the empty string when nothing is known. */
export async function renderWorkingMemory(
  dependencies: MemoryDependencies,
  threadId: ThreadId,
): Promise<string> {
  return renderWorkingContext(await readWorkingEntities(dependencies, threadId));
}

export async function cacheToolResult(
  dependencies: MemoryDependencies,
  threadId: ThreadId,
  toolName: string,
  parameters: Readonly<Record<string, unknown>>,
  result: unknown,
): Promise<boolean> {
  return writeWorkingField(dependencies, threadId, toolResultField(toolName, parameters), result);
}

export async function readCachedToolResult<Value>(
  dependencies: MemoryDependencies,
  threadId: ThreadId,
  toolName: string,
  parameters: Readonly<Record<string, unknown>>,
): Promise<Value | null> {
  return readWorkingField<Value>(dependencies, threadId, toolResultField(toolName, parameters));
}

export async function holdPendingAction(
  dependencies: MemoryDependencies,
  threadId: ThreadId,
  actionId: string,
  action: Readonly<Record<string, unknown>>,
): Promise<boolean> {
  return writeWorkingField(dependencies, threadId, pendingActionField(actionId), action);
}

export async function readPendingAction(
  dependencies: MemoryDependencies,
  threadId: ThreadId,
  actionId: string,
): Promise<Readonly<Record<string, unknown>> | null> {
  return readWorkingField<Record<string, unknown>>(
    dependencies,
    threadId,
    pendingActionField(actionId),
  );
}

/** The newest turn a sweep has already read, or null. */
export async function readWatermark(
  dependencies: MemoryDependencies,
  threadId: ThreadId,
): Promise<string | null> {
  const stored = await dependencies.cache.get(extractionWatermarkKey(threadId));
  return stored.ok ? stored.value : null;
}

export async function writeWatermark(
  dependencies: MemoryDependencies,
  threadId: ThreadId,
  latestTurnId: TurnId,
): Promise<boolean> {
  const written = await dependencies.cache.set({
    key: extractionWatermarkKey(threadId),
    value: latestTurnId,
    ttlSeconds: dependencies.policy.cache.extractionWatermarkTtlSeconds,
  });
  return written.ok;
}

/** Has this thread already been swept at its current head? */
export async function sweepIsRedundant(
  dependencies: MemoryDependencies,
  threadId: ThreadId,
  latestTurnId: TurnId | null,
): Promise<boolean> {
  return isSweepRedundant(await readWatermark(dependencies, threadId), latestTurnId);
}

/** Malformed JSON is a MISS, not a failure: a cache holds no truth to lose. */
function parse<Value>(raw: string): Value | null {
  try {
    return JSON.parse(raw) as Value;
  } catch {
    return null;
  }
}
