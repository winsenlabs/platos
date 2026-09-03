import { asIdentifier, organizationScope } from "@platos/kernel";
import { beforeEach, describe, expect, it } from "vitest";

import {
  DEFAULT_SKILLS_POLICY,
  parseSkillSource,
  type EnvironmentSkillId,
  type SkillsPolicy,
} from "../domain/index.js";
import { bindSkill } from "./bind-skill.js";
import { composeRuntimeSkills } from "./compose-runtime.js";
import { registerOfficialSkill } from "./register-skill.js";
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

interface SeedOptions {
  readonly requiredEnv?: readonly string[];
  readonly tools?: readonly { name: string; handler?: string }[];
  readonly body?: string;
}

/** Seed an official skill and bind it, returning the binding id. */
async function seedAndBind(
  context: SkillsTestContext,
  id: string,
  options: SeedOptions = {},
): Promise<EnvironmentSkillId> {
  const seeded = await registerOfficialSkill(context.dependencies, {
    organization: ORG,
    parsed: parsed(
      skillSource({
        id,
        ...(options.requiredEnv === undefined ? {} : { requiredEnv: options.requiredEnv }),
        ...(options.tools === undefined ? {} : { tools: [...options.tools] }),
        ...(options.body === undefined ? {} : { body: options.body }),
      }),
    ),
  });
  if (!seeded.ok) throw new Error(seeded.error.code);
  for (const key of options.requiredEnv ?? []) context.environmentKeys.setKey(key);
  const bound = await bindSkill(context.dependencies, { scope: SCOPE, reference: id });
  if (!bound.ok) throw new Error(bound.error.code);
  return bound.value.installation.environment.environmentSkillId;
}

