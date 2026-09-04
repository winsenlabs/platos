// Which catalogue rows a scope may see.
//
// The rule, transcribed from the live `visibleWhere`:
//
//     organizationId matches
//       AND ( isOfficial
//             OR installed in THIS project AND bound in THIS environment )
//
// Three things about it are worth stating out loud, because each is a
// cross-tenant question and this is the only place the answer lives.
//
// 1. THE ORGANIZATION MATCH IS A CONJUNCT, NOT A FALLBACK. An official skill is
//    visible without an install, but only inside its own organization. "Official"
//    means catalogue-owned, not global.
//
// 2. THE INSTALL CLAUSE IS A CONJUNCTION ACROSS TWO LEVELS. A skill installed in
//    the project but not bound in this environment is NOT visible here. Checking
//    only the project half would leak a staging-only skill into production.
//
// 3. AN INVISIBLE ROW IS ABSENT, NOT FORBIDDEN. Every read returns null rather
//    than an authorization failure, so a caller cannot use the difference between
//    "not found" and "not yours" to probe for the existence of another tenant's
//    rows.

import { contains, type EnvironmentScope, type OrganizationScope } from "@platos/kernel";

import type { CatalogueEntry } from "./catalogue.js";
import type { Installation } from "./installation.js";

/** Where a catalogue read is addressed: one environment, and its ancestry. */
export interface CatalogueScope {
  readonly environment: EnvironmentScope;
}

export function catalogueScope(environment: EnvironmentScope): CatalogueScope {
  return { environment };
}

/** The organization a catalogue read is confined to. */
export function organizationOf(scope: CatalogueScope): OrganizationScope {
  return { level: "organization", organizationId: scope.environment.organizationId };
}

/**
 * Does this entry belong to the reading scope's organization?
 *
 * Uses the kernel's containment predicate rather than comparing ids, so the one
 * definition of "inside" serves every authorization decision in the system.
 */
export function belongsToOrganization(entry: CatalogueEntry, scope: CatalogueScope): boolean {
  return contains(entry.identity.organization, scope.environment);
}

/**
 * The full visibility predicate.
 *
 * `installation` is this scope's install of this entry, or null when there is
 * none. Note that the install's `enabled` flags are NOT consulted: a disabled
 * skill is still VISIBLE — it appears in the library switched off, which is what
 * lets an operator switch it back on. Usability is the separate question
 * `isUsable` answers.
 */
export function isVisible(
  entry: CatalogueEntry,
  scope: CatalogueScope,
  installation: Installation | null,
): boolean {
  if (!belongsToOrganization(entry, scope)) return false;
  if (entry.isOfficial) return true;
  return installation !== null;
}
