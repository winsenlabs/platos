import { asIdentifier, organizationScope } from "@platos/kernel";
import { describe, expect, it } from "vitest";

import {
  applyPatch,
  compareCatalogueEntries,
  draftFrom,
  matchesSearch,
  patchIsEmpty,
  resolveOrigin,
  revisionFrom,
  sameSkillIdentity,
  skillIdentity,
  skillIdentityPath,
  type CatalogueEntry,
} from "./catalogue.js";
import type { SkillId, SkillSlug, SkillVersion } from "./identifiers.js";
import type { SkillManifest } from "./manifest.js";

const ORG = organizationScope(asIdentifier("org-1"));
const OTHER_ORG = organizationScope(asIdentifier("org-2"));

function manifest(overrides: Partial<SkillManifest> = {}): SkillManifest {
  return {
    id: asIdentifier<SkillSlug>("a.b"),
    name: "A B",
    description: "d",
    version: asIdentifier<SkillVersion>("1.0.0"),
    author: null,
    origin: null,
    spec_version: null,
    required_env: [],
    optional_env: [],
    provides_tools: [],
    tags: [],
    importedFrom: null,
    category: null,
    ...overrides,
  };
}

function entry(overrides: Partial<CatalogueEntry> = {}): CatalogueEntry {
  const built = manifest();
  return {
    skillId: asIdentifier<SkillId>("skill-1"),
    identity: skillIdentity(ORG, built.id, built.version),
    name: built.name,
    description: built.description,
    author: null,
    origin: "custom",
    isOfficial: false,
    tags: [],
    source: "src",
    manifest: built,
    promptBlock: "p",
    providesTools: [],
    requiredEnvironmentKeys: [],
    optionalEnvironmentKeys: [],
    createdAt: new Date("2026-01-01T00:00:00.000Z"),
    updatedAt: new Date("2026-01-01T00:00:00.000Z"),
    ...overrides,
  };
}

describe("skillIdentity", () => {
  it("renders a stable path from organization, slug and version", () => {
    expect(skillIdentityPath(skillIdentity(ORG, asIdentifier("a.b"), asIdentifier("1.0.0")))).toBe(
      "org/org-1/skill/a.b@1.0.0",
    );
  });

  it("treats the same triple as the same identity", () => {
    const left = skillIdentity(ORG, asIdentifier("a.b"), asIdentifier("1.0.0"));
    const right = skillIdentity(ORG, asIdentifier("a.b"), asIdentifier("1.0.0"));
    expect(sameSkillIdentity(left, right)).toBe(true);
  });

  it("SEPARATES the same slug and version in two organizations", () => {
    const mine = skillIdentity(ORG, asIdentifier("a.b"), asIdentifier("1.0.0"));
    const theirs = skillIdentity(OTHER_ORG, asIdentifier("a.b"), asIdentifier("1.0.0"));
    expect(sameSkillIdentity(mine, theirs)).toBe(false);
  });

  it("SEPARATES two versions of one slug", () => {
    const first = skillIdentity(ORG, asIdentifier("a.b"), asIdentifier("1.0.0"));
    const second = skillIdentity(ORG, asIdentifier("a.b"), asIdentifier("2.0.0"));
    expect(sameSkillIdentity(first, second)).toBe(false);
  });
});

describe("resolveOrigin", () => {
  it("defaults to custom when neither the manifest nor the caller says", () => {
    expect(resolveOrigin(manifest())).toEqual({ origin: "custom", isOfficial: false });
  });

  it("takes the manifest's declaration when the caller does not override", () => {
    expect(resolveOrigin(manifest({ origin: "community" }))).toEqual({
      origin: "community",
      isOfficial: false,
    });
  });

  it("lets an explicit override BEAT a manifest claiming to be official", () => {
    // This is the privilege boundary: a fetched document must not be able to
    // promote itself by declaring `origin: official`.
    expect(resolveOrigin(manifest({ origin: "official" }), { origin: "community" })).toEqual({
      origin: "community",
      isOfficial: false,
    });
  });

  it("marks a resolved official origin as official", () => {
    expect(resolveOrigin(manifest(), { origin: "official" })).toEqual({
      origin: "official",
      isOfficial: true,
    });
  });

  it("lets an explicit isOfficial override the origin-derived default", () => {
    expect(resolveOrigin(manifest(), { origin: "custom", isOfficial: true })).toEqual({
      origin: "custom",
      isOfficial: true,
    });
  });
});

