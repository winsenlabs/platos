// The grouping hint a skill carries, and how one is derived when it carries none.
//
// A category groups skills in the tools surface. An author may declare one; most
// do not, so the fallback is what almost every row actually gets, and it is
// worth writing down precisely:
//
//     platos.web_search   -> last dotted segment "web_search" -> head "web"
//     acme.csv-ops        -> "csv-ops"                        -> "csv"
//     platos.rag          -> "rag"                            -> "rag"
//     (unparseable)                                            -> "uncategorized"
//
// The head is the part before the first `-` or `_`. That is a heuristic and it
// is meant to be one: it clusters `web_search` with `web_fetch` without anybody
// maintaining a mapping, and an author who dislikes the guess declares
// `category:` and overrides it.
//
// The literal `"uncategorized"` is a stored, user-visible value. It is spelled
// once, here.

import type { SkillSlug } from "./identifiers.js";
import type { SkillManifest } from "./manifest.js";

export const UNCATEGORIZED = "uncategorized";

/**
 * A declared category wins; otherwise derive one from the slug.
 *
 * The manifest is nullable because a row read back from an older write may hold
 * no manifest at all, and returning a category anyway is better than making
 * every caller handle the absence.
 */
export function deriveSkillCategory(slug: SkillSlug | string, manifest: SkillManifest | null): string {
  const declared = manifest?.category?.trim();
  if (declared !== undefined && declared !== "") return declared;
  // Take the LAST dotted segment: the namespace prefix is the author, not the
  // subject, and grouping by it would put every Platos skill in one bucket.
  const segments = String(slug ?? "").split(".");
  const tail = segments[segments.length - 1] ?? "";
  const head = tail.split(/[-_]/u)[0]?.trim() ?? "";
  return head === "" ? UNCATEGORIZED : head;
}
