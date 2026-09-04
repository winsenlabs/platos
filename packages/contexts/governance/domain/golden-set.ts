// A golden set: the conversations a new version must be judged against.
//
// The point of a golden set is that it does not move. Pin the threads and the
// criteria, and every version is scored on the same material, so a difference in
// the mean is a difference in the agent rather than a difference in the sample.
//
// THE FAN-OUT IS THE COST, SO THE FAN-OUT IS CAPPED THREE TIMES. A run makes one
// judge call per (thread, criterion) pair. The source caps nothing: it refuses
// an empty list and stores whatever else it is given, so a set naming 4,000
// threads and 30 criteria plans 120,000 paid judge calls from one API call, in a
// loop with no concurrency limit and no budget check. Three separate ceilings
// are checked here, each with its OWN code, because a set can breach exactly one
// of them and an operator needs to know which:
//
//   too many threads   — the sample is too wide
//   too many criteria  — the sample is too deep
//   too many pairs     — both are individually fine and the PRODUCT is not
//
// DUPLICATES ARE REMOVED RATHER THAN STORED. The source stores the array it is
// handed, so a set naming the same thread twice pays for that thread twice and
// counts it twice in the mean — which quietly doubles that conversation's weight
// in the regression verdict. De-duplication preserves first-seen order, so the
// stored list is still the operator's list.

import { err, ok, type Result } from "@platos/kernel";

import {
  goldenSetInvalid,
  goldenSetTooManyCriteria,
  goldenSetTooManyPairs,
  goldenSetTooManyThreads,
} from "./errors.js";
import type { ActorId, AgentId, EvalCriterionId, GoldenSetId, ThreadId } from "./identifiers.js";
import type { GoldenSetPolicy } from "./policy.js";

export interface GoldenSet {
  readonly goldenSetId: GoldenSetId;
  readonly environmentId: string;
  readonly agentId: AgentId;
  readonly name: string;
  readonly description: string | null;
  readonly threadIds: readonly ThreadId[];
  readonly criterionIds: readonly EvalCriterionId[];
  readonly createdBy: ActorId;
  readonly createdAt: Date;
  readonly updatedAt: Date;
}

export interface GoldenSetDraft {
  readonly agentId: AgentId;
  readonly name: string;
  readonly description?: string | null;
  readonly threadIds: readonly ThreadId[];
  readonly criterionIds: readonly EvalCriterionId[];
}

export interface GoldenSetPatch {
  readonly name?: string;
  readonly description?: string | null;
  readonly threadIds?: readonly ThreadId[];
  readonly criterionIds?: readonly EvalCriterionId[];
}

export interface AdmittedGoldenSet {
  readonly agentId: AgentId;
  readonly name: string;
  readonly description: string | null;
  readonly threadIds: readonly ThreadId[];
  readonly criterionIds: readonly EvalCriterionId[];
  /** How many judge calls a run of this set will make. */
  readonly pairCount: number;
}

/** One judge call a run will make. */
export interface EvalPair {
  readonly threadId: ThreadId;
  readonly criterionId: EvalCriterionId;
}

export function admitGoldenSet(draft: GoldenSetDraft, policy: GoldenSetPolicy): Result<AdmittedGoldenSet> {
  const name = (draft.name ?? "").trim();
  if (name === "") {
    return err(goldenSetInvalid([{ field: "name", code: "blank", message: "name is required" }]));
  }
  if (name.length > policy.maxNameLength) {
    return err(
      goldenSetInvalid([
        { field: "name", code: "too_long", message: `at most ${policy.maxNameLength} characters` },
      ]),
    );
  }

  const threadIds = distinct(draft.threadIds ?? []);
  if (threadIds.length === 0) {
    return err(goldenSetInvalid([{ field: "threadIds", code: "empty", message: "at least one thread is required" }]));
  }
  const criterionIds = distinct(draft.criterionIds ?? []);
  if (criterionIds.length === 0) {
    return err(
      goldenSetInvalid([{ field: "criterionIds", code: "empty", message: "at least one criterion is required" }]),
    );
  }

  // The three ceilings, widest first, so a set breaching more than one reports
  // the list that is wrong before the product that follows from it.
  if (threadIds.length > policy.maxThreads) {
    return err(goldenSetTooManyThreads(threadIds.length, policy.maxThreads));
  }
  if (criterionIds.length > policy.maxCriteria) {
    return err(goldenSetTooManyCriteria(criterionIds.length, policy.maxCriteria));
  }
  const pairCount = threadIds.length * criterionIds.length;
  if (pairCount > policy.maxPairs) return err(goldenSetTooManyPairs(pairCount, policy.maxPairs));

  return ok({
    agentId: draft.agentId,
    name,
    description: normaliseDescription(draft.description ?? null),
    threadIds,
    criterionIds,
    pairCount,
  });
}

/**
 * Apply a patch by re-admitting the whole set.
 *
 * Deliberately not a field-by-field write: the source patches each supplied
 * field independently, so growing only the thread list can carry a set past the
 * pair ceiling with nothing to check it. Re-admission means every ceiling is
 * evaluated against the set as it will be STORED.
 */
export function applyGoldenSetPatch(
  existing: GoldenSet,
  patch: GoldenSetPatch,
  policy: GoldenSetPolicy,
  updatedAt: Date,
): Result<GoldenSet> {
  const admitted = admitGoldenSet(
    {
      agentId: existing.agentId,
      name: patch.name ?? existing.name,
      description: patch.description === undefined ? existing.description : patch.description,
      threadIds: patch.threadIds ?? existing.threadIds,
      criterionIds: patch.criterionIds ?? existing.criterionIds,
    },
    policy,
  );
  if (!admitted.ok) return err(admitted.error);
  return ok({
    ...existing,
    name: admitted.value.name,
    description: admitted.value.description,
    threadIds: admitted.value.threadIds,
    criterionIds: admitted.value.criterionIds,
    updatedAt,
  });
}

/**
 * The pairs a run will judge, thread-major.
 *
 * Thread-major rather than criterion-major because the transcript for one thread
 * is read once and scored against every criterion, so this order is the one a
 * runner can cache along.
 */
export function planPairs(set: {
  readonly threadIds: readonly ThreadId[];
  readonly criterionIds: readonly EvalCriterionId[];
}): readonly EvalPair[] {
  const pairs: EvalPair[] = [];
  for (const threadId of set.threadIds) {
    for (const criterionId of set.criterionIds) pairs.push({ threadId, criterionId });
  }
  return pairs;
}

function distinct<Value extends string>(values: readonly Value[]): readonly Value[] {
  const seen = new Set<string>();
  const out: Value[] = [];
  for (const value of values) {
    const trimmed = value.trim() as Value;
    if (trimmed === "") continue;
    if (seen.has(trimmed)) continue;
    seen.add(trimmed);
    out.push(trimmed);
  }
  return out;
}

function normaliseDescription(value: string | null): string | null {
  if (value === null) return null;
  const trimmed = value.trim();
  return trimmed === "" ? null : trimmed;
}