describe("draftFrom / revisionFrom", () => {
  it("keys the draft by the manifest's own slug and version", () => {
    const draft = draftFrom(ORG, { manifest: manifest(), promptBlock: "p", source: "s" });
    expect(skillIdentityPath(draft.identity)).toBe("org/org-1/skill/a.b@1.0.0");
  });

  it("carries every manifest-derived column into a revision", () => {
    const built = manifest({
      name: "Renamed",
      tags: ["x"],
      required_env: [asIdentifier("K")],
      optional_env: [asIdentifier("O")],
    });
    const revision = revisionFrom(
      draftFrom(ORG, { manifest: built, promptBlock: "p", source: "s" }, { origin: "community" }),
    );
    expect(revision.name).toBe("Renamed");
    expect(revision.tags).toEqual(["x"]);
    expect(revision.requiredEnvironmentKeys).toEqual(["K"]);
    expect(revision.optionalEnvironmentKeys).toEqual(["O"]);
    expect(revision.origin).toBe("community");
  });
});

describe("applyPatch", () => {
  it("moves only the fields the patch names", () => {
    const patched = applyPatch(entry({ name: "Old", description: "Old d", tags: ["a"] }), {
      name: "New",
    });
    expect(patched.name).toBe("New");
    expect(patched.description).toBe("Old d");
    expect(patched.tags).toEqual(["a"]);
  });

  it("can clear tags to an empty list", () => {
    expect(applyPatch(entry({ tags: ["a"] }), { tags: [] }).tags).toEqual([]);
  });

  it("recognises a patch that names nothing", () => {
    expect(patchIsEmpty({})).toBe(true);
    expect(patchIsEmpty({ name: "x" })).toBe(false);
    expect(patchIsEmpty({ tags: [] })).toBe(false);
  });
});

describe("compareCatalogueEntries", () => {
  it("puts official rows first", () => {
    const official = entry({ skillId: asIdentifier<SkillId>("s2"), isOfficial: true });
    const custom = entry({ skillId: asIdentifier<SkillId>("s1"), isOfficial: false });
    expect([custom, official].sort(compareCatalogueEntries)[0]).toBe(official);
  });

  it("orders by slug ascending within the same officiality", () => {
    const a = entry({ skillId: asIdentifier<SkillId>("s1"), identity: skillIdentity(ORG, asIdentifier("a.a"), asIdentifier("1")) });
    const z = entry({ skillId: asIdentifier<SkillId>("s2"), identity: skillIdentity(ORG, asIdentifier("z.z"), asIdentifier("1")) });
    expect([z, a].sort(compareCatalogueEntries).map((row) => row.identity.slug)).toEqual(["a.a", "z.z"]);
  });

  it("orders by version DESCENDING within a slug, so the newest leads", () => {
    const older = entry({ skillId: asIdentifier<SkillId>("s1"), identity: skillIdentity(ORG, asIdentifier("a.b"), asIdentifier("1.0.0")) });
    const newer = entry({ skillId: asIdentifier<SkillId>("s2"), identity: skillIdentity(ORG, asIdentifier("a.b"), asIdentifier("2.0.0")) });
    expect([older, newer].sort(compareCatalogueEntries).map((row) => row.identity.version)).toEqual([
      "2.0.0",
      "1.0.0",
    ]);
  });

  it("breaks a full tie by row id, so paging cannot drop or repeat a row", () => {
    const first = entry({ skillId: asIdentifier<SkillId>("s1") });
    const second = entry({ skillId: asIdentifier<SkillId>("s2") });
    expect([second, first].sort(compareCatalogueEntries).map((row) => row.skillId)).toEqual(["s1", "s2"]);
  });

  it("is a total order — sorting twice gives the same sequence", () => {
    const rows = [
      entry({ skillId: asIdentifier<SkillId>("s3"), isOfficial: true }),
      entry({ skillId: asIdentifier<SkillId>("s1") }),
      entry({ skillId: asIdentifier<SkillId>("s2") }),
    ];
    const once = [...rows].sort(compareCatalogueEntries).map((row) => row.skillId);
    const twice = [...rows].reverse().sort(compareCatalogueEntries).map((row) => row.skillId);
    expect(once).toEqual(twice);
  });
});

describe("matchesSearch", () => {
  it("matches every row when there is no search", () => {
    expect(matchesSearch(entry(), null)).toBe(true);
    expect(matchesSearch(entry(), "   ")).toBe(true);
  });

  it("matches the name case-insensitively", () => {
    expect(matchesSearch(entry({ name: "Web Search" }), "web")).toBe(true);
    expect(matchesSearch(entry({ name: "Web Search" }), "WEB")).toBe(true);
  });

  it("matches the slug and the description too", () => {
    const row = entry({
      identity: skillIdentity(ORG, asIdentifier("acme.rag"), asIdentifier("1")),
      description: "Retrieval helper",
    });
    expect(matchesSearch(row, "acme")).toBe(true);
    expect(matchesSearch(row, "retrieval")).toBe(true);
  });

  it("REFUSES a row that matches nowhere", () => {
    expect(matchesSearch(entry({ name: "Web" }), "database")).toBe(false);
  });
});
