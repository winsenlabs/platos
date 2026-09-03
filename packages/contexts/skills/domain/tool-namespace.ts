// Folding a skill's identity into the names of the tools it contributes.
//
// A skill declares a tool called `search`. So does the next skill. So, possibly,
// does an entity-provided tool that has nothing to do with skills at all. The
// runtime merges all of them into ONE flat catalogue handed to a model, so the
// names must be unique across that whole catalogue or a call is dispatched to
// whichever one happened to be registered last.
//
// The rule: replace every `.` and `-` in the slug with `_`, then join to the
// tool name with a DOUBLE underscore.
//
//     platos.web_search + search  ->  platos_web_search__search
//     acme.csv-ops      + read    ->  acme_csv_ops__read
//
// The double underscore is the separator precisely because single underscores
// survive the substitution: with a single separator, `a.b` + `c` and `a` + `b_c`
// would both produce `a_b_c`, and two different tools would collide under the
// scheme built to stop them colliding. With a double one they produce
// `a_b__c` and `a__b_c`.
//
// Substituting rather than rejecting is what keeps the scheme total: `.` and `-`
// are legal in a slug, and a name is needed for every skill that exists, not
// only for the ones whose slugs happen to be identifier-shaped.

import { asIdentifier } from "@platos/kernel";

import type { NamespacedToolName, SkillSlug, ToolName } from "./identifiers.js";

export const TOOL_NAMESPACE_SEPARATOR = "__";

/** The slug, in a form that may appear in a tool name. */
export function toolNamespacePrefix(slug: SkillSlug | string): string {
  return String(slug).replace(/[.-]/gu, "_");
}

export function namespaceTool(slug: SkillSlug | string, toolName: ToolName | string): NamespacedToolName {
  return asIdentifier<NamespacedToolName>(
    `${toolNamespacePrefix(slug)}${TOOL_NAMESPACE_SEPARATOR}${String(toolName)}`,
  );
}

/**
 * Does this namespaced name belong to this skill?
 *
 * The prefix comparison includes the separator. Without it, `platos_web` would
 * claim `platos_web_search__go`, and a per-skill policy check would apply one
 * skill's rules to another's tool.
 */
export function isToolOfSkill(name: NamespacedToolName | string, slug: SkillSlug | string): boolean {
  return String(name).startsWith(`${toolNamespacePrefix(slug)}${TOOL_NAMESPACE_SEPARATOR}`);
}