describe("composeRuntimeSkills", () => {
  let context: SkillsTestContext;

  beforeEach(() => {
    context = buildSkillsTestContext();
  });

  it("returns an empty payload when the loadout is empty", async () => {
    const composed = await composeRuntimeSkills(context.dependencies, {
      scope: SCOPE,
      environmentSkillIds: [],
    });
    if (!composed.ok) throw new Error(composed.error.code);
    expect(composed.value.promptBlock).toBe("");
    expect(composed.value.tools).toEqual([]);
    expect(composed.value.systemPrompt).toBe("");
  });

  it("merges the bound skills into one block with namespaced tools", async () => {
    const first = await seedAndBind(context, "platos.web_search", { tools: [{ name: "search" }] });
    const second = await seedAndBind(context, "acme.csv-ops", { tools: [{ name: "read" }] });
    const composed = await composeRuntimeSkills(context.dependencies, {
      scope: SCOPE,
      environmentSkillIds: [first, second],
    });
    if (!composed.ok) throw new Error(composed.error.code);
    expect(composed.value.admitted).toHaveLength(2);
    expect(composed.value.tools.map((tool) => tool.name)).toEqual([
      "platos_web_search__search",
      "acme_csv_ops__read",
    ]);
  });

  it("splices the merged block onto a base prompt", async () => {
    const only = await seedAndBind(context, "a.b", { body: "Skill prose." });
    const composed = await composeRuntimeSkills(context.dependencies, {
      scope: SCOPE,
      environmentSkillIds: [only],
      basePrompt: "You are helpful.",
    });
    if (!composed.ok) throw new Error(composed.error.code);
    expect(composed.value.systemPrompt.startsWith("You are helpful.\n\n---\n\n## Enabled Skills")).toBe(true);
  });

  it("preserves the LOADOUT order, not the store's order", async () => {
    const first = await seedAndBind(context, "a.first");
    const second = await seedAndBind(context, "z.second");
    const composed = await composeRuntimeSkills(context.dependencies, {
      scope: SCOPE,
      environmentSkillIds: [second, first],
    });
    if (!composed.ok) throw new Error(composed.error.code);
    expect(composed.value.admitted.map((skill) => skill.slug)).toEqual(["z.second", "a.first"]);
  });

  it("DROPS a binding the scope cannot resolve, rather than failing the turn", async () => {
    const real = await seedAndBind(context, "a.b");
    const composed = await composeRuntimeSkills(context.dependencies, {
      scope: SCOPE,
      environmentSkillIds: [real, asIdentifier<EnvironmentSkillId>("es-gone")],
    });
    if (!composed.ok) throw new Error(composed.error.code);
    expect(composed.value.admitted).toHaveLength(1);
    expect(composed.value.skipped).toEqual([{ environmentSkillId: "es-gone", reason: "unresolved" }]);
  });

  it("DROPS a binding whose environment half is switched off", async () => {
    const only = await seedAndBind(context, "a.b");
    const binding = context.repository.allEnvironmentInstallations()[0];
    if (binding === undefined) throw new Error("unreachable");
    // Reach in and disable the environment half directly: there is no
    // tenant-facing disable in this context, but the runtime must honour one.
    Object.assign(binding as { enabled: boolean }, { enabled: false });

    const composed = await composeRuntimeSkills(context.dependencies, {
      scope: SCOPE,
      environmentSkillIds: [only],
    });
    if (!composed.ok) throw new Error(composed.error.code);
    expect(composed.value.admitted).toHaveLength(0);
    expect(composed.value.skipped[0]?.reason).toBe("disabled");
  });

  it("DROPS a binding whose PROJECT half is switched off", async () => {
    const only = await seedAndBind(context, "a.b");
    const adoption = context.repository.allProjectInstallations()[0];
    if (adoption === undefined) throw new Error("unreachable");
    Object.assign(adoption as { enabled: boolean }, { enabled: false });

    const composed = await composeRuntimeSkills(context.dependencies, {
      scope: SCOPE,
      environmentSkillIds: [only],
    });
    if (!composed.ok) throw new Error(composed.error.code);
    expect(composed.value.skipped[0]?.reason).toBe("disabled");
  });

  it("DROPS a skill whose key was unset AFTER it was bound — it does not fail", async () => {
    // This is the whole reason readiness is asked twice. `bindSkill` REFUSES an
    // unready skill; the runtime silently stops offering one, so a key removed
    // later does not break every conversation in the environment.
    const only = await seedAndBind(context, "platos.web_search", { requiredEnv: ["TAVILY_API_KEY"] });
    context.environmentKeys.unsetKey("TAVILY_API_KEY");

    const composed = await composeRuntimeSkills(context.dependencies, {
      scope: SCOPE,
      environmentSkillIds: [only],
    });
    expect(composed.ok).toBe(true);
    if (!composed.ok) throw new Error("unreachable");
    expect(composed.value.admitted).toHaveLength(0);
    expect(composed.value.skipped[0]?.reason).toBe("environment-not-ready");
    expect(composed.value.promptBlock).toBe("");
  });

  it("keeps a ready skill alongside one that is no longer ready", async () => {
    const ready = await seedAndBind(context, "a.ready");
    const broken = await seedAndBind(context, "b.broken", { requiredEnv: ["GONE"] });
    context.environmentKeys.unsetKey("GONE");

    const composed = await composeRuntimeSkills(context.dependencies, {
      scope: SCOPE,
      environmentSkillIds: [ready, broken],
    });
    if (!composed.ok) throw new Error(composed.error.code);
    expect(composed.value.admitted.map((skill) => skill.slug)).toEqual(["a.ready"]);
  });

  it("asks the directory ONCE for a whole loadout, not once per skill", async () => {
    const first = await seedAndBind(context, "a.b", { requiredEnv: ["ONE"] });
    const second = await seedAndBind(context, "c.d", { requiredEnv: ["TWO"] });
    const before = context.environmentKeys.queries.length;

    await composeRuntimeSkills(context.dependencies, {
      scope: SCOPE,
      environmentSkillIds: [first, second],
    });
    expect(context.environmentKeys.queries.length - before).toBe(1);
  });

  it("does not ask the directory at all when nothing requires a key", async () => {
    const only = await seedAndBind(context, "a.b");
    const before = context.environmentKeys.queries.length;
    await composeRuntimeSkills(context.dependencies, { scope: SCOPE, environmentSkillIds: [only] });
    expect(context.environmentKeys.queries.length).toBe(before);
  });

  it("FAILS the compose when the directory is unreachable", async () => {
    const only = await seedAndBind(context, "a.b", { requiredEnv: ["K"] });
    context.environmentKeys.failNext("directory unreachable");
    const composed = await composeRuntimeSkills(context.dependencies, {
      scope: SCOPE,
      environmentSkillIds: [only],
    });
    // An outage must not read as "every skill is unready", which would silently
    // strip the whole loadout from the turn.
    expect(composed.ok).toBe(false);
  });

  it("truncates under a tight budget and reports what it omitted", async () => {
    const tight: SkillsPolicy = {
      ...DEFAULT_SKILLS_POLICY,
      runtime: { maxPromptChars: 60 },
    };
    const tightContext = buildSkillsTestContext(tight);
    const first = await seedAndBindIn(tightContext, "a.b", "x".repeat(20));
    const second = await seedAndBindIn(tightContext, "c.d", "y".repeat(20));

    const composed = await composeRuntimeSkills(tightContext.dependencies, {
      scope: SCOPE,
      environmentSkillIds: [first, second],
    });
    if (!composed.ok) throw new Error(composed.error.code);
    expect(composed.value.truncated).toBe(true);
    expect(composed.value.admitted).toHaveLength(1);
    expect(composed.value.omitted.map((skill) => skill.slug)).toEqual(["c.d"]);
  });
});

/** Seed and bind inside a specific context, for the tight-budget case. */
async function seedAndBindIn(
  context: SkillsTestContext,
  id: string,
  body: string,
): Promise<EnvironmentSkillId> {
  const seeded = await registerOfficialSkill(context.dependencies, {
    organization: ORG,
    parsed: parsed(skillSource({ id, body })),
  });
  if (!seeded.ok) throw new Error(seeded.error.code);
  const bound = await bindSkill(context.dependencies, { scope: SCOPE, reference: id });
  if (!bound.ok) throw new Error(bound.error.code);
  return bound.value.installation.environment.environmentSkillId;
}
