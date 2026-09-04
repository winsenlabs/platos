import { asIdentifier } from "@platos/kernel";
import { describe, expect, it } from "vitest";

import type { SkillSlug, ToolName } from "./identifiers.js";
import type { SkillProvidedTool } from "./manifest.js";
import {
  composeSkills,
  composeSystemPrompt,
  omissionNotice,
  skillBlock,
  SKILLS_PROMPT_HEADING,
  type ComposableSkill,
} from "./prompt-composition.js";

function tool(name: string): SkillProvidedTool {
  return {
    name: asIdentifier<ToolName>(name),
    description: `does ${name}`,
    inputSchema: null,
    outputSchema: null,
    handler: `h:${name}`,
  };
}

function skill(slug: string, promptBlock: string, tools: readonly string[] = []): ComposableSkill {
  return {
    slug: asIdentifier<SkillSlug>(slug),
    name: slug.toUpperCase(),
    promptBlock,
    providesTools: tools.map(tool),
  };
}

/** A ceiling that admits exactly the first N of these fixed-size blocks. */
function ceilingFor(skills: readonly ComposableSkill[], admit: number): number {
  return skills.slice(0, admit).reduce((total, entry) => total + skillBlock(entry).length, 0);
}

describe("composeSkills", () => {
  it("returns an empty block and no tools when there is nothing to merge", () => {
    const composed = composeSkills([], 1000);
    expect(composed.promptBlock).toBe("");
    expect(composed.tools).toEqual([]);
    expect(composed.truncated).toBe(false);
  });

  it("heads the merged block and separates skills with a rule", () => {
    const composed = composeSkills([skill("a.b", "First."), skill("c.d", "Second.")], 1000);
    expect(composed.promptBlock.startsWith(`${SKILLS_PROMPT_HEADING}\n\n`)).toBe(true);
    expect(composed.promptBlock).toContain("## Skill: A.B (a.b)");
    expect(composed.promptBlock).toContain("\n\n---\n\n");
    expect(composed.admitted).toHaveLength(2);
  });

  it("namespaces every contributed tool with its owning skill", () => {
    const composed = composeSkills([skill("platos.web_search", "P.", ["search"])], 1000);
    expect(composed.tools[0]?.name).toBe("platos_web_search__search");
    expect(composed.tools[0]?.slug).toBe("platos.web_search");
  });

  it("SKIPS a skill with an empty prompt block — and drops its tools with it", () => {
    const composed = composeSkills([skill("a.b", "   ", ["ghost"]), skill("c.d", "Real.")], 1000);
    expect(composed.admitted.map((entry) => entry.slug)).toEqual(["c.d"]);
    expect(composed.tools).toHaveLength(0);
    expect(composed.truncated).toBe(false);
  });

  it("admits a set that EXACTLY fills the budget, without claiming truncation", () => {
    const skills = [skill("a.b", "First."), skill("c.d", "Second.")];
    const composed = composeSkills(skills, ceilingFor(skills, 2));
    expect(composed.admitted).toHaveLength(2);
    expect(composed.truncated).toBe(false);
    expect(composed.promptBlock).not.toContain("omitted");
  });

  it("REFUSES the block that would cross the budget by one character", () => {
    const skills = [skill("a.b", "First."), skill("c.d", "Second.")];
    const composed = composeSkills(skills, ceilingFor(skills, 2) - 1);
    expect(composed.admitted.map((entry) => entry.slug)).toEqual(["a.b"]);
    expect(composed.truncated).toBe(true);
    expect(composed.omitted.map((entry) => entry.slug)).toEqual(["c.d"]);
  });

  it("STOPS at the first over-budget block rather than skipping to a smaller one", () => {
    // The middle skill will not fit; the third would. A knapsack would take it.
    const skills = [skill("a.b", "x".repeat(20)), skill("c.d", "y".repeat(500)), skill("e.f", "z")];
    const composed = composeSkills(skills, skillBlock(skills[0]!).length + 10);
    expect(composed.admitted.map((entry) => entry.slug)).toEqual(["a.b"]);
    expect(composed.omitted.map((entry) => entry.slug)).toEqual(["c.d", "e.f"]);
  });

  it("does not contribute the tools of a skill the budget excluded", () => {
    const skills = [skill("a.b", "First.", ["kept"]), skill("c.d", "Second.", ["dropped"])];
    const composed = composeSkills(skills, ceilingFor(skills, 1));
    expect(composed.tools.map((entry) => entry.name)).toEqual(["a_b__kept"]);
  });

  it("appends the omission notice WITHOUT charging it to the budget", () => {
    const skills = [skill("a.b", "First."), skill("c.d", "Second.")];
    const ceiling = ceilingFor(skills, 1);
    const composed = composeSkills(skills, ceiling);
    expect(composed.promptBlock).toContain(omissionNotice(ceiling));
    // The notice pushed the rendered block past the ceiling, which is the point.
    expect(composed.promptBlock.length).toBeGreaterThan(ceiling);
  });

  it("still heads the block when the very first skill was too large", () => {
    const composed = composeSkills([skill("a.b", "x".repeat(500))], 10);
    expect(composed.admitted).toHaveLength(0);
    expect(composed.truncated).toBe(true);
    expect(composed.promptBlock).toBe(`${SKILLS_PROMPT_HEADING}\n\n${omissionNotice(10)}`);
  });

  it("trims a skill's prose but keeps its header attached", () => {
    const composed = composeSkills([skill("a.b", "\n\n  Padded.  \n\n")], 1000);
    expect(composed.promptBlock).toBe(`${SKILLS_PROMPT_HEADING}\n\n## Skill: A.B (a.b)\n\nPadded.`);
  });

  it("preserves the order it was given, since that order decides who survives", () => {
    const composed = composeSkills([skill("z.z", "Z."), skill("a.a", "A.")], 1000);
    expect(composed.admitted.map((entry) => entry.slug)).toEqual(["z.z", "a.a"]);
  });
});

describe("composeSystemPrompt", () => {
  it("returns the base alone when there is no skill block", () => {
    expect(composeSystemPrompt("Base.", "")).toBe("Base.");
    expect(composeSystemPrompt("Base.", "   ")).toBe("Base.");
  });

  it("returns the skill block alone when there is no base", () => {
    expect(composeSystemPrompt(null, "Skills.")).toBe("Skills.");
    expect(composeSystemPrompt("   ", "Skills.")).toBe("Skills.");
  });

  it("returns empty when neither side has anything", () => {
    expect(composeSystemPrompt(null, "")).toBe("");
  });

  it("joins the two with a rule, and trims the base first", () => {
    expect(composeSystemPrompt("  Base.  ", "Skills.")).toBe("Base.\n\n---\n\nSkills.");
  });
});
