// Working memory and the two other things this context keeps in a cache.
//
// Durable memory is the store; working memory is the second layer above it —
// short-term, per-conversation, and thrown away when the conversation ends. It
// holds what the current exchange has established (entities mentioned, an action
// awaiting approval) so a turn does not re-derive it, and it is explicitly NOT a
// place a fact goes to live. Anything worth keeping is written as a `Memory`.
//
// THREE KEYSPACES, ONE PORT, AND THE NAMESPACES ARE HERE RATHER THAN IN THE
// ADAPTER. `Cache` is owned by this context (ADR M0.3 §13, which assigns it to
// `memory` and notes that "Redis is an implementation detail and does not define
// architectural ownership"). Every key it will ever hold is minted below, so the
// keyspace is readable in one file rather than reconstructed from five string
// templates spread across three services:
//
//   wm:<thread>:<field>     working memory. Short TTL — one idle hour.
//   profile:<scope>:...     the assembled profile projection. Ten minutes, so a
//                           missed invalidation self-heals inside one session.
//   memx:<thread>           the extraction watermark. Fourteen days.
//
// THE WATERMARK IS AN OPTIMISATION AND NOTHING RESTS ON IT. Correctness of
// extraction dedupe is the store's unique index over `(environment, subject,
// source thread, content hash)`; the watermark only lets an unchanged thread be
// skipped before a judge is paid for. A cache that lost every key would cost
// money and change no outcome, which is exactly the property that lets the cache
// be best-effort at every call site.
//
// KEYS ARE BUILT FROM THE KERNEL'S `resolvePath()`. An adapter is free to digest
// the namespace before it reaches its keyspace — the source does, to keep raw
// scope ids out of Redis — because a digest of a canonical string is still a
// function of that string. What an adapter may NOT do is invent its own
// composition, which is what these functions exist to prevent.

import { resolvePath, type EnvironmentScope } from "@platos/kernel";

import type { AgentId, EndUserId, ThreadId, TurnId } from "./identifiers.js";
import { subjectPath, type MemorySubject } from "./scope.js";

/** One idle hour, matching the source's configurable default. */
export const WORKING_MEMORY_TTL_SECONDS = 3600;

/** Ten minutes. Short enough that a missed invalidation self-heals. */
export const PROFILE_CACHE_TTL_SECONDS = 10 * 60;

/** Fourteen days. Long enough that a dormant thread stays skipped. */
export const EXTRACTION_WATERMARK_TTL_SECONDS = 14 * 24 * 60 * 60;

/** The reserved working-memory field the detected-entity list lives under. */
export const WORKING_ENTITIES_FIELD = "entities";

export function workingMemoryKey(threadId: ThreadId, field: string): string {
  return `wm:${threadId}:${field}`;
}

/** Every key one thread's working memory can occupy, as a prefix. */
export function workingMemoryPrefix(threadId: ThreadId): string {
  return `wm:${threadId}:`;
}

/**
 * A cached tool result, keyed by the tool and its arguments.
 *
 * The arguments are serialised with their keys SORTED. `JSON.stringify` of an
 * object follows insertion order, so two callers passing the same arguments in a
 * different order would otherwise miss each other's cache entry — which is the
 * one thing a result cache exists to prevent.
 */
export function toolResultField(toolName: string, parameters: Readonly<Record<string, unknown>>): string {
  return `tool:${toolName}:${stableStringify(parameters)}`;
}

export function pendingActionField(actionId: string): string {
  return `action:${actionId}`;
}

export function profileCacheKey(
  environment: EnvironmentScope,
  agentId: AgentId,
  endUserId: EndUserId,
): string {
  return `profile:${resolvePath(environment)}:${agentId}:${endUserId}`;
}

export function extractionWatermarkKey(threadId: ThreadId): string {
  return `memx:${threadId}`;
}

/** The namespace a subject's cached values share, for a subject-wide purge. */
export function subjectCachePrefix(subject: MemorySubject): string {
  return `profile:${subjectPath(subject)}`;
}

/** One entity the current conversation has mentioned. Not a graph node. */
export interface WorkingEntity {
  readonly type: string;
  readonly name: string;
  readonly id: string | null;
}

/**
 * Add a mention, de-duplicated on `(type, name)`.
 *
 * The pair, not the name alone: a person and a project can share a name, and
 * conflating them would put one of them out of the turn's reach. Never mutates
 * the input, so a caller that failed to write the result back has not silently
 * half-applied the change.
 */
export function addWorkingEntity(
  entities: readonly WorkingEntity[],
  entity: WorkingEntity,
): readonly WorkingEntity[] {
  const present = entities.some(
    (existing) => existing.name === entity.name && existing.type === entity.type,
  );
  return present ? entities : Object.freeze([...entities, entity]);
}

/**
 * The one-line context block a turn is given.
 *
 * An empty set renders as the EMPTY STRING, not as a header with nothing under
 * it: an injected block that says only "entities mentioned:" spends tokens
 * telling a model that nothing was mentioned.
 */
export function renderWorkingContext(entities: readonly WorkingEntity[]): string {
  if (entities.length === 0) return "";
  const rendered = entities.map((entity) => `${entity.type}: ${entity.name}`).join(", ");
  return `[Working Memory] Entities mentioned in this conversation: ${rendered}`;
}

/** The watermark value: the newest turn a sweep has already read. */
export interface ExtractionWatermark {
  readonly threadId: ThreadId;
  readonly latestTurnId: TurnId;
}

/**
 * Has this thread already been swept at its current head?
 *
 * A missing watermark means "sweep it", which is the safe direction: the store's
 * unique index absorbs the repeat, and the alternative — treating a missing
 * watermark as up-to-date — would silently stop extracting after a cache flush.
 */
export function isSweepRedundant(stored: string | null, latestTurnId: TurnId | null): boolean {
  return stored !== null && latestTurnId !== null && stored === latestTurnId;
}

/** Deterministic JSON: object keys sorted at every depth, arrays left in order. */
function stableStringify(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value) ?? "null";
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`;
  const entries = Object.entries(value as Record<string, unknown>).sort(([left], [right]) =>
    left < right ? -1 : left > right ? 1 : 0,
  );
  return `{${entries.map(([key, entry]) => `${JSON.stringify(key)}:${stableStringify(entry)}`).join(",")}}`;
}
