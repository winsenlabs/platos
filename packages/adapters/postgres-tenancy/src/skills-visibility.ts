// `domain/visibility.ts` and `domain/catalogue.ts`, expressed as SQL — the two
// cross-tenant decisions of this context, in the one place they become a query.
//
// THE PREDICATE, TRANSCRIBED FROM `isVisible`:
//
//     organizationId matches
//       AND ( isOfficial
//             OR adopted in THIS project AND bound in THIS environment )
//
// The organization match is a CONJUNCT and not a fallback: "official" means
// catalogue-owned, not global, and a row official in another organization must
// not be visible here. The install clause spans BOTH levels: a skill adopted by
// the project but not bound in this environment is invisible, which is what
// stops a staging-only skill leaking into production. Checking only the project
// half is the exact defect the domain module was written to prevent, and it is
// the one an adapter is most likely to reintroduce, because `ProjectSkill` is
// the row that carries `skillId` and the join to `EnvironmentSkill` looks like
// tidying-up.
//
// AN INVISIBLE ROW IS ABSENT, NOT FORBIDDEN. Every read below returns nothing
// rather than refusing, so a caller cannot use the difference between "no such
// skill" and "not yours" to probe another tenant's catalogue.
//
// *** THE ORDER IS THE DATABASE'S COLLATION AND THE DOUBLE'S IS JAVASCRIPT'S ***
//
// `compareCatalogueEntries` orders official-first, then `slug` ascending, then
// `version` DESCENDING, then row id — and it compares strings with `<`, which is
// UTF-16 code-unit order. This `orderBy` produces the same sequence through
// PostgreSQL's collation, which on the image these suites run against is
// `en_US.utf8`. The two agree for the alphanumerics a namespaced slug is made of
// (`domain/manifest.ts` restricts an id to `[a-z0-9_-]` segments) and DISAGREE
// for punctuation, which glibc weighs only after letters and digits: `a-b` and
// `ab` order one way in JavaScript and the other way in the database. `version`
// is an opaque author-supplied string with no such restriction, so the exposure
// is real there rather than theoretical.
//
// It is NOT closed by sorting in memory. `pageVisibleSkills` windows with
// `skip`/`take`, and a store that fetched every visible row in order to sort a
// page of ten would answer a paged read with an unbounded one. So the divergence
// is PINNED as a named case in `skills-constraints.integration.test.ts` and
// reported, rather than papered over: the shared conformance scenario uses
// fixtures both orders agree on, because a scenario is for comparing answers and
// this is a place where the two answers are both correct under different rules.

import type { CatalogueScope } from "@platos/context-skills/application/ports/index.js";

import { looksLikeUuid } from "./skills-guards.js";

/**
 * The catalogue ordering, as `compareCatalogueEntries` states it.
 *
 * `isOfficial: "desc"` puts official first because PostgreSQL orders `false`
 * before `true`. The trailing `id` is not decoration: without it two rows
 * sharing a slug and a version — which the unique index forbids inside one
 * organization and does not forbid across a result set — would order
 * non-deterministically, and a paged read would repeat one row and drop another
 * between pages.
 */
export const CATALOGUE_ORDER = [
  { isOfficial: "desc" },
  { slug: "asc" },
  { version: "desc" },
  { id: "asc" },
] as const;

/**
 * The install clause: adopted in this project AND bound in this environment.
 *
 * Written as a nested relation filter rather than as a join this module
 * assembles, so it compiles into the SAME statement as the rest of the `where`.
 * A second query would make every catalogue read two statements and would open a
 * window in which a binding deleted between them made a row visible that no
 * longer is.
 */
function installedHere(scope: CatalogueScope) {
  return {
    projects: {
      some: {
        projectId: scope.environment.projectId,
        environments: { some: { environmentId: scope.environment.environmentId } },
      },
    },
  };
}

/** `isVisible`, as a `Skill` WHERE clause. */
export function visibleWhere(scope: CatalogueScope) {
  return {
    organizationId: scope.environment.organizationId,
    OR: [{ isOfficial: true }, installedHere(scope)],
  };
}

/**
 * `matchesSearch`, as a WHERE fragment — with one divergence stated out loud.
 *
 * The domain predicate is `name`, `slug` or `description` containing the TRIMMED,
 * lower-cased term as a plain substring. `mode: "insensitive"` is the
 * case half and `contains` is the substring half, and the trim is done HERE
 * because the client does not do it: an untrimmed `" web"` would match nothing
 * in SQL and everything containing `web` in the double.
 *
 * *** `%` AND `_` ARE LIKE METACHARACTERS AND THE CLIENT DOES NOT ESCAPE THEM.
 * *** `contains: "web_search"` becomes `ILIKE '%web\_search%'` only if something
 * escapes the underscore, and nothing does — so it matches `webXsearch` in the
 * database and does not in the double. This is not a hypothetical shape: a
 * namespaced skill id is `[a-z0-9_-]`, so `_` is in the ordinary vocabulary of
 * the very column being searched. There is no escape hatch on `contains` and
 * pre-escaping the term would make a literal backslash unsearchable, so the
 * divergence is pinned as a named case in
 * `skills-constraints.integration.test.ts` and reported rather than hidden.
 */
export function searchWhere(search: string | null) {
  if (search === null) return {};
  const term = search.trim();
  if (term === "") return {};
  return {
    OR: [
      { name: { contains: term, mode: "insensitive" as const } },
      { slug: { contains: term, mode: "insensitive" as const } },
      { description: { contains: term, mode: "insensitive" as const } },
    ],
  };
}

/**
 * A reference that names a row id OR a slug, as ONE WHERE clause.
 *
 * The id arm is GUARDED, and the guard is the finding rather than the tidiness.
 * `Skill.id` is `@db.Uuid`, so an unguarded `{ id: reference }` sends a
 * non-uuid to `uuid_in` and the driver raises — which, inside a caller's
 * transaction, aborts the transaction as well as failing the read. The double
 * answers `null` for exactly the same input. The two arms cannot both match:
 * `domain/manifest.ts` requires a slug to carry a dot and no uuid has one.
 */
export function referenceWhere(reference: string) {
  const bySlug = { slug: reference };
  return looksLikeUuid(reference) ? { OR: [{ id: reference }, bySlug] } : bySlug;
}
