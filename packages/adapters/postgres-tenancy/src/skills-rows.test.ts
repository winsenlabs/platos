// The row readers and the write guards, unit-tested — the branches a container
// suite cannot reach.
//
// WHY THIS SUITE EXISTS BESIDE THE INTEGRATION ONES. A container only ever holds
// rows THIS BINARY WROTE, so every branch in `skills-rows.ts` that exists for a
// row an older release wrote is unreachable from it except through the handful
// the rules suite plants as raw SQL. This suite reaches all of them directly, at
// no container cost, and it is the one `pnpm test` runs by default — the
// integration files are excluded by the package's own `test` script by filename
// and run by the `postgres-tenancy-repository` CI job.
//
// AND IT IS WHERE THE DISTINCTNESS OF THE CODES IS ASSERTED. Two guards sharing
// one code cannot be told apart in a log, whatever else a suite proves about
// them, so the full set is compared against itself here rather than left to be
// noticed.

import { describe, expect, test } from "vitest";

import type { SkillManifest } from "@platos/context-skills/application/ports/index.js";

import {
  CONFIG_NOT_OBJECT,
  IDENTIFIER_NOT_UUID,
  IDENTITY_SEGMENT_EMPTY,
  INSTANT_NOT_REPRESENTABLE,
  MANIFEST_NOT_OBJECT,
  PROVIDED_TOOLS_NOT_ARRAY,
  SCOPE_ANCESTRY_INCOHERENT,
  SkillsWriteRefused,
  TEXT_LIST_INVALID,
  looksLikeUuid,
  requireCoherentScope,
  requireIdentitySegment,
  requireInstant,
  requireJsonArray,
  requireJsonObject,
  requireTextList,
  requireUuid,
} from "./skills-guards.js";
import {
  UNKNOWN_SKILL_ORIGIN,
  UNREADABLE_INSTALL_CONFIG,
  UNREADABLE_MANIFEST,
  UNREADABLE_PROVIDED_TOOLS,
  UNREADABLE_TEXT_LIST,
  UnreadableSkillsRowError,
  readInstallConfig,
  readManifest,
  readProvidedTools,
  readSkillOrigin,
  readTextList,
} from "./skills-rows.js";
import { createSkillsStamps } from "./skills-repository.js";

const ORGANIZATION = "bbbbbbbb-0001-4000-8000-000000000001";
const PROJECT = "bbbbbbbb-0002-4000-8000-000000000001";
const ENVIRONMENT = "bbbbbbbb-0003-4000-8000-000000000001";

function codeOfThrow(work: () => unknown): string {
  try {
    work();
  } catch (error) {
    if (error instanceof SkillsWriteRefused) return error.code;
    if (error instanceof UnreadableSkillsRowError) return error.code;
    return `<unexpected:${String(error)}>`;
  }
  return "<no throw>";
}

describe("every refusal code this store can answer with is DISTINCT", () => {
  test("the eight write codes and the five row codes are thirteen strings", () => {
    const codes = [
      IDENTIFIER_NOT_UUID,
      MANIFEST_NOT_OBJECT,
      PROVIDED_TOOLS_NOT_ARRAY,
      CONFIG_NOT_OBJECT,
      TEXT_LIST_INVALID,
      IDENTITY_SEGMENT_EMPTY,
      INSTANT_NOT_REPRESENTABLE,
      SCOPE_ANCESTRY_INCOHERENT,
      UNKNOWN_SKILL_ORIGIN,
      UNREADABLE_MANIFEST,
      UNREADABLE_PROVIDED_TOOLS,
      UNREADABLE_INSTALL_CONFIG,
      UNREADABLE_TEXT_LIST,
    ];
    expect(new Set(codes).size).toBe(codes.length);
    // And every one of them names its own half, so an operator reading one knows
    // whether a write was refused or a stored row could not be read.
    expect(codes.filter((code) => code.startsWith("skills.write.")).length).toBe(8);
    expect(codes.filter((code) => code.startsWith("skills.row.")).length).toBe(5);
  });
});

