// Use case: read the catalogue, with readiness resolved.
//
// Every read here is scoped, and every scoped read that finds nothing reports
// ABSENCE rather than denial. A caller must not be able to tell "no such skill"
// from "not yours" by the shape of the answer, or the surface becomes a probe
// for the existence of another tenant's rows.
//
// READINESS IS RESOLVED IN ONE BATCH PER READ, NOT ONE LOOKUP PER SKILL. The
// distinct key names across the whole page go to the directory together and the
// answer is shared out. A page of thirty skills is one call. Doing it per row
// would be thirty, and the shape of the code would hide that it was thirty.
//
// A READINESS FAILURE FAILS THE READ. If the directory is unreachable the read
// returns its failure rather than an empty presence map. An empty map reads as
// "nothing is set", which would paint every skill in the environment as broken
// on a transient blip — a lie that looks exactly like the real thing an operator
// is trying to diagnose.

import { err, ok, type Result } from "@platos/kernel";

import {
  distinctRequiredKeys,
  skillNotFound,
  type CatalogueEntry,
  type CatalogueScope,
  type EnvironmentKeyPresence,
} from "../domain/index.js";
import type { SkillsDependencies } from "./dependencies.js";
import type { CatalogueQuery } from "./ports/index.js";

/**
 * One presence map covering every key these entries declare.
 *
 * Only REQUIRED keys are looked up. An optional key that is unset is not a
 * problem to report — that is what optional means — and querying it would put
 * names in the lookup that no decision depends on.
 */
export async function presenceFor(
  dependencies: SkillsDependencies,
  scope: CatalogueScope,
  entries: readonly CatalogueEntry[],
): Promise<Result<EnvironmentKeyPresence>> {
  const keys = distinctRequiredKeys(entries.map((entry) => entry.requiredEnvironmentKeys));
  if (keys.length === 0) return ok({});
  return dependencies.environmentKeys.presenceOf(scope.environment, keys);
}

export interface HydratedCatalogue {
  readonly entries: readonly CatalogueEntry[];
  readonly presence: EnvironmentKeyPresence;
}

export interface HydratedCataloguePage extends HydratedCatalogue {
  readonly total: number;
}

export async function listCatalogue(
  dependencies: SkillsDependencies,
  scope: CatalogueScope,
): Promise<Result<HydratedCatalogue>> {
  const entries = await dependencies.repository.listVisibleSkills(scope);
  if (!entries.ok) return err(entries.error);
  const presence = await presenceFor(dependencies, scope, entries.value);
  if (!presence.ok) return err(presence.error);
  return ok({ entries: entries.value, presence: presence.value });
}

/**
 * Clamp a requested window to something the store will answer.
 *
 * A negative offset and a zero limit are both meaningless rather than
 * adversarial, and a limit above the policy ceiling is a caller asking for more
 * than the surface offers. All three are corrected here, once, rather than
 * defended against in the adapter and again in the transport.
 */
export function clampQuery(query: CatalogueQuery, maxPageSize: number): CatalogueQuery {
  const limit = Math.min(Math.max(1, Math.trunc(query.limit)), maxPageSize);
  const offset = Math.max(0, Math.trunc(query.offset));
  const search = query.search === null || query.search.trim() === "" ? null : query.search.trim();
  return { limit, offset, search };
}

export async function pageCatalogue(
  dependencies: SkillsDependencies,
  scope: CatalogueScope,
  query: CatalogueQuery,
): Promise<Result<HydratedCataloguePage>> {
  const page = await dependencies.repository.pageVisibleSkills(
    scope,
    clampQuery(query, dependencies.policy.catalogue.maxPageSize),
  );
  if (!page.ok) return err(page.error);
  const presence = await presenceFor(dependencies, scope, page.value.items);
  if (!presence.ok) return err(presence.error);
  return ok({ entries: page.value.items, presence: presence.value, total: page.value.total });
}

/**
 * Resolve one skill by row id or slug, failing when it is not visible.
 *
 * The reference is deliberately untyped: this is the boundary where an operator-
 * supplied string becomes either a `SkillId` or a `SkillSlug`, and the store is
 * the only thing that can tell which. Everything past this point holds a
 * resolved entry and a branded id.
 */
export async function findVisibleSkill(
  dependencies: SkillsDependencies,
  scope: CatalogueScope,
  reference: string,
): Promise<Result<CatalogueEntry>> {
  const found = await dependencies.repository.findVisibleSkillByReference(scope, reference);
  if (!found.ok) return err(found.error);
  if (found.value === null) return err(skillNotFound(reference));
  return ok(found.value);
}
