import { asIdentifier } from "@platos/kernel";
import { describe, expect, it } from "vitest";

import { deriveSkillCategory, UNCATEGORIZED } from "./category.js";
import type { SkillSlug } from "./identifiers.js";
import type { SkillManifest } from "./manifest.js";

function manifest(category: string | null): SkillManifest {
  return {
    id: asIdentifier<SkillSlug>("a.b"),
    name: "A B",
    description: "d",
    version: asIdentifier("1"),
    author: null,
    origin: null,
    spec_version: null,
    required_env: [],
    optional_env: [],
    provides_tools: [],
    tags: [],
    importedFrom: null,
    category,
  };
}

const slug = (value: string): SkillSlug => asIdentifier<SkillSlug>(value);

describe("deriveSkillCategory", () => {
  it("uses a declared category verbatim", () => {
    expect(deriveSkillCategory(slug("platos.web_search"), manifest("research"))).toBe("research");
  });

  it("trims a declared category", () => {
    expect(deriveSkillCategory(slug("a.b"), manifest("  data  "))).toBe("data");
  });

  it("ignores a declared category that is only whitespace", () => {
    expect(deriveSkillCategory(slug("platos.web_search"), manifest("   "))).toBe("web");
  });

  it("derives the head of the LAST dotted segment", () => {
    // Not the namespace: grouping by it would put every Platos skill in one
    // bucket, which is the author, not the subject.
    expect(deriveSkillCategory(slug("platos.web_search"), manifest(null))).toBe("web");
  });

  it("splits on a hyphen as well as an underscore", () => {
    expect(deriveSkillCategory(slug("acme.csv-ops"), manifest(null))).toBe("csv");
  });

  it("uses the whole segment when it carries no separator", () => {
    expect(deriveSkillCategory(slug("platos.rag"), manifest(null))).toBe("rag");
  });

  it("clusters siblings of one family together", () => {
    expect(deriveSkillCategory(slug("platos.web_search"), manifest(null))).toBe(
      deriveSkillCategory(slug("platos.web_fetch"), manifest(null)),
    );
  });

  it("falls back to the fixed literal when nothing can be derived", () => {
    expect(deriveSkillCategory(slug(""), manifest(null))).toBe(UNCATEGORIZED);
  });

  it("falls back for a slug that is only a separator", () => {
    expect(deriveSkillCategory(slug("a._"), manifest(null))).toBe(UNCATEGORIZED);
  });

  it("tolerates an absent manifest and still derives from the slug", () => {
    expect(deriveSkillCategory(slug("acme.csv-ops"), null)).toBe("csv");
  });
});
