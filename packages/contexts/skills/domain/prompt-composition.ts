// Merging active skills into one prompt block and one tool catalogue.
//
// This is the rule that decides what a turn actually sees. Every part of it is
// transcribed from the live runtime merge, and each part exists because of a
// specific failure:
//
// A CHARACTER BUDGET, NOT A SKILL COUNT. One accidentally enormous skill can
//   consume the whole context window on its own, so the ceiling is on total
//   characters. The budget is checked BEFORE a block is admitted, so the total
//   never exceeds it — it is a ceiling, not a target.
//
// OVER-BUDGET STOPS, IT DOES NOT SKIP. On the first block that will not fit,
//   composition BREAKS rather than continuing to look for a smaller one that
//   would. This is deliberate and it is why registration order is meaningful:
//   the set a turn sees is a PREFIX of the enabled set, which is stable and
//   explicable, rather than a knapsack solution that reshuffles whenever one
//   skill's prose is edited.
//
// A SKILL WITH NO PROSE CONTRIBUTES NOTHING — NOT EVEN ITS TOOLS. An empty
//   prompt block skips the whole entry, tools included. That reading is easy to
//   get wrong (the tools look independent), and it matters: a tool offered with
//   no prose telling the model when to use it is a tool the model misuses.
//   Preserved as-is; a change here is a behaviour change, not a tidy-up.
//
// THE OMISSION NOTICE IS NOT CHARGED TO THE BUDGET. It is appended after the
//   ceiling check, so a set that exactly fills the budget still gets told it was
//   truncated. Charging it would mean dropping a skill to make room for the
//   sentence explaining that a skill was dropped.

import type { NamespacedToolName, SkillSlug } from "./identifiers.js";
import type { SkillProvidedTool } from "./manifest.js";
import { namespaceTool } from "./tool-namespace.js";

/** The section heading the merged block opens with. */
export const SKILLS_PROMPT_HEADING = "## Enabled Skills";

/** What separates two skills' blocks. */
export const SKILL_BLOCK_SEPARATOR = "\n\n---\n\n";

/** One skill, as composition sees it. */
export interface ComposableSkill {
  readonly slug: SkillSlug;
  readonly name: string;
  readonly promptBlock: string;
  readonly providesTools: readonly SkillProvidedTool[];
}

/** One entry of the merged catalogue: the tool, renamed, and its owner. */
export interface ComposedTool {
  readonly name: NamespacedToolName;
  readonly description: string;
  readonly inputSchema: SkillProvidedTool["inputSchema"];
  readonly outputSchema: SkillProvidedTool["outputSchema"];
  readonly handler: string | null;
  /** The slug this tool came from — how a dispatch finds its executor again. */
  readonly slug: SkillSlug;
}

export interface ComposedSkills {
  /** The skills that were admitted, in order. A prefix of what was offered. */
  readonly admitted: readonly ComposableSkill[];
  /** The skills the budget excluded, in order. */
  readonly omitted: readonly ComposableSkill[];
  /** The merged markdown. Empty when nothing was admitted. */
  readonly promptBlock: string;
  readonly tools: readonly ComposedTool[];
  readonly truncated: boolean;
}

export function skillHeader(skill: ComposableSkill): string {
  return `## Skill: ${skill.name} (${skill.slug})`;
}

export function skillBlock(skill: ComposableSkill): string {
  return `${skillHeader(skill)}\n\n${skill.promptBlock.trim()}`;
}

export function omissionNotice(maxChars: number): string {
  return `_[Some skills were omitted because the total skill prompt would exceed ${maxChars} characters.]_`;
}

function composedTools(skill: ComposableSkill): ComposedTool[] {
  return skill.providesTools.map((tool) => ({
    name: namespaceTool(skill.slug, tool.name),
    description: tool.description,
    inputSchema: tool.inputSchema,
    outputSchema: tool.outputSchema,
    handler: tool.handler,
    slug: skill.slug,
  }));
}

/**
 * Merge active skills under a character ceiling.
 *
 * Pure, and deliberately so: given the same skills and the same ceiling it
 * returns the same block, which is what lets a prompt cache key on the skill set
 * rather than re-deriving it, and what lets the budget be exercised at an exact
 * boundary in a test instead of approximately.
 */
export function composeSkills(skills: readonly ComposableSkill[], maxChars: number): ComposedSkills {
  const admitted: ComposableSkill[] = [];
  const omitted: ComposableSkill[] = [];
  const blocks: string[] = [];
  const tools: ComposedTool[] = [];
  let total = 0;
  let truncated = false;

  for (let index = 0; index < skills.length; index += 1) {
    const skill = skills[index];
    if (skill === undefined) continue;
    if (skill.promptBlock.trim() === "") continue;
    const block = skillBlock(skill);
    if (total + block.length > maxChars) {
      truncated = true;
      // Everything from here on is omitted, including entries that would fit.
      // See the header: a prefix is stable, a best fit is not.
      omitted.push(...skills.slice(index).filter((rest): rest is ComposableSkill => rest !== undefined));
      break;
    }
    blocks.push(block);
    total += block.length;
    admitted.push(skill);
    tools.push(...composedTools(skill));
  }

  if (truncated) blocks.push(omissionNotice(maxChars));

  return {
    admitted,
    omitted,
    promptBlock: blocks.length === 0 ? "" : `${SKILLS_PROMPT_HEADING}\n\n${blocks.join(SKILL_BLOCK_SEPARATOR)}`,
    tools,
    truncated,
  };
}

/**
 * Splice a merged skill block into an agent's own system prompt.
 *
 * Either side may be absent and the result must still be well formed: no
 * dangling rule, no leading blank lines. The separator appears only when there
 * are genuinely two things to separate.
 */
export function composeSystemPrompt(basePrompt: string | null, skillBlock: string): string {
  const base = basePrompt?.trim() ?? "";
  if (skillBlock.trim() === "") return base;
  if (base === "") return skillBlock;
  return `${base}${SKILL_BLOCK_SEPARATOR}${skillBlock}`;
}
