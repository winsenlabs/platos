import { describe, expect, it } from "vitest";

import {
  agentVisibleFor,
  ATOM_KINDS,
  isAtomKind,
  isMemoryArchiveState,
  isMemoryKind,
  isMemorySource,
  isMemoryVisibility,
  MEMORY_KINDS,
  MEMORY_SOURCES,
  MEMORY_VISIBILITIES,
  normalizeProfileKey,
  normalizeVisibility,
  RAG_SOURCE,
  requireMemoryKind,
  requireMemorySource,
  requireVisibilityFilter,
  RUNTIME_RECALL_FILTER,
  SYNTHESIZED_PROFILE_KEY,
  type MemoryVisibility,
} from "./taxonomy.js";

describe("the four closed vocabularies", () => {
  it("are exactly the values already in the store and on the wire", () => {
    expect(MEMORY_KINDS).toEqual(["fact", "preference", "event", "relationship", "profile"]);
    expect(MEMORY_VISIBILITIES).toEqual(["agent_visible", "hidden", "private"]);
    expect(MEMORY_SOURCES).toEqual(["manual", "extracted", "imported", "rag"]);
  });

  it("recognises its own members and nothing else", () => {
    expect(isMemoryKind("fact")).toBe(true);
    expect(isMemoryKind("Fact")).toBe(false);
    expect(isMemoryVisibility("agent_visible")).toBe(true);
    expect(isMemoryVisibility("visible")).toBe(false);
    expect(isMemorySource(RAG_SOURCE)).toBe(true);
    expect(isMemorySource(null)).toBe(false);
    expect(isMemoryArchiveState("all")).toBe(true);
    expect(isMemoryArchiveState("deleted")).toBe(false);
  });

  it("treats the four ATOM kinds as a subset that excludes `profile`", () => {
    expect(ATOM_KINDS).toEqual(["fact", "preference", "event", "relationship"]);
    expect(isAtomKind("profile")).toBe(false);
    expect(isAtomKind("relationship")).toBe(true);
  });
});

describe("requireMemoryKind", () => {
  it("defaults an absent kind to `fact`", () => {
    const kind = requireMemoryKind(null);
    expect(kind.ok).toBe(true);
    if (!kind.ok) throw new Error("unreachable");
    expect(kind.value).toBe("fact");
  });

  it("lower-cases before matching, so `Fact` and `fact` are ONE kind", () => {
    const kind = requireMemoryKind("PREFERENCE");
    expect(kind.ok).toBe(true);
    if (!kind.ok) throw new Error("unreachable");
    expect(kind.value).toBe("preference");
  });

  it("refuses an unknown kind and names the permitted set", () => {
    const kind = requireMemoryKind("opinion");
    expect(kind.ok).toBe(false);
    if (kind.ok) throw new Error("unreachable");
    expect(kind.error.code).toBe("MEMORY_INVALID_KIND");
    expect(kind.error.message).toContain("relationship");
  });
});

describe("requireMemorySource", () => {
  it("accepts each canonical source", () => {
    for (const source of MEMORY_SOURCES) expect(requireMemorySource(source).ok).toBe(true);
  });

  it("refuses anything else with the source's own error code", () => {
    const source = requireMemorySource("inferred");
    expect(source.ok).toBe(false);
    if (source.ok) throw new Error("unreachable");
    expect(source.error.code).toBe("MEMORY_INVALID_SOURCE");
  });
});

describe("normalizeVisibility — the one derivation between the two columns", () => {
  it("lets an explicit visibility win over the legacy boolean", () => {
    const resolved = normalizeVisibility("private", true);
    expect(resolved.ok).toBe(true);
    if (!resolved.ok) throw new Error("unreachable");
    expect(resolved.value).toBe("private");
  });

  it("reads `false` as `hidden` when no visibility was stated", () => {
    const resolved = normalizeVisibility(undefined, false);
    expect(resolved.ok).toBe(true);
    if (!resolved.ok) throw new Error("unreachable");
    expect(resolved.value).toBe("hidden");
  });

  it("NEVER produces `private` from the boolean alone", () => {
    for (const legacy of [true, false, undefined]) {
      const resolved = normalizeVisibility(undefined, legacy);
      expect(resolved.ok).toBe(true);
      if (!resolved.ok) throw new Error("unreachable");
      expect(resolved.value).not.toBe("private");
    }
  });

  it("defaults to `agent_visible` when neither field speaks", () => {
    const resolved = normalizeVisibility(undefined, undefined);
    expect(resolved.ok).toBe(true);
    if (!resolved.ok) throw new Error("unreachable");
    expect(resolved.value).toBe("agent_visible");
  });

  it("refuses an explicit value outside the vocabulary", () => {
    const resolved = normalizeVisibility("public", undefined);
    expect(resolved.ok).toBe(false);
    if (resolved.ok) throw new Error("unreachable");
    expect(resolved.error.code).toBe("MEMORY_INVALID_VISIBILITY");
  });

  it("derives the boolean column rather than storing a second fact", () => {
    expect(agentVisibleFor("agent_visible")).toBe(true);
    expect(agentVisibleFor("hidden")).toBe(false);
    expect(agentVisibleFor("private")).toBe(false);
  });
});

describe("requireVisibilityFilter", () => {
  it("reads an ABSENT filter as runtime recall — agent-visible only", () => {
    const filter = requireVisibilityFilter(undefined);
    expect(filter.ok).toBe(true);
    if (!filter.ok) throw new Error("unreachable");
    expect(filter.value).toBe(RUNTIME_RECALL_FILTER);
    expect(filter.value.visibilities).toEqual(["agent_visible"]);
  });

  it("REFUSES an empty list rather than reading it as `no filter`", () => {
    const filter = requireVisibilityFilter([]);
    expect(filter.ok).toBe(false);
    if (filter.ok) throw new Error("unreachable");
    expect(filter.error.code).toBe("MEMORY_INVALID_VISIBILITY");
  });

  it("de-duplicates an explicit list and marks it explicit", () => {
    const filter = requireVisibilityFilter(["hidden", "hidden", "private"]);
    expect(filter.ok).toBe(true);
    if (!filter.ok) throw new Error("unreachable");
    expect(filter.value.kind).toBe("explicit");
    expect(filter.value.visibilities).toEqual(["hidden", "private"]);
  });

  it("refuses a list carrying a value outside the vocabulary", () => {
    expect(requireVisibilityFilter(["hidden", "public" as MemoryVisibility]).ok).toBe(false);
  });
});

describe("normalizeProfileKey", () => {
  it("trims and lower-cases", () => {
    expect(normalizeProfileKey("  Preferred Name  ")).toBe("preferred name");
  });

  it("lower-cases in an EXPLICIT locale, so a dotted capital I keeps its dot", () => {
    // Under a Turkish host locale `toLowerCase()` maps I to a DOTLESS i, which
    // would give a key that no longer collides with the row it must upsert.
    expect(normalizeProfileKey("TITLE")).toBe("title");
    expect(normalizeProfileKey("TITLE")).not.toBe("tıtle");
  });

  it("reserves the synthesized narrative's key under a leading underscore", () => {
    expect(SYNTHESIZED_PROFILE_KEY).toBe("_synthesized");
  });
});
