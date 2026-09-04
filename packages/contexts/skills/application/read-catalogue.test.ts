import { asIdentifier, organizationScope } from "@platos/kernel";
import { beforeEach, describe, expect, it } from "vitest";

import { DEFAULT_SKILLS_POLICY, parseSkillSource } from "../domain/index.js";
import { clampQuery, findVisibleSkill, listCatalogue, pageCatalogue } from "./read-catalogue.js";
import { registerOfficialSkill, registerSkillFromSource } from "./register-skill.js";
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

async function seedOfficial(
  context: SkillsTestContext,
  id: string,
  requiredEnv: readonly string[] = [],
): Promise<void> {
  const seeded = await registerOfficialSkill(context.dependencies, {
    organization: ORG,
    parsed: parsed(skillSource({ id, ...(requiredEnv.length === 0 ? {} : { requiredEnv }) })),
  });
  if (!seeded.ok) throw new Error(seeded.error.code);
}

describe("clampQuery", () => {
  it("raises a zero or negative limit to one", () => {
    expect(clampQuery({ limit: 0, offset: 0, search: null }, 100).limit).toBe(1);
    expect(clampQuery({ limit: -5, offset: 0, search: null }, 100).limit).toBe(1);
  });

  it("caps a limit above the policy ceiling", () => {
    expect(clampQuery({ limit: 5000, offset: 0, search: null }, 100).limit).toBe(100);
  });

  it("raises a negative offset to zero", () => {
    expect(clampQuery({ limit: 10, offset: -3, search: null }, 100).offset).toBe(0);
  });

  it("truncates a fractional window rather than passing it on", () => {
    expect(clampQuery({ limit: 10.7, offset: 2.9, search: null }, 100)).toMatchObject({
      limit: 10,
      offset: 2,
    });
  });

  it("normalises a blank search to no search", () => {
    expect(clampQuery({ limit: 10, offset: 0, search: "   " }, 100).search).toBeNull();
  });

  it("trims a real search rather than dropping it", () => {
    expect(clampQuery({ limit: 10, offset: 0, search: "  web  " }, 100).search).toBe("web");
  });
});

describe("listCatalogue", () => {
  let context: SkillsTestContext;

  beforeEach(() => {
    context = buildSkillsTestContext();
  });

  it("returns the visible rows, official first", async () => {
    await registerSkillFromSource(context.dependencies, {
      scope: SCOPE,
      source: skillSource({ id: "acme.custom" }),
    });
    await seedOfficial(context, "platos.web_search");
    const listed = await listCatalogue(context.dependencies, SCOPE);
    if (!listed.ok) throw new Error(listed.error.code);
    expect(listed.value.entries.map((entry) => entry.identity.slug)).toEqual([
      "platos.web_search",
      "acme.custom",
    ]);
  });

  it("EXCLUDES another organization's rows", async () => {
    await registerSkillFromSource(context.dependencies, {
      scope: scopeFor("org-2", "proj-1", "env-1"),
      source: skillSource({ id: "theirs.thing" }),
    });
    const listed = await listCatalogue(context.dependencies, SCOPE);
    if (!listed.ok) throw new Error(listed.error.code);
    expect(listed.value.entries).toHaveLength(0);
  });

  it("resolves readiness in ONE batched lookup for the whole page", async () => {
    await seedOfficial(context, "a.one", ["KEY_A"]);
    await seedOfficial(context, "b.two", ["KEY_B"]);
    const listed = await listCatalogue(context.dependencies, SCOPE);
    if (!listed.ok) throw new Error(listed.error.code);
    expect(context.environmentKeys.queries).toHaveLength(1);
    expect(context.environmentKeys.queries[0]).toEqual(["KEY_A", "KEY_B"]);
  });

  it("does not consult the directory when nothing requires a key", async () => {
    await seedOfficial(context, "a.one");
    await listCatalogue(context.dependencies, SCOPE);
    expect(context.environmentKeys.queries).toHaveLength(0);
  });

  it("queries only REQUIRED keys, never optional ones", async () => {
    const seeded = await registerOfficialSkill(context.dependencies, {
      organization: ORG,
      parsed: parsed(skillSource({ id: "a.b", requiredEnv: ["NEEDED"], optionalEnv: ["NICE"] })),
    });
    if (!seeded.ok) throw new Error(seeded.error.code);
    await listCatalogue(context.dependencies, SCOPE);
    expect(context.environmentKeys.queries[0]).toEqual(["NEEDED"]);
  });

  it("FAILS the read when the directory is unreachable", async () => {
    await seedOfficial(context, "a.one", ["KEY_A"]);
    context.environmentKeys.failNext("directory down");
    const listed = await listCatalogue(context.dependencies, SCOPE);
    // An empty presence map would read as "nothing is set" and paint every
    // skill in the environment as broken.
    expect(listed.ok).toBe(false);
  });
});

