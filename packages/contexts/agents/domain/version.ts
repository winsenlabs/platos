// `AgentVersion` — an immutable configuration, numbered per agent.
//
// Nothing edits a version. A save that changes anything writes a NEW version and
// moves the binding; a rollback writes the OLD snapshot forward as a new version
// rather than moving the binding backwards. That is what makes version history
// an audit trail instead of a cache: every configuration an agent has ever
// served is still there, in the order it served them.
//
// NUMBERING IS `last + 1` PER AGENT, READ INSIDE THE WRITE. `@@unique([agentId,
// versionNumber])` is the constraint; two concurrent saves that both read the
// same `last` both compute the same number, and the second insert is refused by
// the store. `nextVersionNumber` is therefore a function of the numbers a caller
// actually observed — never of a counter this package holds — so the refusal
// stays where it can be seen.
//
// PRUNING IS A DRY RUN AND STAYS A DRY RUN. The running system computes the
// eligible set, logs it, and deletes nothing. Reporting the count without doing
// the deletion is the deliberate half-step: the numbers are what an operator
// needs to decide a retention policy, and a version that is still referenced by
// a completed turn's audit row is not safely deletable yet. Making this return a
// PLAN, with the deletion left to a caller that does not exist, keeps that
// honest rather than hiding it behind a method named `prune`.

import { err, ok, type Result } from "@platos/kernel";

import { versionInvalid } from "./errors.js";
import type { ActorId, AgentId, AgentVersionId } from "./identifiers.js";
import type { AgentVersionPolicy } from "./policy.js";
import type { AgentVersionSnapshot, ToolDefaultPolicy } from "./snapshot.js";

export interface AgentVersion {
  readonly agentVersionId: AgentVersionId;
  readonly agentId: AgentId;
  readonly versionNumber: number;
  readonly toolDefaultPolicy: ToolDefaultPolicy;
  readonly note: string | null;
  readonly createdBy: ActorId;
  readonly createdAt: Date;
  readonly snapshot: AgentVersionSnapshot;
}

/** Ceiling on the note an operator attaches to a save. */
export const MAX_VERSION_NOTE_LENGTH = 2_000;

/** The note the very first version of an agent carries. */
export const INITIAL_VERSION_NOTE = "Initial version";

/** The note a rollback writes. `v` then the number it restored. */
export function rollbackNote(versionNumber: number): string {
  return `Rollback to v${versionNumber}`;
}

/** The note a single tool flip writes, in the source's exact wording. */
export function toolPolicyNote(toolId: string, enabled: boolean): string {
  return `${enabled ? "Enable" : "Disable"} Agent Tool ${toolId}`;
}

/** The note a feature-flag save writes, including its singular/plural. */
export function featureFlagNote(keyCount: number): string {
  return `Feature flags updated (${keyCount} key${keyCount === 1 ? "" : "s"})`;
}

export function admitNote(note: string | null | undefined): Result<string | null> {
  if (note === undefined || note === null) return ok(null);
  const trimmed = note.trim();
  if (trimmed === "") return ok(null);
  if (trimmed.length > MAX_VERSION_NOTE_LENGTH) {
    return err(
      versionInvalid(`note must be at most ${MAX_VERSION_NOTE_LENGTH} characters`, {
        length: String(trimmed.length),
      }),
    );
  }
  return ok(trimmed);
}

/**
 * The number the next version of this agent takes.
 *
 * Takes the highest number OBSERVED, not a count: a pruned history has gaps, and
 * counting rows would re-issue a number an old version already used.
 */
export function nextVersionNumber(observedNumbers: readonly number[]): number {
  let highest = 0;
  for (const number of observedNumbers) {
    if (Number.isFinite(number) && number > highest) highest = number;
  }
  return highest + 1;
}

/**
 * The version history order, transcribed exactly: highest number first, then by
 * id descending.
 *
 * The id tie-break is what makes the order TOTAL. Two versions cannot share a
 * number — the store's unique index forbids it — so the tie-break is unreachable
 * through the store; it is kept because an in-memory listing assembled from two
 * sources can hold both, and a paged listing whose order is not total silently
 * drops and repeats rows across pages.
 */
export function byVersionOrder(left: AgentVersion, right: AgentVersion): number {
  const byNumber = right.versionNumber - left.versionNumber;
  if (byNumber !== 0) return byNumber;
  if (left.agentVersionId === right.agentVersionId) return 0;
  return left.agentVersionId > right.agentVersionId ? -1 : 1;
}

export interface VersionPageRequest {
  readonly cursor?: string | null;
  readonly take?: number;
  readonly offset?: number;
}

export interface VersionPageWindow {
  readonly take: number;
  readonly offset: number;
  readonly cursor: string | null;
}

/**
 * Clamp a page request.
 *
 * A cursor and an offset are mutually exclusive, and the cursor wins — which is
 * why the reported offset is zero whenever one is supplied. Reporting the
 * requested offset alongside a cursor-paged result would tell a client it is
 * somewhere it is not.
 */
export function windowFor(request: VersionPageRequest, policy: AgentVersionPolicy): VersionPageWindow {
  const take = Math.max(1, Math.min(policy.maxPageSize, Math.floor(request.take ?? policy.defaultPageSize)));
  const cursor = request.cursor ?? null;
  const offset = cursor === null ? Math.max(0, Math.floor(request.offset ?? 0)) : 0;
  return { take, offset, cursor };
}

export interface PrunePlan {
  readonly eligible: readonly AgentVersionId[];
  readonly kept: number;
  /** Always true. See the note at the top of this file. */
  readonly dryRun: true;
  readonly keepNewest: number;
  readonly keepDays: number;
  readonly cutoff: Date;
}

export interface PruneRequest {
  readonly keepNewest?: number;
  readonly keepDays?: number;
}

/** Milliseconds in one day. The retention window's unit. */
export const DAY_MS = 86_400_000;

/**
 * Which versions a retention policy would let go.
 *
 * Three things protect a version and all three are absolute: it is the live one,
 * it is the canary, or it is among the newest N. Only what survives all three is
 * then tested against the age cutoff, so a quiet agent whose newest version is
 * two years old still keeps it.
 */
export function planPrune(
  versions: readonly AgentVersion[],
  live: { readonly activeVersionId: AgentVersionId; readonly canaryVersionId: AgentVersionId | null },
  request: PruneRequest,
  policy: AgentVersionPolicy,
  now: Date,
): PrunePlan {
  const keepNewest = Math.max(1, Math.floor(request.keepNewest ?? policy.keepNewest));
  const keepDays = Math.max(1, Math.floor(request.keepDays ?? policy.keepDays));
  const cutoff = new Date(now.getTime() - keepDays * DAY_MS);
  const ordered = [...versions].sort(byVersionOrder);
  const protectedIds = new Set<string>([
    live.activeVersionId,
    ...(live.canaryVersionId === null ? [] : [live.canaryVersionId]),
    ...ordered.slice(0, keepNewest).map((version) => version.agentVersionId),
  ]);
  const eligible = ordered
    .filter((version) => !protectedIds.has(version.agentVersionId) && version.createdAt < cutoff)
    .map((version) => version.agentVersionId);
  return {
    eligible,
    kept: ordered.length - eligible.length,
    dryRun: true,
    keepNewest,
    keepDays,
    cutoff,
  };
}
