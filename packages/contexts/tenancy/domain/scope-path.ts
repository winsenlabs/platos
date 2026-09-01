// The one place a tenant location becomes a KEY.
//
// The kernel already owns `resolvePath()` — `org/<id>`, `org/<id>/proj/<id>`,
// `org/<id>/proj/<id>/env/<id>` — and tenancy does not reimplement it. What is
// added here is the one conversion the kernel cannot do, because it needs the
// tree: turning a loaded ancestry into a scope first.
//
// Everything downstream that needs a namespace — a cache prefix, a rate-limit
// bucket, an object-storage path, a log field — derives it from this string, so
// they agree by construction rather than by convention.
//
// AN ENTITY HAS NO PATH. `Entity` hangs off `Project`, and `resolvePath()`
// addresses the organization/project/environment chain only. An entity is
// addressed by `entityKey(projectId, externalId)` instead. That asymmetry is
// the schema's, not an omission here.

import { resolvePath, type TenantScope } from "@platos/kernel";

import { ancestryScope, type EnvironmentAncestry } from "./ancestry.js";

function isAncestry(value: TenantScope | EnvironmentAncestry): value is EnvironmentAncestry {
  return Object.hasOwn(value, "organization");
}

/** The canonical path of a scope, or of the scope an ancestry resolves to. */
export function resolveScopePathFor(value: TenantScope | EnvironmentAncestry): string {
  return resolvePath(isAncestry(value) ? ancestryScope(value) : value);
}
