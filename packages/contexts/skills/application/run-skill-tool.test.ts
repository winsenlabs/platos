import { asIdentifier, organizationScope } from "@platos/kernel";
import { beforeEach, describe, expect, it } from "vitest";

import { namespaceTool, parseSkillSource, type NamespacedToolName, type SkillSlug, type ToolName } from "../domain/index.js";
import { bindSkill } from "./bind-skill.js";
import { registerOfficialSkill } from "./register-skill.js";
import { resolveDispatchedTool, runSkillTool } from "./run-skill-tool.js";
import {
  buildSkillsTestContext,
  scopeFor,
  skillSource,
  type SkillsTestContext,
} from "./testing/index.js";

const ORG = organizationScope(asIdentifier("org-1"));
const SCOPE = scopeFor("org-1", "proj-1", "env-1");

function parsed(source: string) {
  const result = parseSkillSource(source);
  if (!result.ok) throw new Error(result.error.code);
  return result.value;
}

const dispatched = (slug: string, tool: string): NamespacedToolName =>
  namespaceTool(asIdentifier<SkillSlug>(slug), asIdentifier<ToolName>(tool));

interface SeedOptions {
  readonly requiredEnv?: readonly string[];
  readonly handler?: string | undefined;
}

async function seedBound(
  context: SkillsTestContext,
  id: string,
  toolName: string,
  options: SeedOptions = {},
): Promise<void> {
  const seeded = await registerOfficialSkill(context.dependencies, {
    organization: ORG,
    parsed: parsed(
      skillSource({
        id,
        ...(options.requiredEnv === undefined ? {} : { requiredEnv: options.requiredEnv }),
        tools: [{ name: toolName, ...(options.handler === undefined ? {} : { handler: options.handler }) }],
      }),
    ),
  });
  if (!seeded.ok) throw new Error(seeded.error.code);
  for (const key of options.requiredEnv ?? []) context.environmentKeys.setKey(key);
  const bound = await bindSkill(context.dependencies, { scope: SCOPE, reference: id });
  if (!bound.ok) throw new Error(bound.error.code);
}

describe("resolveDispatchedTool", () => {
  it("finds the manifest tool behind a namespaced name", async () => {
    const context = buildSkillsTestContext();
    await seedBound(context, "platos.web_search", "search", { handler: "h" });
    const entry = context.repository.allSkills()[0];
    if (entry === undefined) throw new Error("unreachable");
    expect(resolveDispatchedTool(entry, dispatched("platos.web_search", "search"))?.name).toBe("search");
  });

  it("REFUSES a name belonging to a different skill", async () => {
    const context = buildSkillsTestContext();
    await seedBound(context, "platos.web_search", "search", { handler: "h" });
    const entry = context.repository.allSkills()[0];
    if (entry === undefined) throw new Error("unreachable");
    expect(resolveDispatchedTool(entry, dispatched("acme.other", "search"))).toBeNull();
  });

  it("REFUSES a well-formed name for a tool the manifest never declared", async () => {
    const context = buildSkillsTestContext();
    await seedBound(context, "platos.web_search", "search", { handler: "h" });
    const entry = context.repository.allSkills()[0];
    if (entry === undefined) throw new Error("unreachable");
    // Being well formed is not the same as being real. A name that merely
    // parses must not reach a sandbox.
    expect(resolveDispatchedTool(entry, dispatched("platos.web_search", "delete_everything"))).toBeNull();
  });
});