describe("the uuid guard is the canonical hyphenated form and nothing else", () => {
  test("what it accepts and what it does not", () => {
    expect(looksLikeUuid("bbbbbbbb-0001-4000-8000-000000000001")).toBe(true);
    expect(looksLikeUuid("BBBBBBBB-0001-4000-8000-000000000001")).toBe(true);
    // The two spellings `uuid_in` ALSO accepts and this store never mints. Not
    // admitting them keeps the guard falsifiable.
    expect(looksLikeUuid("{bbbbbbbb-0001-4000-8000-000000000001}")).toBe(false);
    expect(looksLikeUuid("bbbbbbbb00014000800 0000000000001".replace(/ /gu, ""))).toBe(false);
    // The shapes the context's own doubles mint.
    expect(looksLikeUuid("org-1")).toBe(false);
    expect(looksLikeUuid("id-0001")).toBe(false);
    expect(looksLikeUuid("acme.search")).toBe(false);
  });

  test("requireUuid refuses under its own code and names the field", () => {
    expect(codeOfThrow(() => requireUuid("Skill.organizationId", "org-1"))).toBe(IDENTIFIER_NOT_UUID);
    expect(() => requireUuid("Skill.organizationId", ORGANIZATION)).not.toThrow();
  });
});

describe("a scope naming one identifier at two levels is refused", () => {
  test("because the trigger reads the stored rows and not the caller's claim", () => {
    expect(() => requireCoherentScope(ORGANIZATION, PROJECT, ENVIRONMENT)).not.toThrow();
    expect(codeOfThrow(() => requireCoherentScope(ORGANIZATION, ORGANIZATION, ENVIRONMENT))).toBe(
      SCOPE_ANCESTRY_INCOHERENT,
    );
    expect(codeOfThrow(() => requireCoherentScope(ORGANIZATION, PROJECT, PROJECT))).toBe(
      SCOPE_ANCESTRY_INCOHERENT,
    );
    expect(codeOfThrow(() => requireCoherentScope(ORGANIZATION, PROJECT, "not-a-uuid"))).toBe(
      IDENTIFIER_NOT_UUID,
    );
  });
});

describe("the three JSON-root CHECKs, refused before a statement is sent", () => {
  test("an object column, an array column and a config column", () => {
    expect(codeOfThrow(() => requireJsonObject(MANIFEST_NOT_OBJECT, "Skill.manifest", []))).toBe(
      MANIFEST_NOT_OBJECT,
    );
    expect(codeOfThrow(() => requireJsonObject(MANIFEST_NOT_OBJECT, "Skill.manifest", null))).toBe(
      MANIFEST_NOT_OBJECT,
    );
    expect(codeOfThrow(() => requireJsonObject(MANIFEST_NOT_OBJECT, "Skill.manifest", "text"))).toBe(
      MANIFEST_NOT_OBJECT,
    );
    expect(() => requireJsonObject(MANIFEST_NOT_OBJECT, "Skill.manifest", { id: "x" })).not.toThrow();

    expect(codeOfThrow(() => requireJsonArray(PROVIDED_TOOLS_NOT_ARRAY, "Skill.providesTools", {}))).toBe(
      PROVIDED_TOOLS_NOT_ARRAY,
    );
    expect(() => requireJsonArray(PROVIDED_TOOLS_NOT_ARRAY, "Skill.providesTools", [])).not.toThrow();

    expect(codeOfThrow(() => requireJsonObject(CONFIG_NOT_OBJECT, "EnvironmentSkill.config", []))).toBe(
      CONFIG_NOT_OBJECT,
    );
  });
});

describe("the TEXT[] columns", () => {
  test("a write refuses anything that is not a list of text", () => {
    expect(requireTextList("Skill.tags", ["a", "b"])).toEqual(["a", "b"]);
    expect(codeOfThrow(() => requireTextList("Skill.tags", null))).toBe(TEXT_LIST_INVALID);
    expect(codeOfThrow(() => requireTextList("Skill.tags", [1]))).toBe(TEXT_LIST_INVALID);
    expect(codeOfThrow(() => requireTextList("Skill.tags", "a"))).toBe(TEXT_LIST_INVALID);
  });

  test("a READ answers the empty list the column DEFAULT names for SQL NULL", () => {
    // The column is nullable in the DDL and non-optional in `schema.prisma`, so
    // a row holding NULL is representable and the generated types deny it.
    expect(readTextList("Skill.tags", null)).toEqual([]);
    expect(readTextList("Skill.tags", undefined)).toEqual([]);
    expect(readTextList("Skill.tags", ["a"])).toEqual(["a"]);
    expect(codeOfThrow(() => readTextList("Skill.tags", [1]))).toBe(UNREADABLE_TEXT_LIST);
    expect(codeOfThrow(() => readTextList("Skill.tags", "a"))).toBe(UNREADABLE_TEXT_LIST);
  });
});

