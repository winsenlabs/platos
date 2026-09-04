import { asIdentifier, organizationScope } from "@platos/kernel";
import { beforeEach, describe, expect, it } from "vitest";

import type { SkillSlug } from "../domain/index.js";
import { seedOfficialSkills, seedOfficialSkillsIfAbsent } from "./seed-official-skills.js";
import {
  buildSkillsTestContext,
  scopeFor,
  skillSource,
  type SkillsTestContext,
} from "./testing/index.js";

const ORG = organizationScope(asIdentifier("org-1"));

function source(id: string, overrides: { body?: string } = {}) {
  return {
    declaredId: asIdentifier<SkillSlug>(id),
    source: skillSource({ id, ...(overrides.body === undefined ? {} : { body: overrides.body }) }),
  };
}

describe("seedOfficialSkills", () => {
  let context: SkillsTestContext;

  beforeEach(() => {
    context = buildSkillsTestContext();
  });

  it("seeds every bundled source as an official row", async () => {
    const report = await seedOfficialSkills(context.dependencies, {
      organization: ORG,
      sources: [source("platos.web_search"), source("platos.code_execution")],
    });
    if (!report.ok) throw new Error(report.error.code);
    expect(report.value.seeded).toHaveLength(2);
    expect(report.value.failed).toHaveLength(0);
    expect(context.repository.allSkills().every((row) => row.isOfficial)).toBe(true);
  });

  it("creates NO install rows", async () => {
    await seedOfficialSkills(context.dependencies, {
      organization: ORG,
      sources: [source("platos.web_search")],
    });
    expect(context.repository.allProjectInstallations()).toHaveLength(0);
    expect(context.repository.allEnvironmentInstallations()).toHaveLength(0);
  });

  it("is idempotent — seeding twice leaves the same rows", async () => {
    const command = { organization: ORG, sources: [source("platos.web_search")] };
    await seedOfficialSkills(context.dependencies, command);
    await seedOfficialSkills(context.dependencies, command);
    expect(context.repository.allSkills()).toHaveLength(1);
  });

  it("overwrites the prose on a re-seed, so a shipped fix lands", async () => {
    await seedOfficialSkills(context.dependencies, {
      organization: ORG,
      sources: [source("platos.web_search", { body: "Old guidance." })],
    });
    await seedOfficialSkills(context.dependencies, {
      organization: ORG,
      sources: [source("platos.web_search", { body: "New guidance." })],
    });
    expect(context.repository.allSkills()[0]?.promptBlock).toBe("New guidance.");
  });

  it("does NOT let one malformed source cost the others", async () => {
    const report = await seedOfficialSkills(context.dependencies, {
      organization: ORG,
      sources: [
        source("platos.web_search"),
        { declaredId: asIdentifier<SkillSlug>("platos.broken"), source: "no frontmatter" },
        source("platos.code_execution"),
      ],
    });
    if (!report.ok) throw new Error(report.error.code);
    // A defect in one shipped skill must not take down every skill in the
    // product.
    expect(report.value.seeded).toHaveLength(2);
    expect(report.value.failed).toHaveLength(1);
    expect(report.value.failed[0]?.declaredId).toBe("platos.broken");
    expect(report.value.failed[0]?.code).toBe("SKILLS_MANIFEST_FRONTMATTER_MISSING");
  });

  it("succeeds as a pass even when every source failed — the report carries the truth", async () => {
    const report = await seedOfficialSkills(context.dependencies, {
      organization: ORG,
      sources: [{ declaredId: asIdentifier<SkillSlug>("a.b"), source: "broken" }],
    });
    expect(report.ok).toBe(true);
    if (!report.ok) throw new Error("unreachable");
    expect(report.value.seeded).toHaveLength(0);
    expect(report.value.failed).toHaveLength(1);
  });

  it("prefers the MANIFEST'S id over the declared one, and reports the disagreement", async () => {
    const report = await seedOfficialSkills(context.dependencies, {
      organization: ORG,
      sources: [
        { declaredId: asIdentifier<SkillSlug>("platos.claimed"), source: skillSource({ id: "platos.actual" }) },
      ],
    });
    if (!report.ok) throw new Error(report.error.code);
    // The row is keyed by what is IN it; preferring the other would key it by
    // something the row does not contain.
    expect(report.value.seeded[0]?.entry.identity.slug).toBe("platos.actual");
    expect(report.value.seeded[0]?.declaredIdMismatch).toBe("platos.actual");
  });

  it("reports no mismatch when the two agree", async () => {
    const report = await seedOfficialSkills(context.dependencies, {
      organization: ORG,
      sources: [source("platos.web_search")],
    });
    if (!report.ok) throw new Error(report.error.code);
    expect(report.value.seeded[0]?.declaredIdMismatch).toBeNull();
  });
});

describe("seedOfficialSkillsIfAbsent", () => {
  let context: SkillsTestContext;

  beforeEach(() => {
    context = buildSkillsTestContext();
  });

  it("seeds a fresh organization", async () => {
    const report = await seedOfficialSkillsIfAbsent(context.dependencies, {
      organization: ORG,
      sources: [source("platos.web_search")],
    });
    if (!report.ok) throw new Error(report.error.code);
    expect(report.value?.seeded).toHaveLength(1);
  });

  it("SKIPS an organization that already holds official rows", async () => {
    await seedOfficialSkills(context.dependencies, {
      organization: ORG,
      sources: [source("platos.web_search", { body: "Original." })],
    });
    const report = await seedOfficialSkillsIfAbsent(context.dependencies, {
      organization: ORG,
      sources: [source("platos.web_search", { body: "Would overwrite." })],
    });
    if (!report.ok) throw new Error(report.error.code);
    // A read must never re-write rows that are already there.
    expect(report.value).toBeNull();
    expect(context.repository.allSkills()[0]?.promptBlock).toBe("Original.");
  });

  it("does not treat ANOTHER organization's official rows as this one's", async () => {
    await seedOfficialSkills(context.dependencies, {
      organization: organizationScope(asIdentifier("org-2")),
      sources: [source("platos.web_search")],
    });
    const report = await seedOfficialSkillsIfAbsent(context.dependencies, {
      organization: ORG,
      sources: [source("platos.web_search")],
    });
    if (!report.ok) throw new Error(report.error.code);
    expect(report.value?.seeded).toHaveLength(1);
  });

  it("makes the seeded catalogue visible to a fresh environment", async () => {
    await seedOfficialSkillsIfAbsent(context.dependencies, {
      organization: ORG,
      sources: [source("platos.web_search")],
    });
    const listed = await context.repository.listVisibleSkills(scopeFor("org-1", "proj-new", "env-new"));
    if (!listed.ok) throw new Error(listed.error.code);
    expect(listed.value).toHaveLength(1);
  });
});
