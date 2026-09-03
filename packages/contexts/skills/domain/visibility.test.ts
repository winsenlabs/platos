import { asIdentifier, environmentScope, organizationScope } from "@platos/kernel";
import { describe, expect, it } from "vitest";

import { skillIdentity, type CatalogueEntry } from "./catalogue.js";
import type { SkillId } from "./identifiers.js";
import { EMPTY_SKILL_CONFIG, type Installation } from "./installation.js";
import type { SkillManifest } from "./manifest.js";
import { belongsToOrganization, catalogueScope, isVisible, organizationOf } from "./visibility.js";

const MANIFEST: SkillManifest = {
  id: asIdentifier("a.b"),
  name: "A B",
  description: "d",
  version: asIdentifier("1.0.0"),
  author: null,
  origin: null,
  spec_version: null,
  required_env: [],
  optional_env: [],
  provides_tools: [],
  tags: [],
  importedFrom: null,
  category: null,
};

function scopeIn(organizationId: string, projectId = "proj-1", environmentId = "env-1") {
  return catalogueScope(
    environmentScope(asIdentifier(organizationId), asIdentifier(projectId), asIdentifier(environmentId)),
  );
}

function entry(organizationId: string, isOfficial = false): CatalogueEntry {
  return {
    skillId: asIdentifier<SkillId>("skill-1"),
    identity: skillIdentity(organizationScope(asIdentifier(organizationId)), MANIFEST.id, MANIFEST.version),
    name: MANIFEST.name,
    description: MANIFEST.description,
    author: null,
    origin: isOfficial ? "official" : "custom",
    isOfficial,
    tags: [],
    source: "s",
    manifest: MANIFEST,
    promptBlock: "p",
    providesTools: [],
    requiredEnvironmentKeys: [],
    optionalEnvironmentKeys: [],
    createdAt: new Date(0),
    updatedAt: new Date(0),
  };
}

function installation(enabledProject = true, enabledEnvironment = true): Installation {
  return {
    project: {
      projectSkillId: asIdentifier("ps-1"),
      scope: { level: "project", organizationId: asIdentifier("org-1"), projectId: asIdentifier("proj-1") },
      skillId: asIdentifier<SkillId>("skill-1"),
      enabled: enabledProject,
      createdAt: new Date(0),
      updatedAt: new Date(0),
    },
    environment: {
      environmentSkillId: asIdentifier("es-1"),
      scope: environmentScope(asIdentifier("org-1"), asIdentifier("proj-1"), asIdentifier("env-1")),
      projectSkillId: asIdentifier("ps-1"),
      enabled: enabledEnvironment,
      config: EMPTY_SKILL_CONFIG,
      createdAt: new Date(0),
      updatedAt: new Date(0),
    },
  };
}

describe("organizationOf", () => {
  it("widens an environment scope to its organization", () => {
    expect(organizationOf(scopeIn("org-1"))).toEqual(organizationScope(asIdentifier("org-1")));
  });
});

describe("belongsToOrganization", () => {
  it("claims a row from the reading scope's own organization", () => {
    expect(belongsToOrganization(entry("org-1"), scopeIn("org-1"))).toBe(true);
  });

  it("REFUSES a row from another organization", () => {
    expect(belongsToOrganization(entry("org-2"), scopeIn("org-1"))).toBe(false);
  });
});

describe("isVisible", () => {
  it("shows an official row with no install at all", () => {
    expect(isVisible(entry("org-1", true), scopeIn("org-1"), null)).toBe(true);
  });

  it("HIDES an official row belonging to another organization", () => {
    // "Official" means catalogue-owned, not global. The organization match is a
    // conjunct, not a fallback.
    expect(isVisible(entry("org-2", true), scopeIn("org-1"), null)).toBe(false);
  });

  it("HIDES a non-official row with no install here", () => {
    expect(isVisible(entry("org-1"), scopeIn("org-1"), null)).toBe(false);
  });

  it("shows a non-official row once it is installed here", () => {
    expect(isVisible(entry("org-1"), scopeIn("org-1"), installation())).toBe(true);
  });

  it("still shows a row whose install is DISABLED", () => {
    // Visible and usable are different questions. A disabled skill appears in
    // the library switched off, which is what lets an operator switch it on.
    expect(isVisible(entry("org-1"), scopeIn("org-1"), installation(false, false))).toBe(true);
  });

  it("HIDES another organization's row even when an install is somehow present", () => {
    expect(isVisible(entry("org-2"), scopeIn("org-1"), installation())).toBe(false);
  });
});