describe("Skill.origin is validated against the closed set, not cast to it", () => {
  test("the three values, and one that is not", () => {
    expect(readSkillOrigin("official")).toBe("official");
    expect(readSkillOrigin("community")).toBe("community");
    expect(readSkillOrigin("custom")).toBe("custom");
    expect(codeOfThrow(() => readSkillOrigin("invented"))).toBe(UNKNOWN_SKILL_ORIGIN);
    expect(codeOfThrow(() => readSkillOrigin(""))).toBe(UNKNOWN_SKILL_ORIGIN);
  });
});

describe("Skill.manifest reads what an older binary wrote and refuses what is corrupt", () => {
  const complete = {
    id: "acme.search",
    name: "search",
    description: "searches",
    version: "1.0.0",
    author: "subject-a",
    origin: "custom",
    spec_version: "1",
    required_env: ["KEY"],
    optional_env: [],
    provides_tools: [{ name: "run", description: "d", inputSchema: null, outputSchema: null, handler: "job:x" }],
    tags: ["search"],
    importedFrom: null,
    category: "research",
  };

  test("a complete manifest round-trips unchanged", () => {
    expect(readManifest(complete)).toEqual(complete);
  });

  test("every ABSENT nullable key normalises, and every absent list becomes empty", () => {
    expect(
      readManifest({ id: "a.b", name: "n", description: "d", version: "1" }),
    ).toEqual({
      id: "a.b",
      name: "n",
      description: "d",
      version: "1",
      author: null,
      origin: null,
      spec_version: null,
      required_env: [],
      optional_env: [],
      provides_tools: [],
      tags: [],
      importedFrom: null,
      category: null,
    });
  });

  test("an UNKNOWN key survives, so a newer release's field is not deleted", () => {
    const read = readManifest({ ...complete, future_field: { kept: true } }) as unknown as Record<string, unknown>;
    expect(read["future_field"]).toEqual({ kept: true });
  });

  test("a missing REQUIRED key, a wrong-typed nullable key and a bad root are refused", () => {
    expect(codeOfThrow(() => readManifest({ name: "n" }))).toBe(UNREADABLE_MANIFEST);
    expect(codeOfThrow(() => readManifest({ ...complete, author: 7 }))).toBe(UNREADABLE_MANIFEST);
    expect(codeOfThrow(() => readManifest({ ...complete, origin: "invented" }))).toBe(UNREADABLE_MANIFEST);
    expect(codeOfThrow(() => readManifest({ ...complete, required_env: "KEY" }))).toBe(UNREADABLE_MANIFEST);
    expect(codeOfThrow(() => readManifest({ ...complete, required_env: [1] }))).toBe(UNREADABLE_MANIFEST);
    expect(codeOfThrow(() => readManifest({ ...complete, provides_tools: {} }))).toBe(UNREADABLE_MANIFEST);
    expect(codeOfThrow(() => readManifest([]))).toBe(UNREADABLE_MANIFEST);
    expect(codeOfThrow(() => readManifest(null))).toBe(UNREADABLE_MANIFEST);
  });
});

