// Does an erasure's scope reach a stored row?
//
// A subject can be addressed at an organization, a project or an environment,
// and a row is stored at exactly one environment. The kernel's `contains`
// answers this for two `TenantScope`s, so this is a two-line adapter that builds
// the row's environment scope and asks it — rather than a hand-rolled
// comparison per repository, which is how the doubles would come to disagree
// with each other about what "another organization" means.

import { contains, environmentScope, asIdentifier, type TenantScope } from "@platos/kernel";

export interface StoredScope {
  readonly organizationId: string;
  readonly projectId: string;
  readonly environmentId: string;
}

export function scopeReaches(outer: TenantScope, stored: StoredScope): boolean {
  return contains(
    outer,
    environmentScope(
      asIdentifier(stored.organizationId),
      asIdentifier(stored.projectId),
      asIdentifier(stored.environmentId),
    ),
  );
}