describe("runSkillTool", () => {
  let context: SkillsTestContext;

  beforeEach(() => {
    context = buildSkillsTestContext();
  });

  it("runs the tool and returns its result", async () => {
    await seedBound(context, "platos.web_search", "search", { handler: "h:search" });
    context.sandbox.put("h:search", { hits: 3 });
    const outcome = await runSkillTool(context.dependencies, {
      scope: SCOPE,
      reference: "platos.web_search",
      toolName: dispatched("platos.web_search", "search"),
      input: { q: "a" },
    });
    if (!outcome.ok) throw new Error(outcome.error.code);
    expect(outcome.value.result).toEqual({ hits: 3 });
  });

  it("hands the sandbox the BARE tool name, not the namespaced one", async () => {
    await seedBound(context, "platos.web_search", "search", { handler: "h:search" });
    context.sandbox.put("h:search", null);
    await runSkillTool(context.dependencies, {
      scope: SCOPE,
      reference: "platos.web_search",
      toolName: dispatched("platos.web_search", "search"),
      input: {},
    });
    expect(context.sandbox.runs[0]?.toolName).toBe("search");
    expect(context.sandbox.runs[0]?.handler).toBe("h:search");
  });

  it("passes environment key NAMES and never a value", async () => {
    await seedBound(context, "a.b", "go", { handler: "h", requiredEnv: ["SECRET_TOKEN"] });
    context.sandbox.put("h", null);
    await runSkillTool(context.dependencies, {
      scope: SCOPE,
      reference: "a.b",
      toolName: dispatched("a.b", "go"),
      input: {},
    });
    expect(context.sandbox.runs[0]?.environmentKeys).toEqual(["SECRET_TOKEN"]);
  });

  it("passes the binding's config through to the sandbox", async () => {
    await seedBound(context, "a.b", "go", { handler: "h" });
    context.sandbox.put("h", null);
    await runSkillTool(context.dependencies, {
      scope: SCOPE,
      reference: "a.b",
      toolName: dispatched("a.b", "go"),
      input: {},
    });
    expect(context.sandbox.runs[0]?.config).toEqual({});
  });

  it("REFUSES a tool the skill does not declare, WITHOUT touching the sandbox", async () => {
    await seedBound(context, "a.b", "go", { handler: "h" });
    const outcome = await runSkillTool(context.dependencies, {
      scope: SCOPE,
      reference: "a.b",
      toolName: dispatched("a.b", "nope"),
      input: {},
    });
    expect(outcome.ok).toBe(false);
    if (outcome.ok) throw new Error("unreachable");
    expect(outcome.error.code).toBe("SKILLS_SANDBOX_REFUSED");
    expect(context.sandbox.runs).toHaveLength(0);
  });

  it("REFUSES a tool that declares no handler, rather than guessing one", async () => {
    await seedBound(context, "a.b", "go");
    const outcome = await runSkillTool(context.dependencies, {
      scope: SCOPE,
      reference: "a.b",
      toolName: dispatched("a.b", "go"),
      input: {},
    });
    expect(outcome.ok).toBe(false);
    if (outcome.ok) throw new Error("unreachable");
    expect(outcome.error.details.reason).toBe("tool declares no handler to dispatch to");
    expect(context.sandbox.runs).toHaveLength(0);
  });

  it("REFUSES when a required key was unset after binding, WITHOUT touching the sandbox", async () => {
    await seedBound(context, "a.b", "go", { handler: "h", requiredEnv: ["GONE"] });
    context.environmentKeys.unsetKey("GONE");
    const outcome = await runSkillTool(context.dependencies, {
      scope: SCOPE,
      reference: "a.b",
      toolName: dispatched("a.b", "go"),
      input: {},
    });
    expect(outcome.ok).toBe(false);
    if (outcome.ok) throw new Error("unreachable");
    expect(outcome.error.code).toBe("SKILLS_ENVIRONMENT_KEYS_MISSING");
    expect(context.sandbox.runs).toHaveLength(0);
  });

  it("REFUSES a skill that is not installed here, WITHOUT touching the sandbox", async () => {
    const seeded = await registerOfficialSkill(context.dependencies, {
      organization: ORG,
      parsed: parsed(skillSource({ id: "a.b", tools: [{ name: "go", handler: "h" }] })),
    });
    if (!seeded.ok) throw new Error(seeded.error.code);
    const outcome = await runSkillTool(context.dependencies, {
      scope: SCOPE,
      reference: "a.b",
      toolName: dispatched("a.b", "go"),
      input: {},
    });
    expect(outcome.ok).toBe(false);
    if (outcome.ok) throw new Error("unreachable");
    expect(outcome.error.code).toBe("SKILLS_SKILL_NOT_INSTALLED");
    expect(context.sandbox.runs).toHaveLength(0);
  });

  it("REFUSES when the binding is switched off", async () => {
    await seedBound(context, "a.b", "go", { handler: "h" });
    const binding = context.repository.allEnvironmentInstallations()[0];
    if (binding === undefined) throw new Error("unreachable");
    Object.assign(binding as { enabled: boolean }, { enabled: false });

    const outcome = await runSkillTool(context.dependencies, {
      scope: SCOPE,
      reference: "a.b",
      toolName: dispatched("a.b", "go"),
      input: {},
    });
    expect(outcome.ok).toBe(false);
    if (outcome.ok) throw new Error("unreachable");
    expect(outcome.error.code).toBe("SKILLS_SKILL_NOT_INSTALLED");
  });

  it("surfaces a sandbox failure rather than a result", async () => {
    await seedBound(context, "a.b", "go", { handler: "h" });
    context.sandbox.failNext("no capacity");
    const outcome = await runSkillTool(context.dependencies, {
      scope: SCOPE,
      reference: "a.b",
      toolName: dispatched("a.b", "go"),
      input: {},
    });
    expect(outcome.ok).toBe(false);
    if (outcome.ok) throw new Error("unreachable");
    expect(outcome.error.code).toBe("SKILLS_SANDBOX_UNAVAILABLE");
  });

  it("reports an unknown cost as null, not as zero", async () => {
    await seedBound(context, "a.b", "go", { handler: "h" });
    context.sandbox.put("h", "done");
    const outcome = await runSkillTool(context.dependencies, {
      scope: SCOPE,
      reference: "a.b",
      toolName: dispatched("a.b", "go"),
      input: {},
    });
    if (!outcome.ok) throw new Error(outcome.error.code);
    // A caller recording spend must be able to tell "free" from "nobody knows".
    expect(outcome.value.usage.costCents).toBeNull();
  });
});