describe("Skill.providesTools is the column the runtime reads", () => {
  test("optional fields default and unknown fields survive", () => {
    expect(readProvidedTools([{ name: "run", extra: 1 }])).toEqual([
      { name: "run", extra: 1, description: "", inputSchema: null, outputSchema: null, handler: null },
    ]);
  });

  test("a bad root, a bad element and a nameless element are refused", () => {
    expect(codeOfThrow(() => readProvidedTools({}))).toBe(UNREADABLE_PROVIDED_TOOLS);
    expect(codeOfThrow(() => readProvidedTools([3]))).toBe(UNREADABLE_PROVIDED_TOOLS);
    expect(codeOfThrow(() => readProvidedTools([{ description: "no name" }]))).toBe(
      UNREADABLE_PROVIDED_TOOLS,
    );
    expect(codeOfThrow(() => readProvidedTools([{ name: "run", handler: 7 }]))).toBe(
      UNREADABLE_PROVIDED_TOOLS,
    );
    expect(codeOfThrow(() => readProvidedTools([{ name: "run", inputSchema: [] }]))).toBe(
      UNREADABLE_PROVIDED_TOOLS,
    );
  });
});

describe("EnvironmentSkill.config", () => {
  test("an absent config is the empty object the column DEFAULT names", () => {
    expect(readInstallConfig(null)).toEqual({});
    expect(readInstallConfig({ region: "eu" })).toEqual({ region: "eu" });
    expect(codeOfThrow(() => readInstallConfig([]))).toBe(UNREADABLE_INSTALL_CONFIG);
    expect(codeOfThrow(() => readInstallConfig("text"))).toBe(UNREADABLE_INSTALL_CONFIG);
  });
});

describe("the remaining two write guards", () => {
  test("an empty segment of the uniqueness key, and an unrepresentable instant", () => {
    expect(() => requireIdentitySegment("Skill.slug", "acme.search")).not.toThrow();
    expect(codeOfThrow(() => requireIdentitySegment("Skill.version", ""))).toBe(IDENTITY_SEGMENT_EMPTY);
    expect(requireInstant("Skill.updatedAt", new Date(0)).getTime()).toBe(0);
    expect(codeOfThrow(() => requireInstant("Skill.updatedAt", new Date("nonsense")))).toBe(
      INSTANT_NOT_REPRESENTABLE,
    );
  });
});

describe("the default stamps mint what the columns will hold", () => {
  test("the instant source never repeats, so two rows in ONE transaction can be ordered", () => {
    // `createdAt` and `updatedAt` are `timestamp(3)`, so two rows written in the
    // same millisecond TIE — and `now()` would be worse, because on PostgreSQL
    // it is the TRANSACTION'S start time and every row a seeding run wrote in
    // one unit of work would carry the identical instant.
    //
    // A THOUSAND READINGS, not two. Two readings a millisecond apart pass
    // against a source with no monotonicity in it at all; a thousand cannot,
    // because a thousand calls to `Date.now()` do not span a thousand
    // milliseconds.
    const stamps = createSkillsStamps();
    let previous = 0;
    for (let index = 0; index < 1000; index += 1) {
      const instant = stamps.now().getTime();
      expect(instant).toBeGreaterThan(previous);
      previous = instant;
    }
  });

  test("every minted identifier is a uuid the column accepts", () => {
    // All three primary keys are `@db.Uuid`. A source that minted anything else
    // would be refused by the database on the first insert — and by the guard
    // one line earlier, which is why this is asserted rather than assumed.
    const stamps = createSkillsStamps();
    const minted = [stamps.skillId(), stamps.projectSkillId(), stamps.environmentSkillId()];
    for (const id of minted) expect(looksLikeUuid(id)).toBe(true);
    expect(new Set(minted).size).toBe(3);
  });
});

describe("a manifest this store WROTE reads back as the same value", () => {
  test("the round trip, on the exact shape `revisionFrom` produces", () => {
    // The half that keeps the reader honest about the writer: a validator that
    // normalised a field the writer had set would make a re-registration a
    // silent edit.
    const manifest: SkillManifest = readManifest({
      id: "acme.round",
      name: "round",
      description: "trips",
      version: "2.0.0",
      author: null,
      origin: "official",
      spec_version: null,
      required_env: ["A", "B"],
      optional_env: ["C"],
      provides_tools: [
        { name: "t", description: "", inputSchema: { type: "object" }, outputSchema: null, handler: null },
      ],
      tags: [],
      importedFrom: "https://example.test/skill.md",
      category: null,
    });
    expect(readManifest(manifest)).toEqual(manifest);
  });
});
