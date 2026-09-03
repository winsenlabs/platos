import { asIdentifier, organizationScope } from "@platos/kernel";
import { beforeEach, describe, expect, it } from "vitest";

import { parseSkillSource } from "../domain/index.js";
import { registerOfficialSkill, registerSkillFromSource } from "./register-skill.js";
import {
  buildSkillsTestContext,
  scopeFor,
  skillSource,
  type SkillsTestContext,
} from "./testing/index.js";

const ORG = organizationScope(asIdentifier("org-1"));

function parsed(source: string) {
  const result = parseSkillSource(source);
  if (!result.ok) throw new Error(result.error.code);
  return result.value;
}

describe("registerSkillFromSource", () => {
  let context: SkillsTestContext;

  beforeEach(() => {
    context = buildSkillsTestContext();
  });

  it("registers into the caller's organization and installs it there", async () => {
    const registered = await registerSkillFromSource(context.dependencies, {
      scope: scopeFor("org-1", "proj-1", "env-1"),
      source: skillSource({ id: "acme.thing" }),
    });
    if (!registered.ok) throw new Error(registered.error.code);
    expect(registered.value.installed).toBe(true);
    expect(context.repository.allProjectInstallations()).toHaveLength(1);
    expect(context.repository.allEnvironmentInstallations()).toHaveLength(1);
  });

  it("defaults an unlabelled upload to custom, not community", async () => {
    const registered = await registerSkillFromSource(context.dependencies, {
      scope: scopeFor("org-1", "proj-1", "env-1"),
      source: skillSource({ id: "acme.thing" }),
    });
    if (!registered.ok) throw new Error(registered.error.code);
    expect(registered.value.entry.origin).toBe("custom");
    expect(registered.value.entry.isOfficial).toBe(false);
  });

  it("REFUSES to let a fetched manifest promote itself to official", async () => {
    const registered = await registerSkillFromSource(context.dependencies, {
      scope: scopeFor("org-1", "proj-1", "env-1"),
      // The document declares itself official; the tenant path overrides it.
      source: ["---", "id: evil.skill", "description: d", "origin: official", "---", "", "b"].join("\n"),
      origin: "community",
    });
    if (!registered.ok) throw new Error(registered.error.code);
    expect(registered.value.entry.isOfficial).toBe(false);
    expect(registered.value.entry.origin).toBe("community");
  });

  it("UPDATES one row rather than adding a second when the identity repeats", async () => {
    const scope = scopeFor("org-1", "proj-1", "env-1");
    const first = await registerSkillFromSource(context.dependencies, {
      scope,
      source: skillSource({ id: "acme.thing", name: "First", version: "1.0.0" }),
    });
    if (!first.ok) throw new Error(first.error.code);
    context.clock.advanceSeconds(60);
    const second = await registerSkillFromSource(context.dependencies, {
      scope,
      source: skillSource({ id: "acme.thing", name: "Second", version: "1.0.0" }),
    });
    if (!second.ok) throw new Error(second.error.code);

    expect(context.repository.allSkills()).toHaveLength(1);
    expect(second.value.entry.skillId).toBe(first.value.entry.skillId);
    expect(second.value.entry.name).toBe("Second");
    // A re-registration is the same row: creation does not move, so an old
    // skill does not look new after every edit.
    expect(second.value.entry.createdAt).toEqual(first.value.entry.createdAt);
    expect(second.value.entry.updatedAt.getTime()).toBeGreaterThan(first.value.entry.updatedAt.getTime());
  });

  it("keeps two VERSIONS of one slug as two rows", async () => {
    const scope = scopeFor("org-1", "proj-1", "env-1");
    await registerSkillFromSource(context.dependencies, {
      scope,
      source: skillSource({ id: "acme.thing", version: "1.0.0" }),
    });
    await registerSkillFromSource(context.dependencies, {
      scope,
      source: skillSource({ id: "acme.thing", version: "2.0.0" }),
    });
    expect(context.repository.allSkills()).toHaveLength(2);
  });

  it("surfaces a parse failure unchanged instead of registering anything", async () => {
    const registered = await registerSkillFromSource(context.dependencies, {
      scope: scopeFor("org-1", "proj-1", "env-1"),
      source: "no frontmatter here",
    });
    expect(registered.ok).toBe(false);
    if (registered.ok) throw new Error("unreachable");
    expect(registered.error.code).toBe("SKILLS_MANIFEST_FRONTMATTER_MISSING");
    expect(context.repository.allSkills()).toHaveLength(0);
  });

  it("records provenance when one is supplied", async () => {
    const registered = await registerSkillFromSource(context.dependencies, {
      scope: scopeFor("org-1", "proj-1", "env-1"),
      source: skillSource({ id: "acme.thing" }),
      importedFrom: "https://example.test/s.md",
    });
    if (!registered.ok) throw new Error(registered.error.code);
    expect(registered.value.entry.manifest.importedFrom).toBe("https://example.test/s.md");
  });

  it("reports the store being unavailable rather than pretending it registered", async () => {
    context.repository.failNext("connection reset");
    const registered = await registerSkillFromSource(context.dependencies, {
      scope: scopeFor("org-1", "proj-1", "env-1"),
      source: skillSource({ id: "acme.thing" }),
    });
    expect(registered.ok).toBe(false);
    if (registered.ok) throw new Error("unreachable");
    expect(registered.error.code).toBe("SKILLS_REPOSITORY_UNAVAILABLE");
  });
});

describe("registerOfficialSkill", () => {
  let context: SkillsTestContext;

  beforeEach(() => {
    context = buildSkillsTestContext();
  });

  it("registers an organization-owned row and creates NO install", async () => {
    const registered = await registerOfficialSkill(context.dependencies, {
      organization: ORG,
      parsed: parsed(skillSource({ id: "platos.web_search" })),
    });
    if (!registered.ok) throw new Error(registered.error.code);
    expect(registered.value.isOfficial).toBe(true);
    expect(registered.value.origin).toBe("official");
    // Official rows are visible without an install; creating one would be rows
    // that change nothing, per environment, forever.
    expect(context.repository.allProjectInstallations()).toHaveLength(0);
    expect(context.repository.allEnvironmentInstallations()).toHaveLength(0);
  });

  it("is idempotent — seeding twice leaves one row", async () => {
    const command = { organization: ORG, parsed: parsed(skillSource({ id: "platos.web_search" })) };
    await registerOfficialSkill(context.dependencies, command);
    await registerOfficialSkill(context.dependencies, command);
    expect(context.repository.allSkills()).toHaveLength(1);
  });

  it("makes the row visible in every environment of that organization", async () => {
    await registerOfficialSkill(context.dependencies, {
      organization: ORG,
      parsed: parsed(skillSource({ id: "platos.web_search" })),
    });
    const listed = await context.repository.listVisibleSkills(scopeFor("org-1", "proj-9", "env-9"));
    if (!listed.ok) throw new Error(listed.error.code);
    expect(listed.value).toHaveLength(1);
  });

  it("does NOT make it visible in another organization", async () => {
    await registerOfficialSkill(context.dependencies, {
      organization: ORG,
      parsed: parsed(skillSource({ id: "platos.web_search" })),
    });
    const listed = await context.repository.listVisibleSkills(scopeFor("org-2", "proj-1", "env-1"));
    if (!listed.ok) throw new Error(listed.error.code);
    expect(listed.value).toHaveLength(0);
  });
});