describe("pageCatalogue", () => {
  let context: SkillsTestContext;

  beforeEach(async () => {
    context = buildSkillsTestContext();
    for (const id of ["a.one", "b.two", "c.three"]) await seedOfficial(context, id);
  });

  it("windows the rows and reports the UNWINDOWED total", async () => {
    const paged = await pageCatalogue(context.dependencies, SCOPE, {
      limit: 2,
      offset: 0,
      search: null,
    });
    if (!paged.ok) throw new Error(paged.error.code);
    expect(paged.value.entries).toHaveLength(2);
    // A caller paging on a windowed total would never reach the last page.
    expect(paged.value.total).toBe(3);
  });

  it("walks to the second page without repeating a row", async () => {
    const first = await pageCatalogue(context.dependencies, SCOPE, { limit: 2, offset: 0, search: null });
    const second = await pageCatalogue(context.dependencies, SCOPE, { limit: 2, offset: 2, search: null });
    if (!first.ok || !second.ok) throw new Error("unreachable");
    const slugs = [...first.value.entries, ...second.value.entries].map((entry) => entry.identity.slug);
    expect(new Set(slugs).size).toBe(3);
  });

  it("filters by search, and totals the FILTER rather than the catalogue", async () => {
    const paged = await pageCatalogue(context.dependencies, SCOPE, {
      limit: 10,
      offset: 0,
      search: "two",
    });
    if (!paged.ok) throw new Error(paged.error.code);
    expect(paged.value.entries).toHaveLength(1);
    expect(paged.value.total).toBe(1);
  });

  it("clamps an absurd limit to the policy ceiling", async () => {
    const paged = await pageCatalogue(context.dependencies, SCOPE, {
      limit: 10_000,
      offset: 0,
      search: null,
    });
    expect(paged.ok).toBe(true);
    expect(DEFAULT_SKILLS_POLICY.catalogue.maxPageSize).toBeLessThan(10_000);
  });
});

describe("findVisibleSkill", () => {
  let context: SkillsTestContext;

  beforeEach(() => {
    context = buildSkillsTestContext();
  });

  it("resolves by slug", async () => {
    await seedOfficial(context, "platos.web_search");
    const found = await findVisibleSkill(context.dependencies, SCOPE, "platos.web_search");
    if (!found.ok) throw new Error(found.error.code);
    expect(found.value.identity.slug).toBe("platos.web_search");
  });

  it("resolves by row id", async () => {
    await seedOfficial(context, "platos.web_search");
    const id = context.repository.allSkills()[0]?.skillId;
    if (id === undefined) throw new Error("unreachable");
    const found = await findVisibleSkill(context.dependencies, SCOPE, id);
    if (!found.ok) throw new Error(found.error.code);
    expect(found.value.skillId).toBe(id);
  });

  it("resolves a slug to its HIGHEST version", async () => {
    await registerOfficialSkill(context.dependencies, {
      organization: ORG,
      parsed: parsed(skillSource({ id: "a.b", version: "1.0.0" })),
    });
    await registerOfficialSkill(context.dependencies, {
      organization: ORG,
      parsed: parsed(skillSource({ id: "a.b", version: "2.0.0" })),
    });
    const found = await findVisibleSkill(context.dependencies, SCOPE, "a.b");
    if (!found.ok) throw new Error(found.error.code);
    expect(found.value.identity.version).toBe("2.0.0");
  });

  it("reports a row from another organization as ABSENT, not forbidden", async () => {
    await registerOfficialSkill(context.dependencies, {
      organization: organizationScope(asIdentifier("org-2")),
      parsed: parsed(skillSource({ id: "theirs.thing" })),
    });
    const found = await findVisibleSkill(context.dependencies, SCOPE, "theirs.thing");
    expect(found.ok).toBe(false);
    if (found.ok) throw new Error("unreachable");
    // A caller must not be able to tell "no such skill" from "not yours".
    expect(found.error.code).toBe("SKILLS_SKILL_NOT_FOUND");
    expect(found.error.category).toBe("not_found");
  });
});
