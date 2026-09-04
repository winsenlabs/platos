// Asking every target what it holds, without touching any of it.
//
// `ErasureTarget.plan` is required not to mutate, which is what lets this run
// twice: once before the destruction, to produce the inventory a hold is
// adjudicated against, and once after it, as the post-delete probe. The two
// callers are `inventory-subject.ts` and `run-erasure-pass.ts`, and they share
// this module so the second cannot quietly ask a different question than the
// first.
//
// ONE PLAN PER (TARGET, SUBJECT). A person routinely spans several scopes, and
// the kernel addresses a target with one `ErasureSubject` at a time. Merging the
// scopes before asking would make a target certify a scope it never looked at.
//
// A TARGET THAT THROWS DOES NOT ABORT THE OTHERS. Planning is read-only, so a
// target that cannot answer costs nothing but the answer; it is recorded as
// unplannable and the operation stays open. A crash in one target's planner that
// stopped the rest from being asked would leave far more personal data in place
// than it protected.

import type { ErasurePlan, ErasureSubject, ErasureTarget } from "@platos/kernel";

import { plannedRowCount } from "../domain/index.js";
import { resolveTargets, type PrivacyDependencies } from "./dependencies.js";

/** Everything one pass knows about one target before it runs. */
export interface PlannedTarget {
  readonly name: string;
  /** Null when the composition root did not inject a target of this name. */
  readonly target: ErasureTarget | null;
  /** One plan per subject, in subject order. Empty when planning failed. */
  readonly plans: readonly ErasurePlan[];
  /** The error CLASS of a planner that threw, never its message. */
  readonly failure: string | null;
}

/**
 * The code a rejection is recorded under.
 *
 * Reads a `DomainError` carried on a thrown error — the shape sibling contexts
 * use to get a typed failure out through a port with no failure channel — and
 * falls back to the error's CLASS. Messages are never read: they routinely embed
 * the identifiers being erased.
 */
export function rejectionCode(error: unknown): string {
  if (typeof error === "object" && error !== null && "domainError" in error) {
    const carried = (error as { readonly domainError?: { readonly code?: unknown } }).domainError;
    if (carried !== undefined && typeof carried.code === "string") return carried.code;
  }
  if (error instanceof Error) return error.name;
  return "Error";
}

async function planOne(
  target: ErasureTarget,
  subjects: readonly ErasureSubject[],
): Promise<{ readonly plans: readonly ErasurePlan[]; readonly failure: string | null }> {
  const plans: ErasurePlan[] = [];
  for (const subject of subjects) {
    try {
      plans.push(await target.plan(subject));
    } catch (error) {
      return { plans: [], failure: rejectionCode(error) };
    }
  }
  return { plans, failure: null };
}

/**
 * Ask every target in the roster to plan every subject.
 *
 * `only` narrows the roster to the targets a retry needs to re-run. Omitting it
 * asks everyone, which is what a first pass and an inventory both want.
 */
export async function planErasure(
  dependencies: PrivacyDependencies,
  subjects: readonly ErasureSubject[],
  only?: readonly string[],
): Promise<readonly PlannedTarget[]> {
  const roster = resolveTargets(dependencies);
  const wanted = only === undefined ? null : new Set(only);
  const planned: PlannedTarget[] = [];
  for (const entry of roster) {
    if (wanted !== null && !wanted.has(entry.name)) continue;
    if (entry.target === null) {
      planned.push({ name: entry.name, target: null, plans: [], failure: null });
      continue;
    }
    const result = await planOne(entry.target, subjects);
    planned.push({ name: entry.name, target: entry.target, plans: result.plans, failure: result.failure });
  }
  return planned;
}

/** Rows the whole roster says it holds. */
export function totalPlannedRows(planned: readonly PlannedTarget[]): number {
  return planned.reduce(
    (total, entry) => total + entry.plans.reduce((sum, plan) => sum + plannedRowCount(plan), 0),
    0,
  );
}
