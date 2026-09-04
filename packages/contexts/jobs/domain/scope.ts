// Where this context's two aggregates live.
//
// Both `Job` and `AgentApproval` are keyed by `environmentId` in the baseline
// schema and by nothing else, so unlike `files` there is no second, narrower
// scope to model. What this module adds over the kernel's `EnvironmentScope` is
// the containment predicate an erasure needs: an erasure may be addressed at an
// ORGANIZATION while every row it will touch is environment-keyed, so the
// selector is resolved by containment rather than by equality.

import { contains, resolvePath, type EnvironmentScope, type TenantScope } from "@platos/kernel";

/** The canonical string form, built on the kernel's `resolvePath()`. */
export function environmentPath(scope: EnvironmentScope): string {
  return resolvePath(scope);
}

export function sameEnvironment(left: EnvironmentScope, right: EnvironmentScope): boolean {
  return resolvePath(left) === resolvePath(right);
}

/**
 * True when a row in `environment` falls inside `selector`.
 *
 * This is the predicate that makes an organization-addressed erasure reach the
 * environments beneath it without any caller re-deriving the tree. A scope always
 * contains itself, so an environment-addressed selector still matches exactly one.
 */
export function environmentFallsWithin(selector: TenantScope, environment: EnvironmentScope): boolean {
  return contains(selector, environment);
}
